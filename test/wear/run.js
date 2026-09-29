// Wear module tests. Run: node test/wear/run.js   (no dependencies)
'use strict';
const path = require('path');
const W = require('../../www/js/wear/wear-core.js'), synth = require('./synth.js'), readPng = require('./png.js');

let pass = 0, fail = 0;
const near = (name, got, want, tol) => {
  const ok = Math.abs(got - want) <= tol;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${(+got).toFixed(4)} want ${want} ±${tol}`);
  ok ? pass++ : fail++;
};
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };

const cases = [
  {name: 'uniform VB 0.20, D10, tilt +3', D: 10, ppm: 40, tiltDeg: 3, helixDeg: 30, flutes: 4, zoneMm: 4, vb: () => .2, w: 640, h: 760, tipV: -300, axisDx: 15},
  {name: 'ramp VB 0.30->0.10, D6, tilt -5', D: 6, ppm: 50, tiltDeg: -5, helixDeg: 35, flutes: 3, zoneMm: 3, vb: z => .3 - .2 * z / 3, w: 560, h: 720, tipV: -300, axisDx: -20},
  {name: 'uniform VB 0.08, D12, tilt 0, 2 flutes', D: 12, ppm: 30, tiltDeg: 0, helixDeg: 25, flutes: 2, zoneMm: 5, vb: () => .08, w: 640, h: 760, tipV: -320, axisDx: 0}
];

for (const c of cases) {
  console.log('\n# ' + c.name);
  const img = synth.side(c), r = W.analyzeSide(img, {diameterMm: c.D});
  check('align found', !!r); if (!r) continue;
  const tb = Math.tan(c.helixDeg * Math.PI / 180), cb = Math.cos(c.helixDeg * Math.PI / 180), n = 400;
  let vmax = 0, vsum = 0, area = 0, vol = 0;
  for (let i = 0; i < n; i++) { const z = (i + .5) / n * c.zoneMm, v = c.vb(z), dz = c.zoneMm / n; vmax = Math.max(vmax, v); vsum += v; area += v / cb * dz; vol += .5 * v * v * Math.tan(8 * Math.PI / 180) * dz / cb; }
  const px = 1 / c.ppm;
  near('tilt deg', r.align.tiltDeg, c.tiltDeg, .3);
  near('px/mm', r.align.pxPerMm, c.ppm, .02 * c.ppm);
  near('helix deg (estimated)', r.helixDegEstimated || 0, c.helixDeg, 5);
  near('VBmax mm', r.vbMaxMm, vmax, Math.max(.03, 1.5 * px));
  near('VBavg mm', r.vbAvgMm, vsum / n, Math.max(.02, 1.2 * px));
  near('area mm2', r.areaMm2, area, .12 * area);
  near('volume mm3', r.volumeMm3, vol, .25 * vol);
  near('worn length mm', r.wornLengthMm, c.zoneMm, .1 * c.zoneMm);
  void tb;
}

console.log('\n# no wear -> VB ~ 0');
{
  const r = W.analyzeSide(synth.side(Object.assign({}, cases[0], {vb: () => 0})), {diameterMm: 10});
  near('VBmax mm', r.vbMaxMm, 0, .03);
  // background above the tip must never read as wear (v0.5.4 did on 9 of these 30)
  const fp = [];
  for (let seed = 1; seed <= 10; seed++) for (const t of [-4, 0, 3]) {
    const q = W.analyzeSide(synth.side(Object.assign({}, cases[0], {vb: () => 0, tiltDeg: t, seed})), {diameterMm: 10});
    if (!q || q.vbMaxMm > .03) fp.push(`seed ${seed} tilt ${t}: ${q && q.vbMaxMm}`);
  }
  check('no wear, 10 seeds x 3 tilts: VBmax <= 0.03', !fp.length, fp.join('; '));
}

console.log('\n# tip damage (broken end tooth, bright fracture face) -> measured, flagged for the operator; clean tips -> none');
{
  const base = {w: 420, h: 560, D: 10, ppm: 20, tiltDeg: 1, axisDx: 0, tipV: -170, helixDeg: 30, flutes: 4, zoneMm: 3, bg: 'dark'};
  const side = o => { const P = W.prepareSide(synth.sideReal(Object.assign({}, base, o)), {diameterMm: 10}); return W.finishSide(P, W.classicSegment(P), 30); };
  for (const [dMm, wMm, uMm] of [[1.2, 1.5, -1], [2, 2.5, 1.5]]) {
    const s = side({vb: () => 0, seed: 11, fracture: {uMm, wMm, dMm}});
    near(`fracture ${dMm} mm deep: tip depth mm`, s.tip.depthMm, dMm, .15);
    const arcW = 5 * (Math.asin((uMm + wMm / 2) / 5) - Math.asin((uMm - wMm / 2) / 5));   // truth: arc width on the D10 cylinder
    near(`fracture ${wMm} mm wide (arc ${arcW.toFixed(2)}): tip width mm`, s.tip.widthMm, arcW, .25);
    check('fracture: flagged for the operator (tip-damage)', s.needsOperator && s.reasons.includes('tip-damage'), s.reasons.join(','));
    check('fracture: counted in VBmax as corner/tip VBC (never a confident 0)', s.vbMaxMm >= s.tip.depthMm && s.vbTipMm === s.tip.depthMm && s.vbSource === 'corner/tip (VBC)', JSON.stringify({vb: s.vbMaxMm, flank: s.vbFlankMaxMm, src: s.vbSource}));
  }
  const fp = [];
  for (const seed of [11, 12, 13, 40, 41, 42]) for (const vbm of [0, .2]) {
    const s = side({vb: z => z <= 3 ? vbm : 0, seed, bg: seed % 2 ? 'light' : 'dark'});
    if (s.tip.depthMm > 0) fp.push(`seed ${seed} vb ${vbm}: ${s.tip.depthMm}`);
  }
  check('clean tips (6 seeds x unworn/flank-worn, dark+light bg): no tip damage', !fp.length, fp.join('; '));
  // specular line on the flute margin running down from the tip (thin helical streak) is not a chip
  const gl = [40, 41].map(seed => { const P = W.prepareSide(synth.sideReal(Object.assign({}, base, {flutes: 2, tiltDeg: 0, vb: () => 0, seed})), {diameterMm: 10}); return W.finishSide(P, W.classicSegment(P), 30); });
  check('margin glint streak at the tip (2 flutes, tilt 0): no tip damage, VBmax 0', gl.every(s => s.tip.depthMm === 0 && s.vbMaxMm === 0), gl.map(s => `${s.tip.depthMm}x${s.tip.widthMm}`).join('; '));
  const ok = side({vb: () => 0, seed: 11});
  check('clean tip at 20 px/mm: confident zero (no operator needed)', ok.vbMaxMm === 0 && !ok.needsOperator, ok.reasons.join(','));
}

console.log('\n# full measure(): 4 sides + top -> board contract');
{
  const c = cases[0], sides = [.2, .15, .25, .1].map((v, i) => synth.side(Object.assign({}, c, {vb: () => v, seed: i + 3})));
  const top = synth.top({w: 400, h: 300, D: 10, ppm: 20, cx: 210, cy: 140});
  const {result: R, debug} = W.measure({sides, top, flutes: 4, diameterMm: 10});
  const keys = o => Object.keys(o).sort().join(',');
  check('contract top-level keys', keys(R) === 'diameterMm,flutes,helixDeg,perFlute,totals', keys(R));
  check('perFlute length', R.perFlute.length === 4);
  check('perFlute keys', R.perFlute.every(f => keys(f) === 'areaMm2,profile,vbAvgMm,vbMaxMm,volumeMm3'));
  check('profile entries {zMm, vbMm}', R.perFlute.every(f => f.profile.length && f.profile.every(p => keys(p) === 'vbMm,zMm')));
  check('totals keys', keys(R.totals) === 'areaMm2,vbMaxMm,volumeMm3');
  [.2, .15, .25, .1].forEach((v, i) => near(`flute ${i + 1} VBmax`, R.perFlute[i].vbMaxMm, v, .03));
  near('totals.vbMaxMm', R.totals.vbMaxMm, .25, .03);
  near('helixDeg', R.helixDeg, 30, 5);
  near('top px/mm (scale check)', debug.top.pxPerMm, 20, .6);
  check('JSON serialisable', JSON.parse(JSON.stringify(R)).flutes === 4);
}

console.log('\n# sample photos cropped from the scenario sheet (low-res, ~5 px/mm): pipeline runs end to end');
{
  const S = f => readPng(path.join(__dirname, 'samples', f));
  const {result: R, debug} = W.measure({sides: ['side1.png', 'side2.png', 'side3.png', 'side4.png'].map(S), top: S('top.png'), flutes: 4, diameterMm: 10});
  const finite = JSON.stringify(R).match(/-?\d+(\.\d+)?(e-?\d+)?/g).map(Number).every(Number.isFinite) && !/null|NaN/.test(JSON.stringify(R));
  check('contract produced, all numbers finite', R.perFlute.length === 4 && finite);
  check('all 4 sides aligned', debug.failedSides.length === 0, JSON.stringify(debug.failedSides));
  console.log('      align:', JSON.stringify(debug.sides.map(s => s && s.align)));
  console.log('      top:', JSON.stringify(debug.top));
  console.log('      result:', JSON.stringify(Object.assign({}, R, {perFlute: R.perFlute.map(f => Object.assign({}, f, {profile: `[${f.profile.length} pts]`}))})));
  require('fs').writeFileSync(path.join(__dirname, 'samples', 'result.json'), JSON.stringify(R, null, 1));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
