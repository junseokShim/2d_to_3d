// minimal PNG helpers for the seg tests: writePng(file, w, h, rgb Uint8Array w*h*3), readLabel(file) -> {w, h, m}
'use strict';
const zlib = require('zlib'), fs = require('fs');
const crcT = Array.from({length: 256}, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = b => { let c = ~0; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (~c) >>> 0; };
exports.writePng = (file, w, h, rgb) => {
  const raw = Buffer.alloc((3 * w + 1) * h); for (let y = 0; y < h; y++) { raw[y * (3 * w + 1)] = 0; for (let i = 0; i < 3 * w; i++) raw[y * (3 * w + 1) + 1 + i] = rgb[3 * y * w + i]; }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 2;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
};

// grey label PNG (colour type 0) -> Uint8Array; png.js reads RGB(A) only, so decode here
exports.readLabel = function readLabel(file) {
  const zlib = require('zlib'), b = fs.readFileSync(file); let p = 8, w, h, ct, idat = [];
  while (p < b.length) {
    const len = b.readUInt32BE(p), type = b.toString('ascii', p + 4, p + 8), d = b.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = d.readUInt32BE(0); h = d.readUInt32BE(4); ct = d[9]; }
    if (type === 'IDAT') idat.push(d);
    p += 12 + len;
  }
  if (ct !== 0) { const im = require('./png.js')(file), m = new Uint8Array(w * h); for (let i = 0; i < w * h; i++) m[i] = im.data[4 * i]; return {w, h, m}; }
  const raw = zlib.inflateSync(Buffer.concat(idat)), m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (w + 1)], o = y * w;
    for (let x = 0; x < w; x++) {
      const v = raw[y * (w + 1) + 1 + x], a = x ? m[o + x - 1] : 0, up = y ? m[o - w + x] : 0, c = x && y ? m[o - w + x - 1] : 0;
      const pa = Math.abs(up - c), pb = Math.abs(a - c), pc = Math.abs(a + up - 2 * c);
      m[o + x] = (v + [0, a, up, (a + up) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? up : c][f]) & 255;
    }
  }
  return {w, h, m};
};
