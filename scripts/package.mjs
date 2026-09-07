/**
 * Packages dist/ into a zip you can unzip and load in Chrome.
 *
 *   npm run build && npm run package
 *
 * Written against Node's zlib rather than shelling out to `zip` or adding an
 * archiver dependency: `zip` is absent on a default Windows install, and this
 * has to work wherever a student happens to be.
 *
 * Output: motion-extension-<version>.zip in the repo root.
 */
import { deflateRawSync } from 'node:zlib';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const DIST = 'dist';
const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const outputName = `motion-extension-${version}.zip`;

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

function walk(dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) entries.push(...walk(full));
    else entries.push(full);
  }
  return entries;
}

/** DOS timestamps are what the format takes; the value itself is not meaningful. */
function dosTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function build() {
  let files;
  try {
    files = walk(DIST);
  } catch {
    console.error(`No ${DIST}/ directory. Run "npm run build" first.`);
    process.exit(1);
  }

  if (!files.some((file) => relative(DIST, file) === 'manifest.json')) {
    console.error(`${DIST}/manifest.json is missing — the build did not produce an extension.`);
    process.exit(1);
  }

  const now = new Date();
  const { time, day } = dosTime(now);
  const locals = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    // Zip entries always use forward slashes, whatever the host platform uses.
    const name = relative(DIST, file).split(sep).join('/');
    const nameBytes = Buffer.from(name, 'utf8');
    const contents = readFileSync(file);
    const deflated = deflateRawSync(contents, { level: 9 });
    // Storing is smaller than deflating for already-compressed data (png, woff2).
    const useDeflate = deflated.length < contents.length;
    const payload = useDeflate ? deflated : contents;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(contents);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(day, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(contents.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);

    locals.push(localHeader, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(day, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(contents.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    central.push(centralHeader, nameBytes);
    offset += localHeader.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  const zip = Buffer.concat([...locals, centralBuffer, end]);
  writeFileSync(outputName, zip);

  const kb = (zip.length / 1024).toFixed(1);
  console.log(`${outputName}  (${files.length} files, ${kb} kB)`);
  console.log('Unzip it, then load the folder at chrome://extensions with "Load unpacked".');
}

build();
