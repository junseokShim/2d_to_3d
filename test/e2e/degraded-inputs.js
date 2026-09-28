// Degraded low-light inputs for the assisted-fallback E2E: synthetic worn 4-flute end mill (test/wear/synth.js),
// darkened x0.2 with sensor noise (test/wear/degrade.js lowLight), written as PNG side1..4 + top (no npm deps).
// Usage: node test/e2e/degraded-inputs.js <out-dir>   or   require(...)(outDir) -> [file paths]
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const synth = require('../wear/synth.js'), Dg = require('../wear/degrade.js');

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = b => { let c = -1; for (const x of b) c = CRC[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function png({width: w, height: h, data}) {
  const raw = Buffer.alloc((4 * w + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (4 * w + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + 4 * w * y, 4 * w).copy(raw, y * (4 * w + 1) + 1); }
  const chunk = (t, d) => { const l = Buffer.alloc(4), c = Buffer.alloc(4), td = Buffer.concat([Buffer.from(t), d]); l.writeUInt32BE(d.length); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const DIA = 10, vb = z => .3 * (1 - .35 * z / 3);
function make(outDir) {
  fs.mkdirSync(outDir, {recursive: true});
  const files = [];
  for (let i = 0; i < 4; i++) {
    const img = Dg.lowLight(synth.sideReal({w: 420, h: 560, D: DIA, ppm: 20, tiltDeg: [2, -3, 1, -1][i], axisDx: [0, 8, -5, 3][i], tipV: -170, helixDeg: 30, flutes: 4, vb, zoneMm: 3, seed: 11 + i, bg: 'dark'}), .2, 7 + i);
    const f = path.join(outDir, `side${i + 1}.png`); fs.writeFileSync(f, png(img)); files.push(f);
  }
  const top = {width: 200, height: 200, data: new Uint8ClampedArray(200 * 200 * 4).fill(20)};
  const f = path.join(outDir, 'top.png'); fs.writeFileSync(f, png(top)); files.push(f);
  return files;
}
module.exports = make; module.exports.png = png;
if (require.main === module) console.log(make(process.argv[2] || 'degraded').join('\n'));
