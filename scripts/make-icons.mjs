// Icon generator — renders assets/icon.svg's shapes to the raster formats
// Windows and Electron actually need, with no image dependencies.
//
// electron-builder wants a real multi-resolution .ico for the executable,
// the installer, and the Start Menu shortcut; an .svg is ignored, which is
// how the app ended up shipping the default Electron logo. Rather than add
// a rasterizer to devDependencies (and a native build step to CI), the
// handful of shapes in the source SVG are described once here and drawn
// directly. Regenerate with: npm run icons
//
// Keep SHAPES in sync with assets/icon.svg if the artwork changes.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VIEWBOX = 512;

const NAVY = [0x0b, 0x17, 0x28];
const MINT = [0x6e, 0xe7, 0xc2];
const GOLD = [0xf7, 0xc8, 0x73];

// Drawn in order, later shapes on top. Coordinates are in the 512 viewBox.
const SHAPES = [
  { kind: 'roundRect', x: 0, y: 0, w: 512, h: 512, r: 120, fill: NAVY },
  { kind: 'rect', x: 112, y: 154, w: 288, h: 58, fill: MINT },
  { kind: 'rect', x: 112, y: 252, w: 178, h: 58, fill: MINT },
  { kind: 'rect', x: 112, y: 350, w: 240, h: 58, fill: MINT },
  { kind: 'circle', cx: 376, cy: 281, r: 44, fill: GOLD },
];

function hits(shape, x, y) {
  if (shape.kind === 'rect') {
    return x >= shape.x && x < shape.x + shape.w && y >= shape.y && y < shape.y + shape.h;
  }
  if (shape.kind === 'circle') {
    const dx = x - shape.cx;
    const dy = y - shape.cy;
    return dx * dx + dy * dy <= shape.r * shape.r;
  }
  // Rounded rect: inside the box, and outside a corner only when the point
  // is past both corner axes and beyond the radius from the corner centre.
  const { x: rx, y: ry, w, h, r } = shape;
  if (x < rx || y < ry || x >= rx + w || y >= ry + h) return false;
  const cx = x < rx + r ? rx + r : x > rx + w - r ? rx + w - r : x;
  const cy = y < ry + r ? ry + r : y > ry + h - r ? ry + h - r : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

// Supersample and average in premultiplied alpha. Averaging straight RGBA
// against transparent pixels darkens every edge; premultiplying keeps the
// rounded corners clean.
function render(size, samples = 4) {
  const out = Buffer.alloc(size * size * 4);
  const step = VIEWBOX / (size * samples);
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < samples; sy += 1) {
        for (let sx = 0; sx < samples; sx += 1) {
          const x = (px * samples + sx + 0.5) * step;
          const y = (py * samples + sy + 0.5) * step;
          let fill = null;
          for (const shape of SHAPES) if (hits(shape, x, y)) fill = shape.fill;
          if (fill) { r += fill[0]; g += fill[1]; b += fill[2]; a += 255; }
        }
      }
      const total = samples * samples;
      const i = (py * size + px) * 4;
      if (a > 0) {
        const covered = a / 255;
        out[i] = Math.round(r / covered);
        out[i + 1] = Math.round(g / covered);
        out[i + 2] = Math.round(b / covered);
        out[i + 3] = Math.round(a / total);
      }
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(size, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  // Every scanline carries a leading filter byte; 0 means "no filter".
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0;
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Vista-era ICO: each entry may hold a whole PNG rather than a BMP, which is
// what every current Windows shell reads.
function encodeIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);
  const directory = Buffer.alloc(16 * entries.length);
  let offset = header.length + directory.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    directory[at] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 1] = entry.size >= 256 ? 0 : entry.size;
    directory[at + 2] = 0;
    directory[at + 3] = 0;
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.png.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.png.length;
  });
  return Buffer.concat([header, directory, ...entries.map(entry => entry.png)]);
}

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

mkdirSync(join(ROOT, 'build'), { recursive: true });
const entries = ICO_SIZES.map(size => ({ size, png: encodePng(size, render(size)) }));
writeFileSync(join(ROOT, 'build', 'icon.ico'), encodeIco(entries));
writeFileSync(join(ROOT, 'assets', 'icon.png'), encodePng(512, render(512)));
console.log(`build/icon.ico (${ICO_SIZES.join(', ')}) and assets/icon.png written`);
