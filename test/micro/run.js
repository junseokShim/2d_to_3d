// Microscope input mode (www/js/micro/micro-core.js). Run: node test/micro/run.js
//  1. calibration: um/px, stage micrometer line, per-magnification store
//  2. maths on exact synthetic labels: edge line fit (slanted, chipped stretch), VB normal to the edge, zone C / VBC, U (k=2)
//  3. metrology panel inputs: the stacked flute strip evaluates to the same VB in metro-core; dragging the wear boundary moves it
//  4. MUDESTREDA test split (tool T10, never used to tune): the network (seg-wear.js U-Net) on the whole image vs the VB derived
//     from the dataset labels through the same maths. MUDESTREDA publishes no px/mm, so lengths are compared in image px
//     (mm = px / px_per_mm). Skipped when the dataset is not on this machine (TOOLWEAR=<dir> to point at it).
'use strict';
const fs = require('fs'), path = require('path');
const MC = require('../../www/js/micro/micro-core.js'), M = require('../../www/js/metro/metro-core.js');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };
const near = (name, got, want, tol) => check(name, Math.abs(got - want) <= tol, `got ${(+got).toFixed(4)} want ${want} ±${tol}`);

// synthetic one-hot probabilities: tool above y = a + b x (background below), wear land of width vb(x) px normal to the edge
function synth(W, H, a, b, vbOf, chip) {
  const n = W * H, prob = new Float32Array(5 * n), c = Math.sqrt(1 + b * b);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const d = (a + b * x - y) / c;                       // distance above the edge line (into the tool), px
    let k = d < 0 ? 0 : d < vbOf(x) ? 2 : 1;
    if (chip && x >= chip[0] && x < chip[1] && d >= 0 && d < chip[2]) k = 0;   // broken out of the edge: background
    prob[k * n + y * W + x] = 1;
  }
  return {prob, w: W, h: H, scale: [1, 1]};
}
const blank = (W, H) => ({width: W, height: H, data: new Uint8ClampedArray(W * H * 4).fill(128)});

