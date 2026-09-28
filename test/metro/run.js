// Metrology core tests. Run: node test/metro/run.js   (no dependencies)
'use strict';
const path = require('path');
const W = require('../../www/js/wear/wear-core.js'), M = require('../../www/js/metro/metro-core.js'), readPng = require('../wear/png.js');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };
const near = (name, got, want, tol) => check(name, Math.abs(got - want) <= tol, `got ${got} want ${want} ±${tol}`);

// 1. unedited metro evaluation == wear-core on the sample tool (4 flutes, D10)
const S = f => readPng(path.join(__dirname, '../wear/samples', f));
const D = 10, {result, debug} = W.measure({sides: ['side1', 'side2', 'side3', 'side4'].map(n => S(n + '.png')), flutes: 4, diameterMm: D});
const cal = M.calibration(debug.sides.map(s => s && s.align), D);
check('calibration diameter scale', cal.method === 'diameter' && cal.pxPerMm > 0 && cal.uRel > 0 && cal.uRel < .05, JSON.stringify({ppm: cal.pxPerMm, uRel: cal.uRel}));
const F = debug.strips.map(e => M.flute(e.strip, e.band, D));
F.forEach((f, i) => {
  const e = M.evaluate(f, {helixDeg: result.helixDeg, uScaleRel: cal.uRel}), w = result.perFlute[i];
  near(`F${i + 1} VBmax == wear-core`, e.vbMaxMm, w.vbMaxMm, 1e-4);
  near(`F${i + 1} VBavg == wear-core`, e.vbAvgMm, w.vbAvgMm, 1e-4);
  near(`F${i + 1} area == wear-core`, e.areaMm2, w.areaMm2, 1e-4);
  near(`F${i + 1} volume == wear-core`, e.volumeMm3, w.volumeMm3, 1e-4);
  check(`F${i + 1} profile == wear-core`, JSON.stringify(e.profile) === JSON.stringify(w.profile), `${e.profile.length} bins`);
  check(`F${i + 1} U>0 and VBmax>=VBB, VBC`, e.q.vbMax.U > 0 && e.q.vbMax.v >= e.q.vbb.v && e.q.vbMax.v >= e.q.vbc.v, JSON.stringify({vbMax: e.q.vbMax, vbc: e.q.vbc.v, vbn: e.q.vbn.v}));
});

