// Requirements 2026-10-02 (test/data/req261002): close-up flank wear VB on microscope photos (www/js/wear/edge-vb.js).
// Ground truth = the reference instrument's own annotations on the two photos: the operator's marker (small red x) at the
// wear front and the dotted reference line on the unworn edge; VB = marker -> line distance normal to the line, scale =
// the 100 um bar burned into the image (checked: 77.60 um photo, bar 71 px, marker 53.6 px from the line = 75.5 um).
//  - scale from the on-image bar (no tool diameter in frame)
//  - our reference line on the operator's line (angle, offset)
//  - VB at the operator's marker within +-10 %; VBmax not below the marked spot and within +20 % of it (the marked spot
//    is one measured position, not necessarily the widest one)
//  - spot [2] of the 90.34 photo (24.33 um): the real edge stands outside the reference line there; our edge deviation
//    at that place within +-15 % or +-5 um, and ~0 on the unworn stretch
//  - background-only crops, an unworn stretch of edge and flat / noise images: no wear, never a number on background
//  - the human's failing app screenshot without a scale: no number (status no-scale)
// Run: node test/wear/req261002-run.js
'use strict';
const path = require('path');
const E = require('../../www/js/wear/edge-vb.js'), readPng = require('./png.js');
const DIR = path.join(__dirname, '..', 'data', 'req261002');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };
const crop = (img, x0, y0, x1, y1) => {
  const w = x1 - x0, h = y1 - y0, d = new Uint8ClampedArray(4 * w * h);
  for (let y = 0; y < h; y++) d.set(img.data.subarray(4 * ((y0 + y) * img.width + x0), 4 * ((y0 + y) * img.width + x1)), 4 * y * w);
  return {width: w, height: h, data: d};
};
// VB of the result at the along-edge position of an image point (median over +-8 um of profile)
function vbAt(r, p) {
  const [x0, y0] = r.edge.p0, [x1, y1] = r.edge.p1, L = Math.hypot(x1 - x0, y1 - y0), tx = (x1 - x0) / L, ty = (y1 - y0) / L;
  const uUm = ((p[0] - x0) * tx + (p[1] - y0) * ty) * r.umPerPx, a = r.profile.filter(q => Math.abs(q.uUm - uUm) <= 8).map(q => q.vbUm).sort((p, q) => p - q);
  return a.length ? a[a.length >> 1] : null;
}
// edge deviation (+ = outside the reference line) at the along-edge position of an image point
function devAt(r, p) {
  const [x0, y0] = r.edge.p0, [x1, y1] = r.edge.p1, L = Math.hypot(x1 - x0, y1 - y0), tx = (x1 - x0) / L, ty = (y1 - y0) / L;
  const uUm = ((p[0] - x0) * tx + (p[1] - y0) * ty) * r.umPerPx, a = r.profile.filter(q => Math.abs(q.uUm - uUm) <= 8 && q.devUm != null).map(q => q.devUm).sort((p, q) => p - q);
  return a.length ? a[a.length >> 1] : null;
}
// our edge line vs the operator's dotted line y = k x + c: angle difference (deg) and normal offset (um) at x
function lineDiff(r, k, c, x) {
  const [x0, y0] = r.edge.p0, [x1, y1] = r.edge.p1, kk = (y1 - y0) / (x1 - x0), y = y0 + kk * (x - x0);
  return {dAng: Math.abs(Math.atan(kk) - Math.atan(k)) * 180 / Math.PI, offUm: Math.abs(y - (k * x + c)) * Math.cos(Math.atan(k)) * r.umPerPx};
}

