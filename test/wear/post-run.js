// wear-post.js (microscope-style (reference line + edge deviation) post-processing) on synthetic class maps with a known land:
//  a straight cutting edge at an angle, a flank land 0.20 mm wide that widens to 0.30 mm over 0.5 mm, and one edge
//  defect (chip) 0.06 mm deep x 0.40 mm long. Microscope-like (background beyond the edge) and inside-the-tool (side photo).
// Run: node test/wear/post-run.js
'use strict';
const POST = require('../../www/js/wear/wear-post.js');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };
const near = (v, want, tol) => Math.abs(v - want) <= tol;

function land({ppm = 100, angDeg = 25, bgBeyond = true, chip = true, wide = true, rake = false}) {
  const w = 520, h = 400, m = new Uint8Array(w * h), a = angDeg * Math.PI / 180, t = [Math.cos(a), Math.sin(a)], n = [-t[1], t[0]], c = [w / 2, h / 2];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (x + .5 - c[0]) / ppm, dy = (y + .5 - c[1]) / ppm, s = dx * t[0] + dy * t[1], o = dx * n[0] + dy * n[1];   // mm
    if (Math.abs(s) > 2) { m[y * w + x] = o >= 0 ? 1 : bgBeyond ? 0 : 1; continue; }
    let e = 0; if (chip && s > -1.2 && s < -.8) e = .06;                     // edge recedes 0.06 mm over 0.4 mm
    let b = .2; if (wide && s > .5 && s < 1) b = .3;                           // land widens to 0.30 mm over 0.5 mm
    if (rake && s > -.3 && s < -.1) b += .02 * Math.sin(40 * s);              // ragged wear boundary
    m[y * w + x] = o < e ? (bgBeyond ? 0 : 1) : o < b ? 2 : 1;
  }
  return {mask: m, w, h, pxPerMm: ppm};
}

for (const [name, o] of [['microscope (background beyond the edge)', {bgBeyond: true}], ['side photo (tool beyond the edge)', {bgBeyond: false, rake: true}], ['steep edge 70 deg, 40 px/mm', {angDeg: 70, ppm: 40}]]) {
  console.log(`\n# ${name}`);
  const r = POST.analyze(land(o)), A = r.edgeDev, K = r.refLine, px = 1 / (o.ppm || 100);
  console.log(`      edge side ${r.edgeSide}, length ${r.lengthMm} mm, stations ${r.stations}`);
  console.log(`      edgeDev: Nd ${A.Nd} Pd ${A.Pd} % Ddmax ${A.Ddmax} Ldmax ${A.Ldmax} Ldcmax ${A.Ldcmax} VBmax ${A.VBmax} VBmean ${A.VBmean} tol ${A.toleranceMm}`);
  console.log(`      refLine: VBmax ${K.VBmax} at ${K.VBmaxAtMm} recession ${K.edgeRecessionMax} at ${K.edgeRecessionAtMm} ref ${K.referenceMm}`);
  check('evaluated length 4.0 mm', near(r.lengthMm, 4, 3 * px), r.lengthMm);
  check('edgeDev: one defect, 0.06 deep, 0.40 long', A.Nd === 1 && near(A.Ddmax, .06, 1.5 * px) && near(A.Ldmax, .4, 3 * px), `${A.Nd} ${A.Ddmax} ${A.Ldmax}`);
  check('edgeDev: Pd = 0.4 / 4 = 10 %', near(A.Pd, 10, 1.5), A.Pd);
  check('edgeDev: VBmax 0.30, Ldcmax 0.20 (land at the chip)', near(A.VBmax, .3, 1.5 * px) && near(A.Ldcmax, .2, 1.5 * px), `${A.VBmax} ${A.Ldcmax}`);
  check('refLine: VBmax 0.30 at 2.5-3.0 mm, edge recession 0.06 at 0.8-1.2 mm', near(K.VBmax, .3, 1.5 * px) && K.VBmaxAtMm >= 2.45 && K.VBmaxAtMm <= 3.05 && near(K.edgeRecessionMax, .06, 1.5 * px) && K.edgeRecessionAtMm >= .75 && K.edgeRecessionAtMm <= 1.25, `${K.VBmax} ${K.VBmaxAtMm} ${K.edgeRecessionMax} ${K.edgeRecessionAtMm}`);
}
console.log('\n# unworn edge');
const r0 = POST.analyze(land({chip: false, wide: false}));
check('uniform 0.20 land, no defect', r0.edgeDev.Nd === 0 && near(r0.edgeDev.VBmax, .2, .015) && near(r0.refLine.VBmax, .2, .015) && r0.refLine.edgeRecessionMax <= .015, `${r0.edgeDev.Nd} ${r0.edgeDev.VBmax} ${r0.refLine.VBmax} ${r0.refLine.edgeRecessionMax}`);
check('no land -> null', POST.analyze({mask: new Uint8Array(100), w: 10, h: 10, pxPerMm: 10}) === null);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
