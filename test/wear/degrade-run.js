// Degradation test set: synthetic worn end mills (real-like coated tool) under phone-camera faults. Reports, per case,
// which pipeline stage fails (silhouette, tip, edge/helix, band) with the raw pipeline and with the enhancement chain.
// Run: node test/wear/degrade-run.js [--ai] [--raw] [--only name]    Exit code 1 if any enhanced case fails.
'use strict';
const W = require('../../www/js/wear/wear-core.js'), synth = require('./synth.js'), D = require('./degrade.js');
let E = null; try { E = require('../../www/js/enhance/enhance.js'); } catch (e) { /* enhancement not present yet */ }
const argv = process.argv.slice(2), AI = argv.includes('--ai'), RAW_ONLY = argv.includes('--raw'), ONLY = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

const DIA = 10, VB = [.3, .22], vbf = m => z => m * (1 - .35 * z / 3);
// base scene; truth(t) = tool geometry in image pixels for side t
function scene(i, o = {}) {
  const b = Object.assign({w: 420, h: 560, D: DIA, ppm: 20, tiltDeg: [2, -3][i], axisDx: [0, 8][i], tipV: -170, helixDeg: 30, flutes: 4, vb: vbf(VB[i]), zoneMm: 3, seed: 11 + i, bg: i ? 'light' : 'dark'}, o);
  if (o.ppm && !o.w) { const f = o.ppm / 20; b.w = Math.round(420 * f); b.h = Math.round(560 * f); b.tipV = -170 * f; b.axisDx = b.axisDx * f; }
  const t = b.tiltDeg * Math.PI / 180, c = Math.cos(t), s = Math.sin(t), R = b.D / 2 * b.ppm;
  const tip = [b.axisDx * c + b.tipV * s + b.w / 2 - .5, -b.axisDx * s + b.tipV * c + b.h / 2 - .5];
  const isTool = (x, y) => { const dx = x + .5 - b.w / 2, dy = y + .5 - b.h / 2, u = dx * c - dy * s - b.axisDx, v = dx * s + dy * c - b.tipV; return Math.abs(u) < R + 3 && v > -3; };
  return {img: synth.sideReal(b), truth: {ppm: b.ppm, tilt: b.tiltDeg, tip, vb: VB[i]}, isTool, b};
}
const tf = (T, f) => Object.assign({}, T, f);
// each case: name, build(i) -> {img, truth}; truth.ppm/tip follow any geometric change (tip null = not checked)
const CASES = [
  {name: 'clean', make: i => scene(i)},
  {name: 'blur s=2px', make: i => { const S = scene(i); return {img: D.blur(S.img, 2), truth: S.truth}; }},
  {name: 'blur s=3.5px', make: i => { const S = scene(i); return {img: D.blur(S.img, 3.5), truth: S.truth}; }},
  {name: 'noise s=25', make: i => { const S = scene(i); return {img: D.noise(S.img, 25, 3 + i), truth: S.truth}; }},
  {name: 'low light x0.2', make: i => { const S = scene(i); return {img: D.lowLight(S.img, .2, 7 + i), truth: S.truth}; }},
  {name: 'colour cast', make: i => { const S = scene(i); return {img: D.cast(S.img), truth: S.truth}; }},
  {name: 'jpeg q50', make: i => { const S = scene(i); return {img: D.jpeg(S.img, 50), truth: S.truth}; }},
  {name: '10 px/mm', make: i => { const S = scene(i, {ppm: 10}); return {img: D.blur(S.img, .7), truth: S.truth}; }},
  {name: '6 px/mm', make: i => { const S = scene(i, {ppm: 6}); return {img: D.blur(S.img, .6), truth: S.truth}; }},
  {name: 'perspective 8% + roll 4', make: i => { const S = scene(i); return {img: D.perspective(S.img, .08, 4), truth: tf(S.truth, {tip: null, tilt: null, ppmTol: .08})}; }},
  {name: 'cluttered background', make: i => { const S = scene(i); return {img: D.clutter(S.img, S.isTool, 5 + i), truth: S.truth}; }},
  {name: 'fingers on shank', make: i => { const S = scene(i); return {img: D.fingers(S.img, S.b.h * .78), truth: S.truth}; }},
  {name: 'small in big frame', make: i => { const S = scene(i), P = D.pad(S.img, 1100, 900); return {img: P, truth: tf(S.truth, {tip: [S.truth.tip[0] + (1100 - 420 >> 1), S.truth.tip[1] + (900 - 560 >> 1)]})}; }},
  {name: 'phone combo', make: i => { const S = scene(i); return {img: D.jpeg(D.noise(D.cast(D.blur(D.perspective(D.clutter(S.img, S.isTool, 9 + i), .04, 2), 1.5), [1.15, 1, .8]), 10, 20 + i), 60), truth: tf(S.truth, {tip: null, tilt: null, ppmTol: .06})}; }}
];

