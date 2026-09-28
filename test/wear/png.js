// Minimal PNG decoder for the test samples (8-bit RGB/RGBA, non-interlaced). Node only.
'use strict';
const fs = require('fs'), zlib = require('zlib');

module.exports = function readPng(file) {
  const b = fs.readFileSync(file); let p = 8, w, h, ct, idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; if (d[8] !== 8 || d[12]) throw new Error('unsupported png'); }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  const bpp = ct === 6 ? 4 : ct === 2 ? 3 : 0; if (!bpp) throw new Error('unsupported color type ' + ct);
  const raw = zlib.inflateSync(Buffer.concat(idat)), st = w * bpp, out = Buffer.alloc(h * st), rgba = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (st + 1)], line = raw.subarray(y * (st + 1) + 1, (y + 1) * (st + 1)), o = y * st;
    for (let x = 0; x < st; x++) {
      const a = x >= bpp ? out[o + x - bpp] : 0, up = y ? out[o - st + x] : 0, c = y && x >= bpp ? out[o - st + x - bpp] : 0;
      const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c);
      const pred = [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f];
      out[o + x] = (line[x] + pred) & 255;
    }
  }
  for (let i = 0; i < w * h; i++) { for (let j = 0; j < 3; j++) rgba[4 * i + j] = out[i * bpp + j]; rgba[4 * i + 3] = bpp === 4 ? out[i * bpp + 3] : 255; }
  return {width: w, height: h, data: rgba};
};
