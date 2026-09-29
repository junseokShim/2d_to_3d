// minimal RGB PNG writer for diagnostics: writePng(file, w, h, rgb Uint8Array w*h*3)
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
