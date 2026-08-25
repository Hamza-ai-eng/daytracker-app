// Generates the PWA icons. Zero dependencies — Node's zlib and a hand-rolled PNG
// writer. Kept in the repo so the icons can always be regenerated without installing
// anything, in line with the no-toolchain rule.
//
//   node tools/make-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

const BG = [20, 18, 16];      // --bg
const CELL = [38, 34, 32];    // --panel2
const MARK = [200, 80, 60];   // --accent

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 2;  // truecolour RGB
  const raw = Buffer.alloc(size * (size * 3 + 1));
  let o = 0;
  for (let y = 0; y < size; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < size; x++) {
      const p = pixels(x, y);
      raw[o++] = p[0];
      raw[o++] = p[1];
      raw[o++] = p[2];
    }
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// A 4x4 month grid with a few days filled in — the app's own visual language.
const FILLED = new Set(['0,1', '1,0', '1,2', '2,1', '2,2', '3,0']);

function make(size, maskable) {
  const pad = Math.round(size * (maskable ? 0.26 : 0.16));
  const inner = size - pad * 2;
  const gap = Math.max(1, Math.round(inner * 0.055));
  const cell = (inner - gap * 3) / 4;

  return png(size, (x, y) => {
    const gx = x - pad;
    const gy = y - pad;
    if (gx < 0 || gy < 0 || gx >= inner || gy >= inner) return BG;
    const col = Math.floor(gx / (cell + gap));
    const row = Math.floor(gy / (cell + gap));
    if (col > 3 || row > 3) return BG;
    const ox = gx - col * (cell + gap);
    const oy = gy - row * (cell + gap);
    if (ox >= cell || oy >= cell) return BG;
    return FILLED.has(col + ',' + row) ? MARK : CELL;
  });
}

const targets = [
  ['icon-192.png', 192, false],
  ['icon-512.png', 512, false],
  ['icon-maskable-512.png', 512, true],
];

for (const [name, size, maskable] of targets) {
  const buf = make(size, maskable);
  writeFileSync(join(OUT, name), buf);
  console.log(name, size + 'x' + size, buf.length + ' bytes');
}
