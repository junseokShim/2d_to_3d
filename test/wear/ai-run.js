// AI path (PatchCore on ResNet-18 features, memory bank = the unworn body of the same photo) on synthetic worn photos.
// Run: node test/wear/ai-run.js   (loads onnxruntime-web wasm + the bundled backbone; ~seconds per side)
'use strict';
const W = require('../../www/js/wear/wear-core.js'), AI = require('../../www/js/wear/ai-wear.js'), synth = require('./synth.js'), loadOrt = require('./ort-node.js');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };
const near = (name, got, want, tol) => check(name, Math.abs(got - want) <= tol, `got ${(+got).toFixed(4)} want ${want} ±${tol}`);

(async () => {
  const t0 = Date.now(), seg = AI.createSegmenter(await loadOrt(), W);
  console.log(`# model loaded in ${Date.now() - t0} ms`);
  console.log('\n# real-like worn coated end mill (glints brighter than wear, cluttered background), 4 flutes, D10, 20 px/mm');
  const vbs = [.3, .2, .4, .25], vb = m => z => m * (1 - .35 * z / 3);
  const sides = vbs.map((m, i) => synth.sideReal({w: 420, h: 560, D: 10, ppm: 20, tiltDeg: [2, -3, 1, 0][i], axisDx: 0, tipV: -170, helixDeg: 30, flutes: 4, vb: vb(m), zoneMm: 3, seed: 11 + i, bg: i % 2 ? 'light' : 'dark'}));
  const t1 = Date.now(), {result: R, debug} = await W.measureAsync({sides, flutes: 4, diameterMm: 10}, seg, 'ai');
  console.log(`      ${Date.now() - t1} ms for 4 sides`);
  const S = debug.sides || [];
  check('engine = ai', debug.engine === 'ai' || R.engine === 'ai' || S.some(s => s && s.method === 'ai'), JSON.stringify(S.map(s => s && s.method)));
  check('every side used the AI segmenter (no fallback)', S.every(s => s && s.method === 'ai'), JSON.stringify(S.map(s => s && (s.aiError || s.method))));
  vbs.forEach((v, i) => near(`flute ${i + 1} VBmax (AI)`, R.perFlute[i].vbMaxMm, v, .06));
  const keys = o => Object.keys(o).sort().join(',');
  check('contract keys unchanged', keys(R) === 'diameterMm,flutes,helixDeg,perFlute,totals', keys(R));

  console.log('\n# unworn tool: the AI must not invent wear');
  const clean = [0, 1].map(i => synth.sideReal({w: 420, h: 560, D: 10, ppm: 20, tiltDeg: 0, tipV: -170, helixDeg: 30, flutes: 2, vb: () => 0, zoneMm: 3, seed: 40 + i, bg: 'dark'}));
  const {result: C} = await W.measureAsync({sides: clean, flutes: 2, diameterMm: 10}, seg, 'ai');
  check('unworn: VBmax < 0.05 mm', C.totals.vbMaxMm < .05, `got ${C.totals.vbMaxMm}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
