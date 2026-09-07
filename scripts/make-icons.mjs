/**
 * Generates Motion's icon PNGs from the "track" mark used throughout the UI:
 * a vertical rule with a marker sitting on it. Committed as a script so the
 * icons are reproducible rather than opaque binaries nobody can regenerate.
 *
 *   node scripts/make-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';

const INK = [0x16, 0x20, 0x2a, 0xff];
const SIGNAL = [0x24, 0x48, 0x7a, 0xff];

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, c, a = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // simple source-over so edges are not jagged at 16px
    const sa = c[3] / 255 * a;
    buf[i] = Math.round(c[0] * sa + buf[i] * (1 - sa));
    buf[i + 1] = Math.round(c[1] * sa + buf[i + 1] * (1 - sa));
    buf[i + 2] = Math.round(c[2] * sa + buf[i + 2] * (1 - sa));
    buf[i + 3] = Math.round(255 * sa + buf[i + 3] * (1 - sa));
  };

  const trackX = size * 0.3;
  const trackW = Math.max(1.2, size / 12);
  const top = size * 0.14;
  const bottom = size * 0.86;
  for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
    for (let x = Math.floor(trackX); x < Math.ceil(trackX + trackW); x++) {
      const cov =
        Math.min(x + 1, trackX + trackW) - Math.max(x, trackX);
      if (cov > 0) set(x, y, INK, Math.min(1, cov));
    }
  }

  // Marker: a disc clear of the track, with a gap between them so neither
  // shape reads as damaged by the other.
  const cx = size * 0.62;
  const cy = size * 0.5;
  const r = size * 0.2;
  for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
    for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const cov = Math.max(0, Math.min(1, r - d + 0.5));
      if (cov > 0) set(x, y, SIGNAL, cov);
    }
  }
  return buf;
}

function toPng(size, buf) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    buf.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

let table;
function crc32(buf) {
  if (!table) {
    table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
  }
  let c = 0xffffffff;
  for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

fs.mkdirSync('src/assets/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  fs.writeFileSync(`src/assets/icons/icon-${size}.png`, toPng(size, render(size)));
  console.log(`src/assets/icons/icon-${size}.png`);
}
