'use strict';
const path = require('path'), W = require('../../../www/js/wear/wear-core.js'), readPng = require('../png.js');
const up = (img, f) => { if (f === 1) return img; const w = Math.round(img.width * f), h = Math.round(img.height * f), d = new Uint8ClampedArray(w * h * 4), s = img.data, iw = img.width;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = Math.min(iw - 1.001, Math.max(0, (x + .5) / f - .5)), Y = Math.min(img.height - 1.001, Math.max(0, (y + .5) / f - .5)), x0 = X | 0, y0 = Y | 0, fx = X - x0, fy = Y - y0;
    for (let c = 0; c < 4; c++) { const i = 4 * (y0 * iw + x0) + c; d[4 * (y * w + x) + c] = (s[i] * (1 - fx) + s[i + 4] * fx) * (1 - fy) + (s[i + 4 * iw] * (1 - fx) + s[i + 4 * iw + 4] * fx) * fy; } }
  return {width: w, height: h, data: d}; };
module.exports = {up};
if (require.main === module) for (const F of [1, 4, 8]) for (const f of ['side1', 'side2', 'side3', 'side4']) {
  const im = up(readPng(path.join(__dirname, '..', 'samples', f + '.png')), F), G = W.gray(im), al = W.align(G, W.sobel(G), 10);
  console.log(F, f, 'tilt', al.tiltDeg.toFixed(1), 'uL', (al.uL / F + G.w / 2 / F).toFixed(1), 'uR', (al.uR / F + G.w / 2 / F).toFixed(1), 'ppm/F', (al.pxPerMm / F).toFixed(2), 'tip', al.tipPx.map(v => (v / F).toFixed(1)).join(','));
}
