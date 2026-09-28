// Alignment/band overlay PNGs for eyeballing the pipeline on the sample photos. Node only.
// Usage: node test/wear/overlay.js <outdir> [scale=3]   -> <outdir>/<side>-overlay.png
//   red = silhouette lines, green = tip, blue = inspection zone end, magenta = measured wear band
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const W = require('../../www/js/wear/wear-core.js'), readPng = require('./png.js');

function writePng(file, {width: w, height: h, data}) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4), c = Buffer.alloc(4), td = Buffer.concat([Buffer.from(t), d]); l.writeUInt32BE(d.length); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const raw = Buffer.alloc(h * (4 * w + 1));
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + 4 * w * y, 4 * w).copy(raw, y * (4 * w + 1) + 1);
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

function upscale(img, f) {
  const w = img.width * f, h = img.height * f, d = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) d.set(img.data.subarray(4 * ((y / f | 0) * img.width + (x / f | 0)), 4 * ((y / f | 0) * img.width + (x / f | 0)) + 4), 4 * (y * w + x));
  return {width: w, height: h, data: d};
}

// draw one side: P = prepareSide() result, band = Uint8Array over the strip (optional)
function drawSide(img, P, band, f = 3) {
  const out = upscale(img, f), {al, strip} = P, dot = (x, y, c) => { x = Math.round(x * f); y = Math.round(y * f); if (x >= 0 && y >= 0 && x < out.width && y < out.height) out.data.set(c, 4 * (y * out.width + x)); };
  const R = strip.R, m = strip.cx - R + .5, len = strip.h - strip.top;
  // strip col -> u = uC - R - m + col + .5 ; row -> v = vTip - top + r
  const toI = (col, r) => al.toImg(al.uC - R - m + col + .5, al.vTip - strip.top + r);
  if (band) for (let r = 0; r < strip.h; r++) for (let col = 0; col < strip.w; col++) if (band[r * strip.w + col]) { const [x, y] = toI(col, r); dot(x, y, [255, 0, 255, 255]); }
  for (let t = -strip.top; t < len; t += 1 / f) { for (const u of [al.uL, al.uR]) { const [x, y] = al.toImg(u, al.vTip + t); dot(x, y, [255, 40, 40, 255]); } }
  for (let u = al.uL; u <= al.uR; u += 1 / f) { const [x, y] = al.toImg(u, al.vTip); dot(x, y, [40, 255, 40, 255]); const [x2, y2] = al.toImg(u, al.vTip + P.zoneRows); dot(x2, y2, [60, 120, 255, 255]); }
  return out;
}

module.exports = {writePng, upscale, drawSide};

if (require.main === module) {
  const outDir = process.argv[2] || '.', f = +process.argv[3] || 3;
  fs.mkdirSync(outDir, {recursive: true});
  const tiles = [];
  for (const s of ['side1', 'side2', 'side3', 'side4']) {
    const img = readPng(path.join(__dirname, 'samples', s + '.png')), P = W.prepareSide(img, {diameterMm: 10});
    if (!P) { console.log(s, 'no alignment'); continue; }
    const seg = W.classicSegment(P);
    const ov = drawSide(img, P, seg.band, f); tiles.push(ov);
    writePng(path.join(outDir, s + '-overlay.png'), ov);
    console.log(s, 'tilt', P.al.tiltDeg.toFixed(2), 'widthPx', P.al.sepPx.toFixed(1), 'px/mm', P.al.pxPerMm.toFixed(2), 'tip', P.al.tipPx.map(v => v.toFixed(1)).join(','), 'VBmax', W.finishSide(P, seg, 30).vbMaxMm);
  }
  if (tiles.length) { // montage of all sides
    const H = Math.max(...tiles.map(t => t.height)), Wd = tiles.reduce((a, t) => a + t.width + 4, 0), m = new Uint8ClampedArray(Wd * H * 4); let x0 = 0;
    for (const t of tiles) { for (let y = 0; y < t.height; y++) m.set(t.data.subarray(4 * y * t.width, 4 * (y + 1) * t.width), 4 * (y * Wd + x0)); x0 += t.width + 4; }
    writePng(path.join(outDir, 'montage.png'), {width: Wd, height: H, data: m});
  }
}
