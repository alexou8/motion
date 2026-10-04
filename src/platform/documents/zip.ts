import { Inflate } from 'fflate';
import { DocumentParseError, validateDocumentBytes } from '@/core/documents/contracts';

const ZIP_LIMITS = {
  entries: 4096,
  inflatedBytes: 100 * 1024 * 1024,
  xmlBytes: 2 * 1024 * 1024,
  ratio: 200,
} as const;
interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  original: number;
  crc: number;
  start: number;
}

function invalid(): never {
  throw new DocumentParseError('This slide archive is corrupt or exceeds safe parsing limits.');
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * fflate supplies the streaming DEFLATE decoder needed for compressed PPTX
 * parts. Archive metadata and output budgets stay under Motion's control.
 * No archive member is written to disk; only bounded, selected XML is inflated.
 */
export class SlideArchive {
  private readonly entries = new Map<string, ZipEntry>();
  private extractedBytes = 0;

  constructor(private readonly bytes: Uint8Array) {
    validateDocumentBytes(bytes);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (position: number) => view.getUint16(position, true);
    const u32 = (position: number) => view.getUint32(position, true);
    let end = -1;
    for (
      let position = bytes.length - 22;
      position >= Math.max(0, bytes.length - 65_557);
      position--
    ) {
      if (u32(position) === 0x06054b50 && position + 22 + u16(position + 20) === bytes.length) {
        end = position;
        break;
      }
    }
    if (end < 0 || u16(end + 4) !== 0 || u16(end + 6) !== 0) invalid();
    const count = u16(end + 10);
    const directorySize = u32(end + 12);
    const directory = u32(end + 16);
    if (
      count < 1 ||
      count > ZIP_LIMITS.entries ||
      count !== u16(end + 8) ||
      directory + directorySize !== end
    )
      invalid();
    let position = directory;
    let totalInflated = 0;
    const ranges: [number, number][] = [];
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      for (let index = 0; index < count; index++) {
        if (position + 46 > end || u32(position) !== 0x02014b50) invalid();
        const flags = u16(position + 8);
        const method = u16(position + 10);
        const crc = u32(position + 16);
        const compressed = u32(position + 20);
        const original = u32(position + 24);
        const nameLength = u16(position + 28);
        const extraLength = u16(position + 30);
        const commentLength = u16(position + 32);
        const offset = u32(position + 42);
        const next = position + 46 + nameLength + extraLength + commentLength;
        if (
          next > end ||
          !nameLength ||
          nameLength > 512 ||
          flags & 0x0041 ||
          u16(position + 34) !== 0 ||
          compressed === 0xffffffff ||
          original === 0xffffffff ||
          offset === 0xffffffff ||
          offset + 30 > directory
        )
          invalid();
        const name = decoder.decode(bytes.subarray(position + 46, position + 46 + nameLength));
        if (
          name.startsWith('/') ||
          name.includes('\\') ||
          name.includes(':') ||
          name.includes('\0') ||
          name
            .split('/')
            .some(
              (segment, i, all) =>
                segment === '..' || segment === '.' || (!segment && i < all.length - 1),
            ) ||
          this.entries.has(name)
        )
          invalid();
        if (u32(offset) !== 0x04034b50 || u16(offset + 6) !== flags || u16(offset + 8) !== method)
          invalid();
        const localNameLength = u16(offset + 26);
        const start = offset + 30 + localNameLength + u16(offset + 28);
        if (
          start + compressed > directory ||
          localNameLength !== nameLength ||
          decoder.decode(bytes.subarray(offset + 30, offset + 30 + localNameLength)) !== name
        )
          invalid();
        if (
          !(flags & 8) &&
          (u32(offset + 14) !== crc ||
            u32(offset + 18) !== compressed ||
            u32(offset + 22) !== original)
        )
          invalid();
        if (
          original > ZIP_LIMITS.inflatedBytes ||
          original > Math.max(compressed, 1) * ZIP_LIMITS.ratio
        )
          invalid();
        totalInflated += original;
        if (totalInflated > ZIP_LIMITS.inflatedBytes) invalid();
        this.entries.set(name, { name, method, compressed, original, crc, start });
        ranges.push([offset, start + compressed]);
        position = next;
      }
      if (position !== end) invalid();
      ranges.sort((a, b) => a[0] - b[0]);
      for (let index = 1; index < ranges.length; index++)
        if (ranges[index]![0] < ranges[index - 1]![1]) invalid();
    } catch {
      invalid();
    }
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  readXml(name: string): string {
    const entry = this.entries.get(name);
    if (
      !entry ||
      (!name.endsWith('.xml') && !name.endsWith('.rels')) ||
      entry.original > ZIP_LIMITS.xmlBytes ||
      this.extractedBytes + entry.original > 20 * 1024 * 1024
    )
      invalid();
    const chunks: Uint8Array[] = [];
    let actual = 0;
    const collect = (chunk: Uint8Array) => {
      actual += chunk.length;
      if (
        actual > entry.original ||
        actual > ZIP_LIMITS.xmlBytes ||
        actual > Math.max(entry.compressed, 1) * ZIP_LIMITS.ratio
      )
        invalid();
      chunks.push(chunk);
    };
    try {
      if (entry.method === 0) {
        if (entry.compressed !== entry.original) invalid();
        collect(this.bytes.subarray(entry.start, entry.start + entry.compressed));
      } else if (entry.method === 8) {
        // Small compressed chunks bound each inflater output allocation before
        // the callback can reject dishonest central-directory size claims.
        const inflater = new Inflate(collect);
        for (let offset = 0; offset < entry.compressed; offset += 1024) {
          const end = Math.min(offset + 1024, entry.compressed);
          inflater.push(
            this.bytes.subarray(entry.start + offset, entry.start + end),
            end === entry.compressed,
          );
        }
        if (entry.compressed === 0) invalid();
      } else invalid();
      if (actual !== entry.original) invalid();
      const inflated = new Uint8Array(actual);
      let offset = 0;
      for (const chunk of chunks) {
        inflated.set(chunk, offset);
        offset += chunk.length;
      }
      if (crc32(inflated) !== entry.crc) invalid();
      this.extractedBytes += actual;
      return new TextDecoder('utf-8', { fatal: true }).decode(inflated);
    } catch {
      invalid();
    }
  }
}