// 2. synthetic strip: straight edge at column 50, band 0.2 mm wide (ppm 50 -> 10 px) over the whole zone
const ppm = 50, Dm = 6, R = Dm / 2 * ppm, w = Math.ceil(2 * R) + 40, top = 20, h = top + Math.round(.8 * Dm * ppm) + 40;
const strip = {w, h, g: new Float32Array(w * h), cx: 20 + R - .5, R, top, ppm}, band = new Uint8Array(w * h);
const e0 = Math.round(strip.cx - 8);           // near the axis: foreshortening negligible
for (let y = top; y < h; y++) for (let x = e0; x < e0 + 10; x++) band[y * w + x] = 1;
const G = M.flute(strip, band, Dm), o = {helixDeg: 0};
let r = M.evaluate(G, o);
near('synthetic VBB = 0.2', r.q.vbb.v, .2, .002);
near('synthetic VBmax = 0.2', r.vbMaxMm, .2, .002);
check('synthetic VBN/VBC present', r.q.vbn.v > .19 && r.q.vbc.v > .19);
check('edge side detected', G.edge === 'a' || G.edge === 'b', G.edge);
// 3. drag-to-correct: move the wear-front (non-edge) boundary out by 5 px at every node -> VB + 0.1 mm
const front = G.edge === 'a' ? 'b' : 'a', sgn = front === 'b' ? 1 : -1;
for (let i = 0; i < G.nodeRows.length; i++) M.setNode(G, front, i, 5 * sgn);
r = M.evaluate(G, o);
near('edited VBB = 0.3', r.q.vbb.v, .3, .003);
check('edited flag raises edge sigma', r.edited && r.sigmaPx === M.DEFAULTS.sigmaManualPx);
// one node only -> a local notch at that node
M.resetNodes(G); const mid = G.nodeRows.length >> 1; M.setNode(G, front, mid, 10 * sgn); r = M.evaluate(G, o);
near('single node -> local VBmax ~0.4 (3-row median)', r.vbMaxMm, .4, .02); near('single node -> VBavg < 0.3', Math.min(r.vbAvgMm, .3), r.vbAvgMm, 0);
// 4. caliper: point 10 px right of the edge line -> 0.2 mm
M.resetNodes(G); const ex = M.edgeX(G, 100);
const c = M.caliper(G, [ex + 10 * (G.edge === 'a' ? 1 : -1), top + 100.5], o);
near('caliper perpendicular 0.2', c.perpMm, .2, .003); near('caliper VB-normal 0.2', c.vbMm, .2, .003);
near('2-point distance', M.dist([0, 0], [30, 40], 50), 1, 1e-9);
// 5. uncertainty: VB+U, scale part grows with value, helix part zero at 0 deg
r = M.evaluate(G, {helixDeg: 30, uScaleRel: .01});
check('budget parts', r.q.vbb.parts.scale > 0 && r.q.vbb.parts.edge > 0 && r.q.vbb.parts.helix > 0, JSON.stringify(r.q.vbb));
near('U = 2*sqrt(sum u^2)', r.q.vbb.U, 2 * Math.hypot(...Object.values(r.q.vbb.parts)), 2e-4);
// 6. status / decision rule
check('status green', M.status(.1, .02, .3).light === 'green' && M.status(.1, .02, .3).decision === 'conform');
check('status amber near limit', M.status(.29, .02, .3).light === 'amber' && M.status(.29, .02, .3).decision === 'indeterminate');
check('status red', M.status(.35, .02, .3).light === 'red' && M.status(.35, .02, .3).decision === 'nonconform');
// 7. reference calibration: 100 px over 2 mm = 50 px/mm; strip at 55 px/mm -> scale 1.1
const rc = M.calibration([{pxPerMm: 55}], 10, {}, {px: 100, mm: 2, tolMm: .002});
check('reference calibration', rc.method === 'reference' && rc.pxPerMm === 50 && Math.abs(rc.scaleFor(55) - 1.1) < 1e-9 && rc.uRel > 0, JSON.stringify(rc));
// 8. CSV + PDF + history
const ev = F.map(f => { const e = M.evaluate(f, {helixDeg: result.helixDeg, uScaleRel: cal.uRel}); e.status = M.status(e.q.vbMax.v, e.q.vbMax.U, .3); return e; });
const txt = M.csv({toolId: 'T-1', operator: 'op', date: '2026-09-29', D, k: 4, helixDeg: result.helixDeg, engine: 'classic', calib: cal, limitMm: .3, flutes: ev, manual: [{kind: 'distance', flute: 1, mm: .5, U: .02}]});
check('CSV rows', txt.split('\r\n').filter(l => /^[1-4],/.test(l)).length >= 4 && /VBC_mm/.test(txt) && /manual_measurement/.test(txt));
const P = M.PdfPage(); P.text(40, 40, 'Tool3D (VB) \\ test', 12, {bold: true}); P.rect(40, 60, 100, 20, '#00aa00'); P.line(40, 90, 200, 90);
P.image(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), 1, 1, 40, 100, 10, 10);
const pdf = Buffer.from(M.pdfBytes(P)), ps = pdf.toString('latin1');
const sx = +ps.match(/startxref\n(\d+)/)[1];
check('PDF structure', ps.startsWith('%PDF-1.4') && /\/Count 1/.test(ps) && ps.slice(sx, sx + 4) === 'xref' && /\/DCTDecode/.test(ps) && /%%EOF\n$/.test(ps), pdf.length + ' B');
const offs = [...ps.matchAll(/(\d{10}) 00000 n/g)].map(m => +m[1]);
check('PDF xref offsets point at objects', offs.every((o, i) => ps.slice(o).startsWith(`${i + 1} 0 obj`)));
const mem = {}, store = {getItem: k => mem[k] || null, setItem: (k, v) => { mem[k] = v; }};
M.historyAdd(store, 'T-1', {t: 1, vbMax: .1}); M.historyAdd(store, 'T-1', {t: 2, vbMax: .15}); M.historyAdd(store, 'T-2', {t: 3, vbMax: .3});
check('history per tool id', M.history(store, 'T-1').length === 2 && M.history(store, 'T-2').length === 1 && M.trend(M.history(store, 'T-1')).slope === .05);

