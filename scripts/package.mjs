/** Package dist/ as a portable, reproducible ZIP without an archiver dependency. */
import { deflateRawSync } from 'node:zlib';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function extensionFiles(dist) {
  const directory = lstatSync(dist);
  if (directory.isSymbolicLink()) throw new Error(`Build contains a symbolic link: ${dist}`);
  if (!directory.isDirectory()) throw new Error(`Build path is not a directory: ${dist}`);
  const files = [];
  function walk(dir) {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      const entry = lstatSync(full);
      // A link could silently package a file outside the reviewed build.
      if (entry.isSymbolicLink()) throw new Error(`Build contains a symbolic link: ${full}`);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) files.push(full);
      else throw new Error(`Build contains a non-file entry: ${full}`);
    }
  }
  walk(dist);
  return files;
}

export function createExtensionArchive(dist) {
  const files = extensionFiles(dist);
  if (!files.some((file) => relative(dist, file) === 'manifest.json')) {
    throw new Error(`${dist}/manifest.json is missing. Run "npm run build" first.`);
  }
  if (files.length > 0xffff) throw new Error('Build exceeds the supported ZIP entry limit.');

  const locals = [];
  const central = [];
  let offset = 0;
  for (const file of files) {
    const name = relative(dist, file).split(sep).join('/');
    if (name.includes('\\') || /[\r\n\x00]/.test(name)) throw new Error(`Unsafe ZIP path: ${name}`);
    const nameBytes = Buffer.from(name, 'utf8');
    const contents = readFileSync(file);
    const deflated = deflateRawSync(contents, { level: 9 });
    const useDeflate = deflated.length < contents.length;
    const payload = useDeflate ? deflated : contents;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(contents);
    if (nameBytes.length > 0xffff || payload.length > 0xffffffff || contents.length > 0xffffffff) {
      throw new Error(`Build exceeds the supported ZIP size limit: ${name}`);
    }

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 names.
    localHeader.writeUInt16LE(method, 8);
    // Fixed 1980-01-01 DOS date; build time and timezone must not alter the ZIP.
    localHeader.writeUInt16LE(33, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    locals.push(localHeader, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(33, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + payload.length;
    if (offset > 0xffffffff) throw new Error('Build exceeds the supported ZIP size limit.');
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuffer, end]);
}

export function packageExtension(root = '.') {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error('package.json must contain a three-part release version.');
  }
  const outputName = `motion-extension-${version}.zip`;
  const zip = createExtensionArchive(join(root, 'dist'));
  writeFileSync(join(root, outputName), zip);
  return { outputName, bytes: zip.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = packageExtension();
    console.log(`${result.outputName} (${(result.bytes / 1024).toFixed(1)} kB)`);
    console.log('Unzip it, then load the folder at chrome://extensions with "Load unpacked".');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
