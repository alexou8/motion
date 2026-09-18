/**
 * Generates Motion's icon PNGs from assets/brand/motion-mark.svg's geometry.
 * Committed as a script so the icons are reproducible rather than opaque
 * binaries nobody can regenerate. The browser mark uses currentColor; icons
 * use the fixed signal color on transparent pixels.
 *
 *   node scripts/make-icons.mjs
 */
import zlib from 'node:zlib';
import fs from 'node:fs';

const svg = fs.readFileSync('src/assets/brand/motion-mark.svg', 'utf8');
const attr = (tag, name) => tag.match(new RegExp(`${name}="([^"]+)"`))?.[1];
const rootTag = svg.match(/<svg\b[^>]*>/)?.[0] ?? '';
const hex = (value) => {
  const match = value.match(/^#([0-9a-f]{6})$/i);
  if (!match) throw new Error(`Expected six-digit color in canonical mark: ${value}`);
  return [...match[1].matchAll(/../g)].map(([pair]) => parseInt(pair, 16)).concat(0xff);
};
const INK = hex(attr(rootTag, 'data-track') ?? '');
const SIGNAL = hex(attr(rootTag, 'data-signal') ?? '');
const pathTag = svg.match(/<path\b[^>]*>/)?.[0] ?? '';
const pathData = attr(pathTag, 'd')?.match(/^M([\d.]+) ([\d.]+)v([\d.]+)$/);
if (!pathData) throw new Error('Canonical mark path must be a vertical Mx yvheight path');
const pathX = Number(pathData[1]);
const pathTop = Number(pathData[2]);
const pathHeight = Number(pathData[3]);
const pathWidth = Number(attr(pathTag, 'stroke-width'));
const circles = [...svg.matchAll(/<circle\b[^>]*>/g)].map((match) => {
  const tag = match[0];
  return {
    cx: Number(attr(tag, 'cx')),
    cy: Number(attr(tag, 'cy')),
    r: Number(attr(tag, 'r')),
    strokeWidth: Number(attr(tag, 'stroke-width') ?? 0),
  };
});
if (circles.length !== 2 || circles.some((circle) => !Number.isFinite(circle.r))) {
  throw new Error('Canonical mark must contain two circles');
}

function render(size) {
  const buf = Buffer.alloc(size * size * 4);
  const set = (x, y, c, a = 1) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    // simple source-over so edges are not jagged at 16px
    const sa = (c[3] / 255) * a;
    buf[i] = Math.round(c[0] * sa + buf[i] * (1 - sa));
    buf[i + 1] = Math.round(c[1] * sa + buf[i + 1] * (1 - sa));
    buf[i + 2] = Math.round(c[2] * sa + buf[i + 2] * (1 - sa));
    buf[i + 3] = Math.round(255 * sa + buf[i + 3] * (1 - sa));
  };

  const scale = size / 20;
  const trackX = pathX * scale - (pathWidth * scale) / 2;
  const trackW = pathWidth * scale;
  const top = pathTop * scale;
  const bottom = (pathTop + pathHeight) * scale;
  for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
    for (let x = Math.floor(trackX); x < Math.ceil(trackX + trackW); x++) {
      const cov = Math.min(x + 1, trackX + trackW) - Math.max(x, trackX);
      if (cov > 0) set(x, y, INK, Math.min(1, cov));
    }
  }

  const drawCircle = ({ cx: sourceX, cy: sourceY, r: sourceR, strokeWidth = 0 }, color, ring) => {
    const cx = sourceX * scale;
    const cy = sourceY * scale;
    const r = sourceR * scale;
    const inner = ring ? Math.max(0, r - (strokeWidth * scale) / 2) : 0;
    for (let y = Math.floor(cy - r - 1); y <= Math.ceil(cy + r + 1); y++) {
      for (let x = Math.floor(cx - r - 1); x <= Math.ceil(cx + r + 1); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
        if (d < inner) continue;
        const cov = Math.max(0, Math.min(1, Math.min(r - d + 0.5, d - inner + 0.5)));
        if (cov > 0) set(x, y, SIGNAL, cov);
      }
    }
  };
  drawCircle(circles[0], SIGNAL, false);
  drawCircle(circles[1], SIGNAL, true);
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