// 8. operator-assisted fallback on a degraded photo (low light x0.2: auto band empty): edge line from geometry, then
//    the operator drags the wear boundary to the true front -> VBmax, mode 'operator-assisted', U from the manual sigma
{
  const synth = require('../wear/synth.js'), Dg = require('../wear/degrade.js'), DIA = 10, vbt = z => .3 * (1 - .35 * z / 3), hb = 30 * Math.PI / 180;
  const img = Dg.lowLight(synth.sideReal({w: 420, h: 560, D: DIA, ppm: 20, tiltDeg: 2, axisDx: 0, tipV: -170, helixDeg: 30, flutes: 4, vb: vbt, zoneMm: 3, seed: 11, bg: 'dark'}), .2, 7);
  const {result: R8, debug: d8} = W.measure({sides: [img], flutes: 1, diameterMm: DIA, helixDeg: 30}), st = d8.strips[0] && d8.strips[0].strip;
  check('degraded: silhouette found, auto band empty', !!st && R8.perFlute[0].vbMaxMm === 0, JSON.stringify(R8.perFlute[0].vbMaxMm));
  const F8 = M.assistFlute(st, DIA, {helixDeg: 30, zoneMm: 3}), Rmm = st.R / st.ppm, s0 = -3 * Math.tan(hb) / 2;
  const truthX = r => st.cx + st.R * Math.sin((s0 + (r + .5) / st.ppm * Math.tan(hb)) / Rmm);
  const mid = F8.n >> 1, gx = M.edgeX(F8, mid);
  check('assisted: edge line pre-placed within 2 px of the true edge', F8.assist.guess && Math.abs(gx - truthX(mid)) <= 2, `got ${gx.toFixed(1)} want ${truthX(mid).toFixed(1)} side ${F8.edge}`);
  let e8 = M.evaluate(F8, {helixDeg: 30});
  check('assisted, unconfirmed: mode awaiting-operator, VB 0', e8.mode === 'awaiting-operator' && e8.vbMaxMm === 0, e8.mode);
  const front = F8.edge === 'a' ? 'b' : 'a', sg = front === 'b' ? 1 : -1;
  for (let i = 0; i < F8.nodeRows.length; i++) {
    const r = F8.nodeRows[i], z = (r + .5) / st.ppm, sE = s0 + z * Math.tan(hb), xF = st.cx + st.R * Math.sin((sE + sg * vbt(z) / Math.cos(hb)) / Rmm);
    M.setNode(F8, front, i, xF - M.edgeX(F8, Math.round(r)));
  }
  e8 = M.evaluate(F8, {helixDeg: 30});
  near('operator-assisted VBmax = truth 0.3', e8.vbMaxMm, .3, .03);
  check('operator-assisted: mode + U (manual sigma)', e8.mode === 'operator-assisted' && e8.q.vbMax.U > 0 && e8.sigmaPx === M.DEFAULTS.sigmaManualPx && e8.areaMm2 > 0 && e8.volumeMm3 > 0, JSON.stringify({mode: e8.mode, U: e8.q.vbMax.U, area: e8.areaMm2}));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
