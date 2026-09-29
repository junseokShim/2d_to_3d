'use strict';
// node diag2.js <upscale> <outdir>
const path = require('path'), fs = require('fs'), W = require('../../../www/js/wear/wear-core.js'), AI = require('../../../www/js/wear/ai-wear.js'), readPng = require('../png.js'), loadOrt = require('../ort-node.js'), {writePng} = require('../ai-diag.js');
const up = (img, f) => { if (f === 1) return img; const w = Math.round(img.width * f), h = Math.round(img.height * f), d = new Uint8ClampedArray(w * h * 4), s = img.data, iw = img.width;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = Math.min(iw - 1.001, Math.max(0, (x + .5) / f - .5)), Y = Math.min(img.height - 1.001, Math.max(0, (y + .5) / f - .5)), x0 = X | 0, y0 = Y | 0, fx = X - x0, fy = Y - y0;
    for (let c = 0; c < 4; c++) { const i = 4 * (y0 * iw + x0) + c; d[4 * (y * w + x) + c] = (s[i] * (1 - fx) + s[i + 4] * fx) * (1 - fy) + (s[i + 4 * iw] * (1 - fx) + s[i + 4 * iw + 4] * fx) * fy; } }
  return {width: w, height: h, data: d}; };
const F = +(process.argv[2] || 1), out = process.argv[3];
const S = f => up(readPng(path.join(__dirname, '..', 'samples', f)), F);
(async () => {
  const sides = ['side1.png', 'side2.png', 'side3.png', 'side4.png'].map(S);
  const args = {sides, flutes: 4, diameterMm: 10};
  const seg = AI.createSegmenter(await loadOrt(), W);
  const A = await W.measureAsync(args, seg, 'ai');
  console.log('ai', JSON.stringify(A.result.totals), 'helix', A.result.helixDeg, 'perFlute', JSON.stringify(A.result.perFlute.map(f => f.vbMaxMm)));
  A.debug.sides.forEach((s, i) => s && console.log('side', i + 1, JSON.stringify(s.align), 'hEst', s.helixDegEstimated, s.method));
  A.debug.ai.forEach((a, i) => a && console.log('ai', i + 1, JSON.stringify({edge: a.edge, sep: a.sep, seed: a.seedPx, tau: +a.tau.toFixed(3), nRef: a.nRef, nQ: a.nQuery, max: +a.maxScore.toFixed(2)})));
  if (!out) return; fs.mkdirSync(out, {recursive: true});
  A.debug.strips.forEach((e, i) => { if (!e) return; const {strip: St, band: B} = e, a = A.debug.ai[i], U = a ? AI.upsample(a.cells, a.fh, a.fw, St, a.sc) : new Float32Array(St.w * St.h), o = new Uint8Array(St.w * St.h * 9), W3 = 3 * St.w;
    const zEnd = St.top + Math.round(.8 * 10 * St.ppm);
    for (let y = 0; y < St.h; y++) for (let x = 0; x < St.w; x++) { const k = y * St.w + x, v = Math.min(255, U[k] * 80), line = y === St.top || y === zEnd;
      for (let c = 0; c < 3; c++) { o[3 * (y * W3 + x) + c] = line ? (c ? 0 : 255) : St.rgb[3 * k + c]; o[3 * (y * W3 + St.w + x) + c] = c ? v * (U[k] > 1.5) : v; o[3 * (y * W3 + 2 * St.w + x) + c] = B[k] ? (c === 1 ? 255 : 0) : St.rgb[3 * k + c]; } }
    writePng(`${out}/s${i + 1}.png`, W3, St.h, o); });
})().catch(e => { console.error(e); process.exit(1); });
