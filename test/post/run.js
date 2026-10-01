// post-processing tests (3D deviation, edge defects; 2D scale bar / VB lines also in test/metro/vb.js). Run: node test/post/run.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const P = require('../../www/js/post/post-core.js'), M = require('../../www/js/map3d/map3d-core.js');

let pass = 0, fail = 0;
const near = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got} want ${want} +-${tol}`); ok ? pass++ : fail++; };
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };

// render geometry (layout only) in a sandbox with a minimal THREE stub, as test/map3d does
function loadGeometry() {
  class Attr { constructor(a, n) { this.array = a instanceof Float32Array ? a : new Float32Array(a); this.itemSize = n; } }
  class Geo { setAttribute(k, v) { this[k] = v; } getAttribute(k) { return this[k]; } setIndex(i) { this.index = {array: i}; } getIndex() { return this.index; } computeVertexNormals() {} }
  const ctx = {window: {}, THREE: {BufferGeometry: Geo, BufferAttribute: Attr, Float32BufferAttribute: Attr}, Math, Object, Float32Array, Uint8Array, Array, Number, Infinity, NaN};
  ctx.window.THREE = ctx.THREE; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../www/js/render/endmill-geometry.js'), 'utf8'), ctx);
  return ctx.window.Tool3D._render.geometry;
}

// 1) scale bar + magnification reproduce the real reference microscope screens (reference json in the dataset folder)
{
  const b300 = P.scaleBar(2940, 320), b100 = P.scaleBar(980, 260);
  check('scale bar X300 = 100 um', b300.um === 100 && Math.abs(b300.px - 294) < 1, JSON.stringify(b300));
  check('scale bar X100 = 250 um', b100.um === 250 && Math.abs(b100.px - 245) < 1, JSON.stringify(b100));
  for (const [ppm, want] of [[192, 20], [980, 100], [2940, 300], [9600, 1000]]) check(`magnification ${want}`, P.magnification(ppm, 2880).mag === want, P.magnification(ppm, 2880).label);
  const ref = 'C:/agent_research_team/datasets/toolwear/reference/keyence.json';
  if (fs.existsSync(ref)) {
    const K = JSON.parse(fs.readFileSync(ref, 'utf8')), sized = K.images.filter(i => i.pxPerMm && i.size[0] === 2880);
    check('reference magnification labels', sized.every(i => P.magnification(i.pxPerMm, 2880).label === i.mag.split(' ')[0]), sized.map(i => i.mag + '->' + P.magnification(i.pxPerMm, 2880).label).join(' '));
    check('reference VB spot values', K.vbValuesUm.VB_X300 === 90.34 && K.vbValuesUm.VB_X100 === 123.51);
  } else console.log('SKIP  reference json not on this machine');
}

// synthetic metro rows: 100 rows of 0.01 mm, VB 0 for z < .1, ramp to .2 mm, 0 from z = .8; band columns around edge x = 50
const rows = {dz: .01, vb: new Float32Array(100), A: new Float32Array(100), B: new Float32Array(100)};
for (let r = 0; r < 100; r++) { const z = (r + .5) * .01; rows.vb[r] = z < .1 || z > .8 ? 0 : Math.min(.2, .05 + z * .2); rows.A[r] = 50.5; rows.B[r] = 49.5 + (rows.vb[r] > 0 ? 10 : 0); }

// 2) VB arrows + VB(u) statistics
{
  const L = P.vbLines(rows, 'a', 20, {n: 5, helixDeg: 30}), mx = L.find(l => l.isMax);
  check('vb lines: 5..6 arrows incl. max', L.length >= 5 && L.length <= 6 && !!mx, L.map(l => l.vbUm).join(','));
  near('vb line max = 200 um', mx.vbUm, 200, .01);
  check('vb line geometry (edge on a, front on b)', L.every(l => l.xEdge === 50 && l.xFront === 60 && l.y === 20 + l.r + .5));
  const pr = P.vbProfileU(rows, 30), st = P.vbStats(pr);
  near('u = z / cos(helix)', pr[99].uMm, .995 / Math.cos(Math.PI / 6), 1e-3);
  near('stats VBmax', st.maxUm, 200, .01);
  near('stats worn length', st.wornMm, 70 * .01 / Math.cos(Math.PI / 6), .002);
}

// 3) edge defects: flank recession + defects, and the instrument's own definition on a 3-defect profile
{
  const E = P.edgeProfile(rows, {clearanceDeg: 8, rakeDeg: 8, helixDeg: 30}), q = P.edgeDefects(E, 5), h = 200 * Math.tan(8 * Math.PI / 180);
  near('Ddmax = -VBmax tan(clearance)', q.Ddmax, -h, .02);
  check('one defect over the worn span', q.Nd === 1, JSON.stringify(q.defects.map(d => [d.u0Um, d.u1Um])));
  near('Ldcmax = VB / cos(a)', q.Ldcmax, 200 / Math.cos(8 * Math.PI / 180), .02);
  near('Ldrmax = h / cos(g)', q.Ldrmax, h / Math.cos(8 * Math.PI / 180), .02);
  const vol = E.area.reduce((s, a) => s + a * E.du, 0);
  near('Vdmax = wedge volume', q.Vdmax, vol, 2);
  // reference definition: Pd = (L1+L2+L3)/L, Ldmax / Ldmean, Ddmax = min(Di)
  const D = [], n = 200; for (let i = 0; i < n; i++) D.push(i >= 20 && i < 50 ? -10 : i >= 80 && i < 130 ? -(15 + (i === 100 ? 5 : 0)) : i >= 160 && i < 180 ? -8 : -1);
  const A = {du: 10, D, u: D.map((_, i) => (i + .5) * 10), area: D.map(d => -d), ldc: D.map(d => -2 * d), ldr: D.map(d => -3 * d), corner: D.map(() => 0)}, q2 = P.edgeDefects(A, 5);
  check('3 defects', q2.Nd === 3, JSON.stringify(q2.defects.map(d => d.LUm)));
  near('Pd = (300+500+200)/2000', q2.Pd, 50, 1e-6);
  near('Ldmax', q2.Ldmax, 500, 1e-6); near('Ldmean', q2.Ldmean, 1000 / 3, .01); near('Ddmax', q2.Ddmax, -20, 1e-6);
  near('Ddmean = mean over defect positions', q2.Ddmean, (30 * -10 + 49 * -15 - 20 + 20 * -8) / 100, .01);
  near('Vdrel = sum Vd / L', q2.Vdrel, (300 * 10 + (49 * 15 + 20) * 10 + 160 * 10) / 2000, .01);
  // corner damage (tip) becomes a defect at the tip
  const Et = P.edgeProfile(rows, {tipMm: .05, cornerMm: 1}), qt = P.edgeDefects(Et, 5);
  check('corner damage defect at the tip', qt.defects[0].corner && qt.defects[0].u0Um === 0 && qt.Ddmax <= -49.99, JSON.stringify(qt.defects[0]));
}

// 4) wedge cross section
{
  const w = P.wedgeSection(.2, {clearanceDeg: 8, rakeDeg: 8}), h = .2 * Math.tan(8 * Math.PI / 180);
  near('section recession h', w.hMm, h, 1e-4);
  check('worn land point (-VB, -h)', Math.abs(w.worn[2][0] + .2) < 1e-9 && Math.abs(w.worn[2][1] + h) < 1e-9);
  near('wedge angle', w.wedgeDeg, 74, 1e-6);
}

// 5) WearMeasurementModule deviation on the model (map3d mock faces on the parametric layout)
{
  const G = loadGeometry(), D = 10, k = 4, L = G.layout({flutes: k, diameterMm: D}), faces = M.mock(k, D, 40, L);
  const r = M.evaluate(faces, {diameterMm: D, flutes: k, helixDeg: L.q.helixDeg, cornerRadiusMm: L.q.cornerRadiusMm, layout: L});
  const look = M.toothLookup(L), o = {clearanceDeg: L.q.clear1Deg, helixDeg: L.q.helixDeg, landMm: L.land1Mm + L.land2Mm};
  const dev = P.deviationAtlas(r.atlas, look, o), S = r.atlas.side;
  let fmin = 0, fvol = 0; for (let j = 0; j < dev.side.length; j++) if (S.cls[j] === 2) { fmin = Math.min(fmin, dev.side[j]); fvol += -dev.side[j] * S.cellArea; }
  const vbMaxT = Math.max(...r.perTooth.map(p => p.vbMaxMm));
  near('flank Dmin = -VBmax tan(clearance) (mm)', fmin, -vbMaxT * Math.tan(L.q.clear1Deg * Math.PI / 180), .003);
  // map3d integrates the wedge from s = 0; cells only exist from the first sampled cell centre (~1 cell short) -> within 12 %
  near('flank deviation volume = map3d flank volume (rel)', fvol / r.totals.flank.volumeMm3, 1, .12);
  const w = P.devStats(dev, 10);
  near('Dmin = -max chip depth', w.DminUm, -r.totals.chip.maxDepthMm * 1000, .6);
  near('Vv = flank + chip volume', w.VvMm3, fvol + r.totals.chip.volumeMm3, .002);
  check('Vdv <= Vv, Vp = 0 (adhesion thickness unknown)', w.VdvMm3 <= w.VvMm3 && w.VpMm3 === 0 && w.DmaxUm === 0, JSON.stringify(w));
  const pf = P.perFace(dev, r.faces, r.atlas.azSign, 10);
  check('per-face rows (4 sides + top)', pf.length === 5 && pf[4].kind === 'top' && pf.slice(0, 4).every(f => f.VvMm3 > 0), pf.map(f => f.face + ':' + f.VvMm3).join(' '));
  const chips = P.chipList(r.atlas, look, {helixDeg: L.q.helixDeg}), ca = chips.reduce((s, c) => s + c.areaMm2, 0);
  near('chip list area = map3d chip area', ca, r.totals.chip.areaMm2, .002);
  check('chip list: side corner chip on tooth 1 + end chip', chips.some(c => c.where === 'side' && c.tooth === 0 && c.z0Mm === 0) && chips.some(c => c.where === 'end'), JSON.stringify(chips.map(c => [c.where, c.tooth, c.areaMm2, c.maxDepthUm])));
  near('devAt side lookup = atlas', P.devAt(dev, Math.cos(1), Math.sin(1), .5, 'side'), dev.side[Math.floor(.5 / dev.dz) * dev.NA + Math.floor(1 / dev.dA)], 1e-9);
}

// 6) tolerance + trend + CSV
{
  const t = P.tolerance({vbMaxMm: .25, ddMaxUm: -35, pdPct: 40, chipDepthUm: null, vdvMm3: .001}, {vbMaxMm: .3, ddMaxUm: 30});
  check('tolerance: Ddmax fails, rest pass, unmeasured skipped', t.pass === false && t.failed.join() === 'ddMaxUm' && t.rows[3].pass === null);
  const tr = P.trend([{vbMax: .1}, {vbMax: .15}, {vbMax: .2}], .3);
  near('trend slope per measurement', tr.slope, .05, 1e-9); near('trend reaches limit at #5', tr.xAtLimit, 5, 1e-6); near('remaining', tr.remaining, 2, 1e-6);
  const tm = P.trend([{vbMax: .1, cutMin: 10}, {vbMax: .2, cutMin: 30}], .3);
  check('trend by cutting minutes', tm.per === 'min' && Math.abs(tm.xAtLimit - 50) < 1e-6);
  const store = {v: null, getItem() { return this.v; }, setItem(k, v) { this.v = v; }};
  P.historyAdd(store, 'T1', {vbMax: .1}); P.historyAdd(store, 'T1', {vbMax: .2});
  check('post history per tool', P.history(store, 'T1').length === 2 && P.history(store, 'T2').length === 0);
  const pr = P.vbProfileU(rows, 30), E = P.edgeProfile(rows, {}), fl = {i: 0, lines: P.vbLines(rows, 'a', 0), stats: P.vbStats(pr), eq: P.edgeDefects(E), pxPerMm: 40, mag: P.magnification(40, 400)};
  const csv = P.csvRows({o: Object.assign({}, P.DEFAULTS), flutes: [fl], devStats: null, faces: [], chips: [], tol: t, trend: tr, vbMaxMm: .2, vbMeanMm: .1});
  check('csv sections', !/keyence|edgequality/i.test(csv) && /edge_defects_flute,Nd,L_um,Pd_%/.test(csv) && /tolerance,value/.test(csv) && /trend_per/.test(csv), csv.split('\r\n').length + ' lines');
}

// 7) one design with wear-post.js: measured per-side edge metrics replace the wedge model, Ldr / Vd stay modelled
{
  const WP = require('../../www/js/wear/wear-post.js'), w = 400, h = 300, ppm = 100, m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const e = y > 100 && y < 140 ? 6 : 0; m[y * w + x] = x < 50 + e ? 0 : x < 70 ? 2 : 1; }   // edge x=50, land 0.20 mm, chip 0.06 x 0.40 mm
  const wp = WP.analyze({mask: m, w, h, pxPerMm: ppm, edge: 'background'}), eq = P.edgeDefects(P.edgeProfile(rows, {}));
  const q = P.mergeEdge(eq, {refLine: wp.refLine, edgeDev: wp.edgeDev, lengthMm: wp.lengthMm, edgeSide: wp.edgeSide});
  check('merge: source wear-post, Nd 1, Ddmax -60 um, Ldmax 400 um', q.source === 'wear-post' && q.Nd === 1 && Math.abs(q.Ddmax + 60) <= 15 && Math.abs(q.Ldmax - 400) <= 30, `${q.Nd} ${q.Ddmax} ${q.Ldmax}`);
  check('merge: Ldr and Vdrel stay from the wedge model', q.Ldrmax === eq.Ldrmax && q.Vdrel === eq.Vdrel && q.measured.includes('Pd') && !q.measured.includes('Ldrmax'));
  check('merge: reference line VB 200 um, recession 60 um', Math.abs(q.refLine.VBmaxUm - 200) <= 15 && Math.abs(q.refLine.recessionUm - 60) <= 15, `${q.refLine.VBmaxUm} ${q.refLine.recessionUm}`);
  check('merge: no wear-post -> model', P.mergeEdge(eq, null).source === 'model' && P.mergeEdge(eq, null).Ddmax === eq.Ddmax);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