const REF = [
  // file, operator marker (image px), annotated VB (um), dotted reference line y = k x + c (fitted on its green dots), bar px
  {f: 'ref-vb-77.60um.png', marker: [478.5, 366.5], vb: 77.60, line: [.5999, 141.99], barPx: 71},
  {f: 'ref-vb-90.34um-24.33um.png', marker: [922.4, 482.8], vb: 90.34, line: [.6167, 46.78], barPx: 127,
    // spot [2]: the operator's second marker sits at the same place along the edge, 24.33 um OUTSIDE the reference
    // line (on the background side): the real tool edge there stands beyond the line (edge deviation, not a land)
    dev: {marker: [853.8, 607.6], um: 24.33}, unwornU: [0, 450]}
];
const imgs = {};
for (const R of REF) {
  const img = imgs[R.f] = readPng(path.join(DIR, R.f)), t = Date.now(), r = E.measure(img), ms = Date.now() - t;
  console.log(`${R.f}: ${r.status} VBmax ${r.vbMaxUm} um, VB mean ${r.vbMeanUm} um, scale ${r.umPerPx} um/px (${r.scaleFrom}), edge rms ${r.edge && r.edge.rmsUm} um, ${ms} ms`);
  check(`${R.f} measured`, r.status === 'ok', r.reason || '');
  if (r.status !== 'ok') continue;
  check(`${R.f} scale bar ${R.barPx} px`, r.scaleFrom === 'scale-bar' && Math.abs(r.scaleBar.px - R.barPx) <= 2, `got ${r.scaleBar && r.scaleBar.px}`);
  const ld = lineDiff(r, R.line[0], R.line[1], R.marker[0]);
  check(`${R.f} reference line on the operator's line`, ld.dAng < 1 && ld.offUm < 5, `angle ${ld.dAng.toFixed(2)} deg, offset ${ld.offUm.toFixed(1)} um`);
  const v = vbAt(r, R.marker);
  check(`${R.f} VB at the operator's marker ${R.vb} um +-10 %`, v != null && Math.abs(v - R.vb) <= .1 * R.vb, `got ${v} um`);
  check(`${R.f} VBmax in [0.9, 1.2] x ${R.vb} um`, r.vbMaxUm >= .9 * R.vb && r.vbMaxUm <= 1.2 * R.vb, `got ${r.vbMaxUm} um`);
  check(`${R.f} fast`, ms < 3000, `${ms} ms`);
  if (R.dev) {
    const dv = devAt(r, R.dev.marker), tol = Math.max(5, .15 * R.dev.um);
    check(`${R.f} edge deviation at spot [2] ${R.dev.um} um outside the line (+-15 % or +-5 um)`, dv != null && Math.abs(dv - R.dev.um) <= tol, `got ${dv} um`);
    const un = r.profile.filter(q => q.uUm >= R.unwornU[0] && q.uUm <= R.unwornU[1] && q.devUm != null).map(q => Math.abs(q.devUm)).sort((p, q) => p - q);
    check(`${R.f} unworn edge on the reference line (deviation p90 < 4 um)`, un.length > 50 && un[Math.floor(.9 * un.length)] < 4, `p90 ${un.length ? un[Math.floor(.9 * un.length)] : '-'} um`);
  }
}

// no wear: background only, an unworn stretch of edge, flat and noise images
const noWear = (name, img, o) => {
  const r = E.measure(img, o);
  check(`${name}: no wear`, r.status !== 'ok' || r.vbMaxUm === 0, `${r.status} ${r.vbMaxUm != null ? r.vbMaxUm + ' um' : ''} ${r.reason || ''}`);
};
const i77 = imgs['ref-vb-77.60um.png'], i90 = imgs['ref-vb-90.34um-24.33um.png'];
noWear('77.60 background crop', crop(i77, 0, 520, 400, 746), {umPerPx: 100 / 71});
noWear('90.34 background crop', crop(i90, 0, 560, 560, 909), {umPerPx: 100 / 127});
noWear('90.34 unworn edge (left)', crop(i90, 0, 0, 520, 420), {umPerPx: 100 / 127});
noWear('77.60 unworn edge (left)', crop(i77, 0, 60, 340, 360), {umPerPx: 100 / 71});
const flat = {width: 800, height: 600, data: new Uint8ClampedArray(800 * 600 * 4).fill(90)};
noWear('flat grey', flat, {umPerPx: 1});
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const noise = {width: 800, height: 600, data: new Uint8ClampedArray(800 * 600 * 4).map((_, i) => i % 4 === 3 ? 255 : 60 + 80 * rnd())};
noWear('noise', noise, {umPerPx: 1});

// the human's failing case (app screenshot, VB drawn on background): without a scale the close-up path gives no number
const app = readPng(path.join(DIR, 'app-miss-f2.png')), ra = E.measure(app);
check('app-miss-f2 without a scale: no number', ra.vbMaxUm == null && ra.status !== 'ok', `${ra.status}`);

console.log(`\nreq261002: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