// per-side stage check
function stages(side, truth, dbg) {
  const r = {};
  const al = side && side.align;
  r.silhouette = !!al && Math.abs(al.pxPerMm / truth.ppm - 1) <= (truth.ppmTol || .04) && (truth.tilt == null || Math.abs(al.tiltDeg - truth.tilt) <= 1.5);
  r.tip = !al ? false : truth.tip ? Math.hypot(al.tipPx[0] - truth.tip[0], al.tipPx[1] - truth.tip[1]) <= Math.max(3, .25 * truth.ppm) : true;
  r.edge = !!dbg && Math.abs((dbg.helixDegEstimated || 30) - 30) <= 8;
  const tol = Math.max(.08, .25 * truth.vb, 1.5 / truth.ppm), vb = side ? side.vbMaxMm : 0;
  r.band = !!side && Math.abs(vb - truth.vb) <= tol && vb >= .4 * truth.vb;   // detected, and within tolerance
  r.vb = vb; r.tol = tol;
  return r;
}

async function runCase(C, mode, seg) {
  const shots = [0, 1].map(i => C.make(i)), sides = shots.map(s => s.img);
  const args = {sides, flutes: 2, diameterMm: DIA, helixDeg: 30};
  let inp = args, q = null;
  if (mode === 'enh') { const P = E.prepareShots(sides, {diameterMm: DIA}); inp = Object.assign({}, args, {enhanced: P.images}); q = P.quality; }
  const out = seg ? await W.measureAsync(inp, seg, 'ai') : W.measure(inp), {result: R, debug} = out;
  const st = shots.map((s, i) => stages(R.perFlute[i] && Object.assign({}, R.perFlute[i], {align: debug.sides[i] && debug.sides[i].align}), s.truth, debug.sides[i]));
  return {st, q, fails: st.map(s => ['silhouette', 'tip', 'edge', 'band'].filter(k => !s[k]))};
}

(async () => {
  let seg = null;
  if (AI) { const AIW = require('../../www/js/wear/ai-wear.js'); seg = AIW.createSegmenter(await require('./ort-node.js')(), W); }
  const modes = RAW_ONLY || !E ? ['raw'] : ['raw', 'enh'], tally = {raw: [0, 0], enh: [0, 0]};
  console.log(`# degradation set, ${AI ? 'AI' : 'classic'} engine; truth VBmax ${VB.join(', ')} mm, D${DIA}; pass = every stage ok on both sides`);
  for (const C of CASES) {
    if (ONLY && !C.name.includes(ONLY)) continue;
    const line = [];
    for (const m of modes) {
      const t0 = Date.now(), r = await runCase(C, m, seg), ok = r.fails.every(f => !f.length);
      tally[m][0] += ok; tally[m][1]++;
      line.push(`${m} ${ok ? 'PASS' : 'FAIL'} vb ${r.st.map(s => s.vb.toFixed(3)).join('/')}` + (ok ? '' : ` failed: ${r.fails.map((f, i) => `s${i + 1}[${f.join(',') || '-'}]`).join(' ')}`) +
        (r.q ? ` q:${r.q.map(x => x.verdict).join('/')}` : '') + ` ${Date.now() - t0}ms`);
    }
    console.log(`${C.name.padEnd(24)} ${line.join('  |  ')}`);
  }
  for (const m of modes) console.log(`${m}: ${tally[m][0]}/${tally[m][1]} cases pass`);
  process.exit(modes.includes('enh') && tally.enh[0] < tally.enh[1] ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
