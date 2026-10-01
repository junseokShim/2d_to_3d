// measurement-panel helpers (www/js/metro/metro-vb.js): scale bar, magnification, reference line, VB dimension lines,
// positions, statistics, tolerance, trend, end-face wear area per tooth, CSV sections. Run: node test/metro/vb.js
'use strict';
const fs = require('fs'), path = require('path');
const V = require('../../www/js/metro/metro-vb.js'), W = require('../../www/js/wear/wear-core.js'), readPng = require('../wear/png.js');

let pass = 0, fail = 0;
const near = (name, got, want, tol) => { const ok = Math.abs(got - want) <= tol; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got} want ${want} +-${tol}`); ok ? pass++ : fail++; };
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };

// 1) scale bar + equivalent magnification match the reference microscope screens (2880 px wide; bar lengths read off them)
{
  const b300 = V.scaleBar(2940, 320), b100 = V.scaleBar(980, 260);
  check('scale bar at 2940 px/mm = 100 um', b300.um === 100 && Math.abs(b300.px - 294) < 1, JSON.stringify(b300));
  check('scale bar at 980 px/mm = 250 um', b100.um === 250 && Math.abs(b100.px - 245) < 1, JSON.stringify(b100));
  for (const [ppm, want] of [[192, 20], [980, 100], [2940, 300], [9600, 1000]]) check(`magnification x${want}`, V.magnification(ppm, 2880).mag === want, V.magnification(ppm, 2880).label);
}

// synthetic rows: 100 rows of 0.01 mm, VB 0 for z < .1 and z > .8, ramp to .2 mm; edge column x = 50 ('a' side), front at 60
const rows = {dz: .01, vb: new Float32Array(100), A: new Float32Array(100), B: new Float32Array(100)};
for (let r = 0; r < 100; r++) { const z = (r + .5) * .01; rows.vb[r] = z < .1 || z > .8 ? 0 : Math.min(.2, .05 + z * .2); rows.A[r] = 50.5; rows.B[r] = 49.5 + (rows.vb[r] > 0 ? 10 : 0); }

// 2) reference line + VB dimension lines
{
  const L = V.refLine(rows, 'a', 20);
  check('reference line fitted on the unworn edge rows', L.from === 'unworn' && L.fitRows === 30 && Math.abs(L.a - 50) < 1e-9 && L.b === 0 && L.residualPx === 0, JSON.stringify({a: L.a, b: L.b, n: L.fitRows}));
  const ln = V.vbLines(rows, 'a', 20, {n: 5, helixDeg: 30, ref: L}), mx = ln.find(l => l.isMax);
  check('5..6 dimension lines incl. the maximum', ln.length >= 5 && ln.length <= 6 && !!mx, ln.map(l => l.vbUm).join(','));
  near('max line = 200 um', mx.vbUm, 200, .01);
  check('line geometry: edge 50 -> front 60, reference foot on x = 50', ln.every(l => l.xEdge === 50 && l.xFront === 60 && l.xRef === 50 && l.foot[0] === 50 && Math.abs(l.foot[1] - l.y) < 1e-9));
  // tilted edge: the fit follows it
  const t = {dz: .01, vb: new Float32Array(40), A: new Float32Array(40), B: new Float32Array(40)};
  for (let r = 0; r < 40; r++) { t.A[r] = 30.5 + .25 * r; t.B[r] = t.A[r] - 1; }
  const Lt = V.refLine(t, 'a', 0); near('tilted edge slope', Lt.b, .25, 1e-9);
  const pr = V.profileU(rows, 30), st = V.stats(pr);
  near('u = z / cos(helix)', pr[99].uMm, .995 / Math.cos(Math.PI / 6), 1e-3);
  near('stats VBmax', st.maxUm, 200, .01);
  near('stats worn length', st.wornMm, 70 * .01 / Math.cos(Math.PI / 6), .002);
}

// 3) ISO quantity positions (values passed through from evaluate().q)
{
  const q = {vbMax: {v: .2, U: .01}, vbb: {v: .15, U: .01}, vbbMax: {v: .2, U: .01}, vbc: {v: 0, U: .01}, vbn: {v: .16, U: .01}};
  const P = V.positions({rows, zones: {cornerMm: .1, apMm: .5, notchHalfMm: .05}, q, zAtMaxMm: .755, tipMm: 0, vbSource: 'flank (VB)'});
  check('VBmax value + position from evaluate', P.vbMax.v === .2 && P.vbMax.zMm === .755);
  check('VBC: no wear in zone C -> no position', P.vbc.zMm === null && P.vbc.v === 0);
  near('VBN position = last worn row inside ap +- 0.05', P.vbn.zMm, .545, 1e-9);
  check('VBB span over the worn zone-B rows', P.vbb.span && P.vbb.span[0] === .1 && P.vbb.span[1] === .81, JSON.stringify(P.vbb.span));
  const Pt = V.positions({rows, zones: {cornerMm: .1, apMm: .5, notchHalfMm: .05}, q: Object.assign({}, q, {vbMax: {v: .4, U: .01}, vbc: {v: .4, U: .01}}), zAtMaxMm: .755, tipMm: .4, vbSource: 'corner/tip (VBC)'});
  check('tip damage: VBmax and VBC at the tip (z 0)', Pt.vbMax.zMm === 0 && Pt.vbc.zMm === 0);
}

// 4) tolerance + trend
{
  const t = V.tolerance({vbMaxMm: .25, vbbMaxMm: .55, vbcMm: null, topWornMm2: .1}, {vbMaxMm: .3});
  check('tolerance: VBB max fails, VBC unmeasured, end face passes', t.pass === false && t.failed.join() === 'vbbMaxMm' && t.rows[2].pass === null && t.rows[3].pass === true);
  const tr = V.trend([{vbMax: .1}, {vbMax: .15}, {vbMax: .2}], .3);
  near('trend slope per measurement', tr.slope, .05, 1e-9); near('trend reaches the limit at #5', tr.xAtLimit, 5, 1e-6); near('remaining', tr.remaining, 2, 1e-6);
}

// 5) end-face area: synthetic 4-tooth end face, teeth centred at 20 + j*90 deg, gullies between, worn pixels on teeth 2 and 4
{
  const w = 300, h = 300, cx = 150, cy = 150, R = 100, k = 4, ph = 20, cls = new Uint8Array(w * h);
  const want = {land: [0, 0, 0, 0], flank: [0, 0, 0, 0], chip: [0, 0, 0, 0]};
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = x + .5 - cx, dy = cy - (y + .5), r = Math.hypot(dx, dy); if (r >= R) continue;
    const a = (Math.atan2(dy, dx) * 180 / Math.PI - ph + 360) % 360, j = Math.round(a / 90) % 4, off = Math.abs(a - 90 * Math.round(a / 90));
    if (off > 30 && r > 25) continue;                                   // gully
    let c = 1; if (j === 1 && r > 80 && off < 12) c = 2; if (j === 3 && r > 88 && off < 6) c = 3;
    cls[y * w + x] = c; want.land[j]++; if (c === 2) want.flank[j]++; if (c === 3) want.chip[j]++;
  }
  const ppm = 50, a = V.endFaceArea({w, h, cls, cx, cy, rPx: R, pxPerMm: ppm}, k);
  near('tooth phase found from the outer ring', a.phaseDeg, ph, .5);
  check('per-tooth land area = tool pixels of the sector', a.teeth.every((t, j) => Math.abs(t.landMm2 - want.land[j] / ppm / ppm) < 2e-3), a.teeth.map(t => t.landMm2).join(' '));
  check('worn area tooth 2 (flank) and tooth 4 (chipping), none elsewhere', Math.abs(a.teeth[1].flankMm2 - want.flank[1] / ppm / ppm) < 1e-4 && Math.abs(a.teeth[3].chippingMm2 - want.chip[3] / ppm / ppm) < 1e-4 && a.teeth[0].wornMm2 === 0 && a.teeth[2].wornMm2 === 0,
    a.teeth.map(t => t.wornMm2).join(' '));
  near('total worn area mm2', a.total.wornMm2, (want.flank[1] + want.chip[3]) / ppm / ppm, 2e-4);
  check('largest worn tooth = 2', a.maxTooth === 2);
  near('rim depth of tooth 2 = 0.4 mm (r > 80 of 100 px)', a.teeth[1].rimDepthMm, .4, .03);
  // network mask on its own grid (2.8 R window, netD px = diameter) laid onto the photo grid
  const netD = 100, S = 140, f = {w: S, h: S, netD, mask: new Uint8Array(S * S)};
  for (let Y = 0; Y < S; Y++) for (let X = 0; X < S; X++) { const x = (X + .5 - S / 2) * 2, y = (Y + .5 - S / 2) * 2, r = Math.hypot(x, y); if (r < R) f.mask[Y * S + X] = r > 90 ? 3 : 1; }
  const merged = V.mergeNet({w, h, cls, cx, cy, rPx: R, pxPerMm: ppm}, f), b = V.endFaceArea(merged, k);
  let ring = 0; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const r = Math.hypot(x + .5 - cx, y + .5 - cy); if (r < R && r > 90 && cls[y * w + x]) ring++; }
  near('network classes replace the photo rule (rim ring = chipping on the land)', b.total.chippingMm2, ring / ppm / ppm, .03 * ring / ppm / ppm);
  check('network merge: no flank left from the photo rule', b.total.flankMm2 === 0 && merged.source === 'network');
}

// 6) brightness rule = the wear engine's end-face bright area (same threshold, same pixels) on the sample top photo
{
  const top = path.join(__dirname, '../wear/samples/top.png');
  if (fs.existsSync(top)) {
    const img = readPng(top), T = W.analyzeTop(img, {diameterMm: 10}), c = V.classesFromGray(W.gray(img), T), a = V.endFaceArea(c, 4);
    near('end-face worn total = wear engine endBrightAreaMm2', a.total.wornMm2, T.endBrightAreaMm2, Math.max(2e-4, .01 * T.endBrightAreaMm2));
    check('land within the end-face circle', a.total.landMm2 > 0 && a.total.landMm2 <= Math.PI * 25 * 1.07, String(a.total.landMm2));
  } else console.log('SKIP  test/wear/samples/top.png missing');
}

// 7) CSV sections
{
  const s = {vb: [{pos: {vbMax: {v: .2, zMm: .7}, vbb: {v: .1, span: [.1, .8]}, vbbMax: {v: .2, zMm: .7}, vbc: {v: 0, zMm: null}, vbn: {v: .1, zMm: .5}}, lines: [{n: 1, zMm: .1, uMm: .12, vbUm: 50, isMax: false}],
    stats: {maxUm: 200, meanUm: 100, minUm: 50, sdUm: 10, medianUm: 100, wornMm: .7, wornPct: 70, lengthMm: 1}, mag: '×100', umPerPx: 1, ref: {angleDeg: 0, residualPx: 0, from: 'unworn'}}],
    endFace: {source: 'network', teeth: [{tooth: 1, centreDeg: 20, landMm2: 1, wornMm2: .1, flankMm2: .1, chippingMm2: 0, adhesionMm2: 0, wornPct: 10, rimDepthMm: .2}], total: {landMm2: 1, wornMm2: .1, flankMm2: .1, chippingMm2: 0, adhesionMm2: 0, wornPct: 10}},
    tolerance: V.tolerance({vbMaxMm: .2, topWornMm2: .1}, {})};
  const t = V.csvSections(s);
  check('csv: positions, lines, stats, end face, tolerance', /vb_position_flute,VBmax_mm,VBmax_z_mm/.test(t) && /vb_line_flute/.test(t) && /vb_stats_flute/.test(t) && /end_face_tooth,centre_deg,land_mm2,worn_mm2/.test(t) && /\r\ntotal,,1,0.1/.test(t) && /topWornMm2,0.1,0.5,mm2,PASS/.test(t), t.split('\r\n').length + ' lines');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
