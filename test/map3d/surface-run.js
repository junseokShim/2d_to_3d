// surface-metrology tests (section ③ 3D evaluations): deviation vs nominal, volumes, per flute, edge section, profile,
// tolerance, trend. Known synthetic map3d faces on the parametric model. Run: node test/map3d/surface-run.js
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const M = require('../../www/js/map3d/map3d-core.js'), P = require('../../www/js/map3d/surface-metrology.js');

let pass = 0, fail = 0;
const near = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${(+got).toFixed(5)} want ${(+want).toFixed(5)} +-${tol}`); ok ? pass++ : fail++; };
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };

function loadGeometry() {
  class Attr { constructor(a, n) { this.array = a instanceof Float32Array ? a : new Float32Array(a); this.itemSize = n; } }
  class Geo { setAttribute(k, v) { this[k] = v; } getAttribute(k) { return this[k]; } setIndex(i) { this.index = {array: i}; } getIndex() { return this.index; } computeVertexNormals() {} }
  const ctx = {window: {}, THREE: {BufferGeometry: Geo, BufferAttribute: Attr, Float32BufferAttribute: Attr}, Math, Object, Float32Array, Uint8Array, Array, Number, Infinity, NaN};
  ctx.window.THREE = ctx.THREE; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../www/js/render/endmill-geometry.js'), 'utf8'), ctx);
  return ctx.window.Tool3D._render.geometry;
}

// 1) edge section: wedge geometry and the equivalent edge radius (incircle of the removed triangle)
{
  const vb = .2, a = 8 * Math.PI / 180, g = 8 * Math.PI / 180, w = P.edgeSection(vb, {clearanceDeg: 8, rakeDeg: 8}), h = vb * Math.tan(a);
  near('recession h = VB tan(clearance) (um)', w.recessionUm, h * 1000, .01);
  near('worn land end on the clearance face at x = -VB', w.worn[2][0], -vb, 1e-9);
  near('wedge angle', w.wedgeDeg, 74, 1e-6);
  const base = vb - h * Math.tan(g), tR = h / Math.cos(g), tC = vb / Math.cos(a), r = (base * h) / (tR + tC + base);
  near('equivalent edge radius = 2A / perimeter (um)', w.edgeRadiusUm, r * 1000, .01);
  // incircle centre is r away from the land line y = -h
  near('incircle tangent to the land', Math.abs(w.centre[1] + h), r, 1e-6);
  check('sharp edge: radius 0', P.edgeSection(0).edgeRadiusUm === 0);
  check('radius grows with VB', P.edgeSection(.3).edgeRadiusUm > P.edgeSection(.1).edgeRadiusUm);
}

// 2) deviation + volumes + per flute on the model (map3d mock faces on the parametric layout)
const G = loadGeometry(), D = 10, k = 4, L = G.layout({flutes: k, diameterMm: D}), faces = M.mock(k, D, 40, L);
const r = M.evaluate(faces, {diameterMm: D, flutes: k, helixDeg: L.q.helixDeg, cornerRadiusMm: L.q.cornerRadiusMm, layout: L});
const look = M.toothLookup(L), o = {clearanceDeg: L.q.clear1Deg, helixDeg: L.q.helixDeg, landMm: L.land1Mm + L.land2Mm};
const dev = P.deviation(r.atlas, look, o), S = r.atlas.side;
{
  let fmin = 0, fvol = 0; for (let j = 0; j < dev.side.length; j++) if (S.cls[j] === 2) { fmin = Math.min(fmin, dev.side[j]); fvol += -dev.side[j] * S.cellArea; }
  const vbMaxT = Math.max(...r.perTooth.map(p => p.vbMaxMm));
  near('flank Dmin = -VBmax tan(clearance) (mm)', fmin, -vbMaxT * Math.tan(L.q.clear1Deg * Math.PI / 180), .003);
  near('flank deviation volume = map3d flank volume (rel)', fvol / r.totals.flank.volumeMm3, 1, .12);
  const w = P.volumeStats(dev, 10);
  near('Dmin = -max chip depth (um)', w.DminUm, -r.totals.chip.maxDepthMm * 1000, .6);
  near('Vv = flank + chip volume', w.VvMm3, fvol + r.totals.chip.volumeMm3, .002);
  check('Vdv <= Vv, Vp = 0 (adhesion thickness unknown)', w.VdvMm3 <= w.VvMm3 && w.VpMm3 === 0 && w.DmaxUm === 0, JSON.stringify(w));
  near('dev.minMm = Dmin', dev.minMm * 1000, w.DminUm, .01);
  const pf = P.perFace(dev, r.faces, r.atlas.azSign, 10);
  check('per-face rows (4 sides + top)', pf.length === 5 && pf[4].kind === 'top' && pf.slice(0, 4).every(f => f.VvMm3 > 0), pf.map(f => f.face + ':' + f.VvMm3).join(' '));
  const lookEnd = M.toothLookup(Object.assign({}, L, {tanH: 0}));
  const fl = P.perFlute(dev, r.atlas, look, L, r.perTooth, Object.assign({lookEnd, rakeDeg: L.q.rakeDeg}, o));
  check('per flute rows = flutes', fl.length === k);
  near('sum of per-flute wear volume = Vv', fl.reduce((s, f) => s + f.volumeMm3, 0), w.VvMm3, .002);
  near('sum of per-flute worn area = flank + chip area', fl.reduce((s, f) => s + f.wornAreaMm2, 0), r.totals.flank.areaMm2 + r.totals.chip.areaMm2, .01);
  check('per-flute VBmax = map3d perTooth (um)', fl.every((f, t) => Math.abs(f.vbMaxUm - r.perTooth[t].vbMaxMm * 1000) < .01), fl.map(f => f.vbMaxUm).join(','));
  check('per-flute edge radius from its VBmax', fl.every((f, t) => Math.abs(f.edgeRadiusUm - P.edgeSection(r.perTooth[t].vbMaxMm, Object.assign({rakeDeg: L.q.rakeDeg}, o)).edgeRadiusUm) < 1e-9));
  check('chip depth only on flutes with chips, Dmin <= -chip depth', fl.every(f => f.DminUm <= -f.chipDepthUm + 1e-6));
  const ch = P.chips(r.atlas, look, {helixDeg: L.q.helixDeg}), ca = ch.reduce((s, c) => s + c.areaMm2, 0);
  near('chip list area = map3d chip area', ca, r.totals.chip.areaMm2, .002);
  check('chip list: side corner chip on tooth 1 + end chip', ch.some(c => c.where === 'side' && c.tooth === 0 && c.z0Mm === 0) && ch.some(c => c.where === 'end'));
  near('devAt side lookup = atlas', P.devAt(dev, Math.cos(1), Math.sin(1), .5, 'side'), dev.side[Math.floor(.5 / dev.dz) * dev.NA + Math.floor(1 / dev.dA)], 1e-9);
}

// 3) nominal radius + section profile
{
  const rN = P.nominalRadius(L), R = D / 2;
  let rMax = 0, rMin = 1e9; for (let i = 0; i < 720; i++) { const v = rN(i / 720 * 2 * Math.PI, 3); rMax = Math.max(rMax, v); rMin = Math.min(rMin, v); }
  near('nominal radius max = D/2', rMax, R, .01);
  check('nominal radius min near the core (flute pocket)', rMin < R * (L.q.coreRatio + .08) && rMin > R * (L.q.coreRatio - .08), rMin.toFixed(3));
  // twist: the section at z is the tip section rotated by tanH z
  near('helix twist', rN(1 + L.tanH * 4, 4), rN(1, 0), 1e-3);
  near('shank radius', rN(0, L.q.fluteLenMm + L.q.runoutMm + 1), L.q.shankDiaMm / 2, 1e-9);
  // circumferential profile around the tool at z = 1 mm crosses every flute: height range = R - core region
  const th0 = 0, pr = P.profile({p0: [R * Math.cos(th0), R * Math.sin(th0), 1], p1: [R * Math.cos(th0 + 3), R * Math.sin(th0 + 3), 1], rNom: rN, dev, part: 'side', n: 300});
  check('profile points + length', pr.points.length === 300 && pr.lengthMm > 3 * R * .5, pr.lengthMm + ' mm');
  check('profile measured = nominal + deviation', pr.points.every(p => Math.abs(p.measuredMm - (p.nominalMm + p.devUm / 1000)) < 2e-4));
  check('profile height range > 1 mm (flute pockets)', pr.heightRangeMm > 1, pr.heightRangeMm);
  // along the axis on tooth 1's flank wear (z 0..3 mm right behind the edge) the deviation is negative somewhere
  const edge = L.cols.find(c => c.tooth === 0 && c.s >= 0 && c.s < .01) || L.cols[0], a0 = Math.atan2(edge.y, edge.x);
  const axial = P.profile({p0: [R * Math.cos(a0), R * Math.sin(a0), 0], p1: [R * Math.cos(a0 + L.tanH * 3), R * Math.sin(a0 + L.tanH * 3), 3], rNom: rN, dev, part: 'side', n: 120});
  check('profile along the edge sees wear (devMin < 0)', axial.devMinUm < 0, axial.devMinUm + ' um');
  const ep = P.profile({p0: [-2, 0, 0], p1: [2, 0, 0], endZ: L.endZ, dev, part: 'end', n: 50});
  check('end-face profile: measured = nominal - deviation (into the tool)', ep.part === 'end' && ep.points.every(p => Math.abs(p.measuredMm - (p.nominalMm - p.devUm / 1000)) < 2e-4));
}

// 4) tolerance + trend
{
  const t = P.tolerance({devMaxUm: 70, chipDepthUm: 20, vdvMm3: null, wearVolumeMm3: .01});
  check('tolerance: deviation fails, rest pass, unmeasured skipped', t.pass === false && t.failed.join() === 'devMaxUm' && t.rows[2].pass === null);
  const tr = P.trend([{volumeMm3: .01}, {volumeMm3: .02}, {volumeMm3: .03}], .05);
  near('trend slope per measurement', tr.slope, .01, 1e-9); near('trend reaches limit at #5', tr.xAtLimit, 5, 1e-6); near('remaining', tr.remaining, 2, 1e-6);
  const store = {v: null, getItem() { return this.v; }, setItem(_, v) { this.v = v; }};
  P.historyAdd(store, 'T1', {volumeMm3: .1}); P.historyAdd(store, 'T1', {volumeMm3: .2});
  check('history per tool', P.history(store, 'T1').length === 2 && P.history(store, 'T2').length === 0);
}

// 6) photo map: each side view painted one colour -> texels facing a view take its colour; view geometry = map3d convention
{
  const PM = require('../../www/js/map3d/photo-map.js'), rN = P.nominalRadius(L), R = D / 2, ppm = 20, cols = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255]];
  const views = cols.map((c, i) => { const w = Math.ceil(2.4 * R * ppm), h = Math.ceil(12 * ppm) + 10, rgb = new Uint8Array(w * h * 3), g = new Float32Array(w * h).fill(100);
    for (let q = 0; q < w * h; q++) rgb.set(c, 3 * q); return {rgb, g, w, h, axisX: w / 2, tipY: 10, ppm, angleDeg: i * 90}; });
  const m = PM.build({views, top: null, rNom: rN, R, azSign: -1});
  check('photo map built, coverage > 0.9', m && m.coverage > .9, m && m.coverage.toFixed(3));
  const at = (th, z) => { const S = m.side, j = Math.floor(((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) / (2 * Math.PI) * S.NA), i = Math.floor(z / S.zMax * S.NZ), q = 4 * (i * S.NA + j); return [S.data[q], S.data[q + 1], S.data[q + 2], S.data[q + 3]]; };
  // view i looks at model azimuth -90 i deg (azSign -1): the envelope there is red / green / blue / white
  const ok = [0, 1, 2, 3].every(i => { const c = at(-i * Math.PI / 2 + .01, 6), a = c[3] / 255 || 1, want = cols[i]; return c.slice(0, 3).every((v, k) => Math.abs(v / a - want[k]) < 40); });
  check('texel facing view i takes view i colour', ok, JSON.stringify([0, 1, 2, 3].map(i => at(-i * Math.PI / 2 + .01, 6))));
  // a column offset in the image lands at the matching azimuth: paint the right half of view 0 black -> theta slightly negative (image right) dark
  const v0 = views[0]; for (let y = 0; y < v0.h; y++) for (let x = Math.ceil(v0.axisX); x < v0.w; x++) v0.rgb.set([0, 0, 0], 3 * (y * v0.w + x));
  const m2 = PM.build({views, top: null, rNom: rN, R, azSign: -1}), S2 = m2.side, at2 = th => { const j = Math.floor(((th + 2 * Math.PI) % (2 * Math.PI)) / (2 * Math.PI) * S2.NA), i = Math.floor(6 / S2.zMax * S2.NZ); return S2.data[4 * (i * S2.NA + j)]; };
  check('image right of the axis = model azimuth below the view azimuth (map3d convention)', at2(-.3) < 60 && at2(.3) > 150, at2(-.3) + ' / ' + at2(.3));
}

// 5) shipped code carries no third-party product names
{
  const bad = /keyence|alicona|vhx|infinite\s*focus|sandvik|edge\s*quality/i, dirs = ['www/js/render', 'www/js/map3d'].map(d => path.join(__dirname, '../..', d));
  const hits = dirs.flatMap(d => fs.readdirSync(d).filter(f => bad.test(fs.readFileSync(path.join(d, f), 'utf8'))));
  check('render + map3d sources are vendor-neutral', !hits.length, hits.join(' '));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
