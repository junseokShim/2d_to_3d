// Real photos (test/wear/samples: crops of the operator's 4 side shots + top, D10, 4 flutes, ~4.6 px/mm) must not read
// as an unworn tool: the damage there is chipped / broken end teeth at the tip, which v0.5.4 reported as VBmax 0.000
// with helix 51.3 deg. Run: node test/wear/real-samples.js [--ai]   (--ai: also the PatchCore path, needs onnxruntime)
'use strict';
const path = require('path');
const W = require('../../www/js/wear/wear-core.js'), readPng = require('./png.js');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };
const S = f => readPng(path.join(__dirname, 'samples', f));
const sides = ['side1', 'side2', 'side3', 'side4'].map(n => S(n + '.png')), args = {sides, top: S('top.png'), flutes: 4, diameterMm: 10};

function verify(label, {result: R, debug}) {
  console.log(`\n# ${label}`);
  debug.sides.forEach((s, i) => console.log(`      side ${i + 1}: tilt ${s.align.tiltDeg} deg, ${s.align.pxPerMm} px/mm, helix est ${s.helixDegEstimated}, VBmax ${s.vbMaxMm} (flank ${s.vbFlankMaxMm}, tip ${s.vbTipMm}, ${s.vbSource}), operator: ${s.needsOperator} [${s.reasons}]`));
  check('all 4 sides aligned', debug.failedSides.length === 0, JSON.stringify(debug.failedSides));
  debug.sides.forEach((s, i) => check(`side ${i + 1}: |tilt| < 2 deg`, Math.abs(s.align.tiltDeg) < 2, `${s.align.tiltDeg}`));
  check(`helix 25..45 deg (catalogue-plausible, not the 51.3 of v0.5.4)`, R.helixDeg >= 25 && R.helixDeg <= 45, `${R.helixDeg} (${debug.helix.source}, ${debug.helix.confidence})`);
  for (const i of [1, 2, 3]) check(`side ${i + 1}: non-zero damage in the reported VBmax`, R.perFlute[i].vbMaxMm > 0, `${R.perFlute[i].vbMaxMm} mm (${debug.sides[i].vbSource})`);
  for (const i of [1, 2, 3]) check(`side ${i + 1}: goes to the operator (never a confident number)`, debug.sides[i].needsOperator, debug.sides[i].reasons.join(','));
  check('totals.vbMaxMm > 0', R.totals.vbMaxMm > 0, `${R.totals.vbMaxMm}`);
}

(async () => {
  verify('classic engine', W.measure(args));
  if (process.argv.includes('--ai')) {
    const AI = require('../../www/js/wear/ai-wear.js'), loadOrt = require('./ort-node.js');
    verify('AI engine (PatchCore)', await W.measureAsync(args, AI.createSegmenter(await loadOrt(), W), 'ai'));
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
