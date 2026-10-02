// end-face segmentation + profile deviation (www/js/metro/metro-endprofile.js) on the 2026-10-02 reference images.
// Run: node test/metro/endprofile.js
'use strict';
const path = require('path');
const E = require('../../www/js/metro/metro-endprofile.js'), readPng = require('../wear/png.js');
const REQ = path.join(__dirname, '../data/req261002');

let pass = 0, fail = 0;
const near = (name, got, want, tol) => { const ok = got != null && Math.abs(got - want) <= tol; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: got ${got} want ${want} +-${tol}`); ok ? pass++ : fail++; };
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };

// 1) synthetic circle fit + line fit
{
  const P = []; for (let a = 0; a < 360; a += 3) { const t = a * Math.PI / 180; P.push([200 + 80 * Math.cos(t), 150 + 80 * Math.sin(t)]); }
  for (let i = 0; i < 12; i++) P.push([200 + 95 * Math.cos(i), 150 + 95 * Math.sin(i)]);   // outliers (shadow)
  const C = E.fitCircleRobust(P);
  check('robust circle: centre + radius with 10 % outliers', Math.abs(C.cx - 200) < .3 && Math.abs(C.cy - 150) < .3 && Math.abs(C.rPx - 80) < .3, JSON.stringify(C));
  const pts = []; for (let x = 0; x <= 100; x++) pts.push({x, y: 5 + .5 * x + (x > 60 ? -(x - 60) : 0)});
  const R = E.analyzeProfile(pts, [0, 50], 80);
  near('line slope on the segment', R.line.slope, .5, 1e-9); near('rms on a straight segment', R.line.rmsUm, 0, 1e-9);
  // point (80, 25): line y = 5 + .5x -> 45 at x = 80; vertical gap 20 -> perpendicular 20 / sqrt(1.25)
  near('perpendicular deviation of the picked point', R.pick.absUm, 20 / Math.sqrt(1.25), 1e-3);
  check('deviation sign below the line', R.pick.devUm < 0);
  const f = R.pick.foot, Lslope = (f[1] - R.pick.y) / (f[0] - R.pick.x);
  near('foot: arrow is perpendicular (slope -2)', Lslope, -2, 1e-3);
  near('max deviation at the end', R.max.x, 100, 1e-9);
  check('parse two-column text with header', E.parseProfile('x_um,height_um\n0,1\n1;2\n2\t3\n# c\n').length === 3);
}

// 2) end face: ref-endface-seg.png (scale bar 2000 um, 4 teeth filled red by the reference instrument)
{
  const img = readPng(path.join(REQ, 'ref-endface-seg.png')), {width: w, height: h, data: d} = img;
  const a = E.analyzeEndFace(img, {diameterMm: 10, k: 4, barUm: 2000});
  // reference: the tool rim at the centre row spans x 74..737 (read off the photo), so the outer circle is ~ (405.5, 331.5 px)
  near('outer circle radius px', a.circle.rPx, 331.5, 4);
  near('outer circle centre x px', a.circle.cx, 405.5, 4);
  check('outer circle fit rms < 1.5 px', a.circle.rmsPx < 1.5, String(a.circle.rmsPx));
  // the instrument's own (hand-placed) circle: teal pixels, within 12 px centre / 2 % radius
  const T = []; for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = 4 * (y * w + x); if (d[o + 1] > 140 && d[o + 2] > 140 && d[o] < 120 && Math.abs(d[o + 1] - d[o + 2]) < 50) T.push([x + .5, y + .5]); }
  const ref = E.fitCircleRobust(T);
  check('close to the instrument circle', Math.hypot(a.circle.cx - ref.cx, a.circle.cy - ref.cy) < 12 && Math.abs(a.circle.rPx / ref.rPx - 1) < .02, JSON.stringify({ref: [ref.cx, ref.cy, ref.rPx]}));
  near('scale bar 2000 um length px', a.bar && a.bar.px, 166.5, 1.5);
  check('scale from the bar', a.scale.method === 'bar' && Math.abs(a.scale.pxPerMm - 83.3) < 1, JSON.stringify(a.scale));
  near('diameter from the scale bar (mm)', a.scale.diameterMm, 7.95, .1);
  check('4 teeth found, numbered clockwise from 12 o clock', a.k === 4 && a.teeth.every((t, i) => i === 0 || t.angleDeg > a.teeth[i - 1].angleDeg), a.teeth.map(t => t.angleDeg).join(' '));
  // ground truth = the reference's red fill, per tooth
  const red = new Array(5).fill(0); let redAll = 0;
  for (let i = 0; i < w * h; i++) { const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2]; if (r > 120 && r > g + 50 && r > b + 40) { redAll++; red[a.label[i]]++; } }
  check('red fill inside the tooth masks (>= 99 %)', (redAll - red[0]) / redAll >= .99, `${redAll - red[0]}/${redAll}`);
  a.teeth.forEach(t => near(`T${t.tooth} area vs red fill (rel)`, t.areaPx / red[t.tooth], 1, .04));
  near('total area mm2 (red fill / px per mm^2)', a.total.areaMm2, redAll / (a.scale.pxPerMm ** 2), .04 * redAll / (a.scale.pxPerMm ** 2));
  // diameter scale instead of the bar
  const b = E.analyzeEndFace(img, {diameterMm: 10, k: 4, barUm: 2000, scale: 'diameter'});
  check('scale from the diameter when asked', b.scale.method === 'diameter' && Math.abs(b.scale.diameterMm - 10) < 1e-6 && Math.abs(b.teeth[0].areaMm2 / a.teeth[0].areaMm2 - (a.scale.pxPerMm / b.scale.pxPerMm) ** 2) < 1e-3);
  const csv = E.csvSections({endSeg: a});
  check('csv: per-tooth and circle rows', /endface_seg_tooth,angle_deg,area_mm2/.test(csv) && /\r\nT4,/.test(csv) && /\r\ncircle,/.test(csv));
}

// 3) profile: ref-profile-52.90um.png digitised (axes read off the plot: x ticks every 54 px = 40 um from px 41,
//    y 730 um at px 66 and 590 um at px 385); reference segment ~75..360 um, picked point near x 590..600 um -> 52.90 um
{
  const img = readPng(path.join(REQ, 'ref-profile-52.90um.png')), {width: w, data: d} = img;
  const X = px => (px - 41) / 1.35, Y = py => 730 - (py - 66) * 140 / (385 - 66), pts = [];
  for (let x = 42; x < 1224; x++) { let s = 0, n = 0; for (let y = 28; y < 401; y++) { const o = 4 * (y * w + x); if (d[o] < 40 && d[o + 1] > 50 && d[o + 2] > 50 && Math.abs(d[o + 1] - d[o + 2]) < 25) { s += y + .5; n++; } } if (n) pts.push({x: X(x + .5), y: Y(s / n)}); }
  check('profile digitised', pts.length > 800, String(pts.length));
  for (const pick of [588, 600]) {
    const R = E.analyzeProfile(pts, [75, 358], pick);
    near(`deviation at x ${pick} um vs reference 52.90 um`, R.pick.absUm, 52.9, 1.5);
  }
  const R = E.analyzeProfile(pts, [75, 358], 595);
  check('reference line fits the segment (rms < 2 um)', R.line.rmsUm < 2, String(R.line.rmsUm));
  const csv = E.csvSections({profile: {pts, res: R}});
  check('csv: reference, picked, max, points', /profile_reference/.test(csv) && /\r\npicked,/.test(csv) && /\r\nmax,/.test(csv) && /profile_x_um,height_um/.test(csv));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