(async () => {
  console.log('# 1. calibration');
  const cu = MC.calibUm(2.5);
  near('um/px -> px/mm', cu.pxPerMm, 400, 1e-9);
  const cl = MC.calibLine(812, 2, .002);
  near('micrometer line 812 px = 2 mm -> px/mm', cl.pxPerMm, 406, 1e-9);
  near('micrometer u_rel = hypot(tol/sqrt3/L, sqrt2*1px/len)', cl.uRel, Math.hypot(.002 / Math.sqrt(3) / 2, Math.SQRT2 / 812), 1e-4);
  const mem = {}, store = {getItem: k => mem[k] || null, setItem: (k, v) => { mem[k] = v; }}, cs = MC.calStore(store);
  cs.set(50, cu); cs.set(200, cl);
  check('store keeps one calibration per magnification', cs.get(50).pxPerMm === 400 && cs.get(200).pxPerMm === 406 && cs.get(100) === null && !!cs.get(50).date);
  cs.remove(50); check('store remove', cs.get(50) === null && cs.get(200).pxPerMm === 406);
  const mcal = MC.metroCalib(cl, 200);
  check('metro calibration: microscope method, scale 1 at the calibrated px/mm', mcal.method === 'microscope' && mcal.scaleFor(406) === 1 && mcal.magnification === 200);

  console.log('\n# 2. maths on exact synthetic labels');
  // rotate / unrotate round trip
  const im = {width: 5, height: 3, data: new Uint8ClampedArray(60).map((_, i) => i)};
  let rt = true; for (let q = 0; q < 4; q++) { const r = MC.rotate(im, q); for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) { const X = q === 0 ? x : q === 1 ? 2 - y : q === 2 ? 4 - x : y, Y = q === 0 ? y : q === 1 ? x : q === 2 ? 2 - y : 4 - x, [x2, y2] = MC.unrotate(q, 5, 3, X, Y); if (x2 !== x || y2 !== y || r.data[4 * (Y * r.width + X)] !== im.data[4 * (y * 5 + x)]) rt = false; } }
  check('rotate / unrotate', rt);
  const W = 600, H = 300, A = 200, B = .05, vb = x => 30 + 20 * Math.exp(-(((x - 400) / 40) ** 2));   // land 30 px, bump to 50 px at x 400
  const sg = synth(W, H, A, B, vb, [100, 140, 12]);
  const r = await MC.analyzeImage(blank(W, H), {oracle: () => sg, rotate: 0, pxPerMm: 100, uRel: .005, corner: 'start', cornerMm: .5, smoothPx: 0});
  near('edge line intercept (chip left out)', r.line.a, A, .6); near('edge line slope', r.line.b, B, .002);
  check('chipped columns dropped from the fit', r.line.receded >= 20, `receded ${r.line.receded}`);
  near('VBmax = 0.50 mm (land bump, normal to the slanted edge)', r.stats.vbMax, .5, .02);
  near('VBB (zone B mean: 30 px land + bump area / zone B) ~ 0.33 mm', r.stats.vbb, .33, .01);
  check('VBC in zone C (first 0.5 mm along the edge)', r.stats.vbc > .29 && r.stats.vbc < .32, `VBC ${r.stats.vbc}`);
  check('U (k=2) > 0 with scale + edge + boundary + pixel parts', r.q2.vbMax.U > 0 && r.q2.vbMax.parts.scale > 0 && r.q2.vbMax.parts.pixel > 0, JSON.stringify(r.q2.vbMax));
  check('no flags on clean synthetic land', r.flags.length === 0, r.flags.join());
  // tool below the edge (image upside down): auto rotation brings it on top
  const sgUp = synth(W, H, A, 0, () => 30), flip = {prob: new Float32Array(sgUp.prob.length), w: W, h: H, scale: [1, 1]};
  for (let c = 0; c < 5; c++) for (let i = 0; i < W * H; i++) flip.prob[c * W * H + (W * H - 1 - i)] = sgUp.prob[c * W * H + i];
  const side = MC.toolSide(flip); check('tool side detection: upside-down image -> 2 quarter turns', side.q === 2, JSON.stringify(side));
  const s90 = MC.toolSide({prob: (() => { const p = new Float32Array(5 * W * W), n = W * W; for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) p[(x < 300 ? 1 : 0) * n + y * W + x] = 1; return p; })(), w: W, h: W, scale: [1, 1]});
  check('tool side detection: tool on the left -> 1 clockwise quarter turn', s90.q === 1, JSON.stringify(s90));
  // no wear
  const r0 = await MC.analyzeImage(blank(W, H), {oracle: () => synth(W, H, A, B, () => 0), rotate: 0, pxPerMm: 100});
  check('sharp edge: VB 0, flagged no-wear', r0.stats.vbMax === 0 && r0.flags.includes('no-wear'));

  console.log('\n# 3. metrology panel inputs (flute strip -> metro-core)');
  const fs1 = MC.fluteStrip([r, r0], 100, 'none'), F = M.flute(fs1.strip, fs1.band, 10, {zoneMm: 1e6, cornerMm: 0, apMm: 1e6, notchHalfMm: 0}, fs1.rowVbMm);
  const o = {helixDeg: 0, zoneMm: 1e6, cornerMm: 0, apMm: 1e6, notchHalfMm: 0, scale: 1, uScaleRel: .005};
  const e = M.evaluate(F, o);
  check('strip stacks both images with a gap', fs1.strip.h === r.frame.L + r0.frame.L + MC.GAP && fs1.strip.edgeCol === MC.PADV);
  near('metro VBmax == micro VBmax (unedited)', e.vbMaxMm, r.stats.vbMax, .011);
  check('metro edge side = the known edge column', F.edge === 'a' && Math.abs(M.edgeX(F, 10) - (MC.PADV - .5)) < .6, `edgeX ${M.edgeX(F, 10)}`);
  for (let i = 0; i < F.nodeRows.length; i++) M.setNode(F, 'b', i, 10);   // wear boundary dragged out by 10 px = 0.1 mm everywhere
  const e2 = M.evaluate(F, o);
  near('dragging the wear boundary out by 10 px raises VBmax by 0.1 mm', e2.vbMaxMm - e.vbMaxMm, .1, .005);
  check('edited flute reported as edited', e2.edited && e2.mode === 'edited');
  const As = M.assistFlute(MC.fluteStrip([r0], 100, 'none').strip, 10, {zoneMm: 1e6}, 'no-band');
  check('no-band flute: operator-assisted on the known edge line (no helix guess)', As.assist.guess === true && Math.abs(M.edgeX(As, 5) - (MC.PADV - .5)) < .6);
  const fsE = MC.fluteStrip([r], 100, 'end');
  check('corner at the end: strip reversed (zone C at row 0)', Math.abs(fsE.rowVbMm[0] - fs1.rowVbMm[r.frame.L - 1]) < 1e-6);
  const csv = M.csv({toolId: 't', operator: '', date: 'd', D: 10, k: 1, helixDeg: 0, engine: 'x', inputMode: 'microscope', magnification: 200, calib: mcal, limitMm: .3,
    flutes: [Object.assign(e, {status: M.status(e.q.vbMax.v, e.q.vbMax.U)})], manual: []});
  check('CSV carries input_mode=microscope and the magnification', /input_mode,microscope/.test(csv) && /magnification,200x/.test(csv) && /scale_method,microscope/.test(csv));

  console.log('\n# 4. MUDESTREDA test split (T10): network vs label-derived VB, px');
  const mud = require('./mud.js');
  if (!fs.existsSync(path.join(mud.DS, 'manifest.json'))) { console.log('SKIP  dataset not found at ' + mud.DS); return done(); }
  const SEG = require('../../www/js/wear/seg-wear.js'), run = await require('../wear/ort-seg-node.js')();
  const items = mud.items('test'), rows = [];
  for (const it of items) {
    const {img, lab} = mud.load(it);
    let n; try { n = await MC.analyzeImage(img, {runProbs: run, seg: SEG, pxPerMm: 1}); } catch (err) { rows.push({id: it.id, err: String(err.message)}); continue; }
    const O = mud.oracle(lab, n.q), t = await MC.analyzeImage(img, {oracle: () => O.seg, rotate: n.q, pxPerMm: 1});
    rows.push({id: it.id, state: it.info.state, q: n.q, dA: Math.abs(n.line.a - t.line.a), net: n.stats.vbMax, lab: t.stats.vbMax, info: it.info.vbPxMax, netB: n.stats.vbb, labB: t.stats.vbb, U: n.q2.vbMax.U, flags: n.flags});
  }
  const ok = rows.filter(x => !x.err), m = a => a.reduce((s, v) => s + v, 0) / (a.length || 1), med = a => { const b = a.slice().sort((p, q) => p - q); return b[b.length >> 1]; };
  for (const x of rows) console.log(x.err ? `  ${x.id} ERROR ${x.err}` : `  ${x.id} ${x.state.padEnd(6)} edge d${x.dA.toFixed(1)}  VBmax net ${x.net.toFixed(0)} lab ${x.lab.toFixed(0)} (labelinfo ${x.info})  VBB net ${x.netB.toFixed(0)} lab ${x.labB.toFixed(0)}  U ${x.U.toFixed(0)} ${x.flags.join(',')}`);
  const eMax = ok.map(x => x.net - x.lab), eB = ok.map(x => x.netB - x.labB), within = ok.filter(x => Math.abs(x.net - x.lab) <= Math.max(x.U, .25 * x.lab)).length;
  const cov = ok.filter(x => Math.abs(x.net - x.lab) <= x.U).length;
  console.log(`  N ${ok.length}/${rows.length}  VBmax MAE ${m(eMax.map(Math.abs)).toFixed(1)} px bias ${m(eMax).toFixed(1)}  VBB MAE ${m(eB.map(Math.abs)).toFixed(1)} bias ${m(eB).toFixed(1)}  |net-lab| <= U: ${cov}  within max(U, 25 %): ${within}`);
  const sharp = ok.filter(x => x.state === 'sharp'), worn = ok.filter(x => x.state !== 'sharp');
  console.log(`  mean VBmax net sharp ${m(sharp.map(x => x.net)).toFixed(0)} / worn ${m(worn.map(x => x.net)).toFixed(0)}; label sharp ${m(sharp.map(x => x.lab)).toFixed(0)} / worn ${m(worn.map(x => x.lab)).toFixed(0)}`);
  check('label maths: label-derived VBmax == labelinfo vbPxMax (median |diff| <= 3 px)', med(ok.filter(x => x.info != null).map(x => Math.abs(x.lab - x.info))) <= 3);
  check('every test image: edge found, tool on top', ok.length === rows.length && ok.every(x => x.q === 0));
  check('edge line within 3 px of the label edge (median)', med(ok.map(x => x.dA)) <= 3, `median ${med(ok.map(x => x.dA)).toFixed(2)} px`);
  // thresholds fixed on the validation tool (T3) before this split was run
  check('VBB (zone B mean) MAE <= 15 px', m(eB.map(Math.abs)) <= 15, `${m(eB.map(Math.abs)).toFixed(1)} px`);
  check('VBmax MAE <= 30 px', m(eMax.map(Math.abs)) <= 30, `${m(eMax.map(Math.abs)).toFixed(1)} px`);
  // wear threshold (micro-core WEAR_THR) picked on val T3, where it left sharp tools 8 px over the label mean
  check('sharp tools read small VB: mean VBmax within 15 px of the label mean', Math.abs(m(sharp.map(x => x.net)) - m(sharp.map(x => x.lab))) <= 15,
    `net ${m(sharp.map(x => x.net)).toFixed(1)} lab ${m(sharp.map(x => x.lab)).toFixed(1)}`);
  console.log(`  operator review flagged: ${ok.filter(x => x.flags.includes('review')).length}/${ok.length}; mean |net-lab| flagged ${m(ok.filter(x => x.flags.includes('review')).map(x => Math.abs(x.net - x.lab))).toFixed(1)} / unflagged ${m(ok.filter(x => !x.flags.includes('review')).map(x => Math.abs(x.net - x.lab))).toFixed(1)} px`);
  done();
})().catch(e => { console.error(e); process.exit(1); });
function done() { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
