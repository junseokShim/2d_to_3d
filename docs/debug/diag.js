'use strict';
const path = require('path'), W = require('../../../www/js/wear/wear-core.js'), AI = require('../../../www/js/wear/ai-wear.js'), readPng = require('../png.js'), loadOrt = require('../ort-node.js');
const S = f => readPng(path.join(__dirname, '..', 'samples', f));
(async () => {
  const sides = ['side1.png', 'side2.png', 'side3.png', 'side4.png'].map(S);
  const args = {sides, top: S('top.png'), flutes: 4, diameterMm: 10};
  const C = W.measure(args);
  console.log('classic', JSON.stringify(C.result.totals), C.result.helixDeg, JSON.stringify(C.debug.sides.map(s => s && [s.align.tiltDeg, s.align.pxPerMm, s.align.tipPx, s.align.rotateDeg, s.helixDegEstimated, s.method, s.wornLengthMm])));
  const seg = AI.createSegmenter(await loadOrt(), W);
  const A = await W.measureAsync(args, seg, 'ai');
  console.log('ai', JSON.stringify(A.result.totals), A.result.helixDeg, JSON.stringify(A.result.perFlute.map(f => f.vbMaxMm)));
  console.log('aiErr', JSON.stringify(A.debug.aiErrors));
  A.debug.ai.forEach((a, i) => a && console.log('side', i + 1, JSON.stringify({edge: a.edge, sep: a.sep, seed: a.seedPx, tau: +a.tau.toFixed(3), nRef: a.nRef, nQ: a.nQuery, fh: a.fh, fw: a.fw, max: +a.maxScore.toFixed(2)})));
  A.debug.strips.forEach((s, i) => s && console.log('strip', i + 1, s.strip.w, s.strip.h, 'top', s.strip.top, 'R', s.strip.R.toFixed(1), 'ppm', s.strip.ppm.toFixed(2)));
})();
