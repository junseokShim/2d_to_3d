// diagnostic (not a test): what the AI (Seg) engine feeds the network and what it gets back, per side.
// Writes <outdir>/<case>_side<i>.png = network window | class overlay (flank cyan, chip red, adhesion pink, tool grey tint)
// plus the wear-core strip band (green). Cases: the seg-run.js held-out synthetic tools and the human's photos.
// Run: node test/wear/seg-diag.js <outdir>
'use strict';
const path = require('path'), fs = require('fs');
const W = require('../../www/js/wear/wear-core.js'), SEG = require('../../www/js/wear/seg-wear.js'), readPng = require('./png.js'), loadSeg = require('./ort-seg-node.js');
const {writePng, readLabel} = require('./png-write.js');
const COL = [[0, 0, 0], [90, 90, 90], [0, 255, 255], [255, 40, 40], [255, 0, 200]];

(async () => {
  const out = process.argv[2]; if (!out) throw new Error('usage: seg-diag.js <outdir>');
  fs.mkdirSync(out, {recursive: true});
  const base = await loadSeg(); let calls = [];
  const run = async (x, H, Wd) => { const p = await base(x, H, Wd); calls.push({x, H, W: Wd, p}); return p; };
  const DIR = path.join(__dirname, 'seg'), idx = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8')), cases = {};
  for (const e of idx) if (e.view !== 'top') (cases[e.case] = cases[e.case] || {e, sides: []}).sides.push(readPng(path.join(DIR, e.file)));
  const SD = path.join(__dirname, 'samples');
  cases.human = {e: {flutes: 4, D: 10}, sides: [1, 2, 3, 4].map(i => readPng(path.join(SD, `side${i}.png`)))};
  // oracle: the exact labels through the same window + VB maths (what the engine reads from a perfect network)
  const labs = {};
  for (const e of idx) if (e.view !== 'top') (labs[e.case] = labs[e.case] || []).push(readLabel(path.join(DIR, e.label)));
  for (const [name, c] of Object.entries(cases)) {
    if (!labs[name]) continue;
    const oracle = require('./seg-oracle.js')(labs[name]);
    const k = c.e.flutes, seg = SEG.createSegmenter(null, W, {flutes: k, oracle});
    const {result: R} = await W.measureAsync({sides: c.sides, flutes: k, diameterMm: c.e.D}, seg, 'seg');
    console.log(`${name} ORACLE (exact labels): VBmax ${R.perFlute.map(f => f.vbMaxMm.toFixed(3)).join(' ')}  want ${(c.e.vbMaxMm || []).map(v => v.toFixed(3)).join(' ')}`);
  }
  for (const [name, c] of Object.entries(cases)) {
    calls = [];
    const k = c.e.flutes, seg = SEG.createSegmenter(run, W, {flutes: k});
    const {result: R, debug} = await W.measureAsync({sides: c.sides, flutes: k, diameterMm: c.e.D}, seg, 'seg');
    console.log(`${name}: VBmax ${R.perFlute.map(f => f.vbMaxMm.toFixed(3)).join(' ')}  want ${(c.e.vbMaxMm || []).join(' ')}`);
    R.perFlute.forEach((f, i) => console.log(`   side${i + 1} VB profile (z mm:vb mm) ${f.profile.slice(0, 20).map(q => q.zMm.toFixed(1) + ':' + q.vbMm.toFixed(2)).join(' ')}`));
    calls.forEach((q, i) => {
      const {x, H, W: Wn, p} = q, P = H * Wn, o = new Uint8Array(3 * 2 * Wn * H);
      for (let j = 0; j < P; j++) {
        let b = 0; for (let cc = 1; cc < 5; cc++) if (p[cc * P + j] > p[b * P + j]) b = cc;
        const Y = Math.floor(j / Wn), X = j % Wn, a = 3 * (Y * 2 * Wn + X), bo = a + 3 * Wn;
        for (let cc = 0; cc < 3; cc++) {
          const v = Math.round(255 * x[cc * P + j]); o[a + cc] = v;
          o[bo + cc] = b >= 2 ? Math.round(.35 * v + .65 * COL[b][cc]) : b === 1 ? Math.round(.8 * v + .2 * 160) : Math.round(.5 * v);
        }
      }
      writePng(path.join(out, `${name}_side${i + 1}.png`), 2 * Wn, H, o);
      const f = seg.faces[i], s = debug.sides[i];
      console.log(`   side${i + 1} ${Wn}x${H} method ${s && s.method} ${s && s.aiError || ''} areas ${f ? JSON.stringify(f.areasMm2) : '-'} toolFrac ${f ? f.toolFrac : '-'} pieces ${f ? f.bandPieces : '-'}`);
    });
  }
})().catch(e => { console.error(e); process.exit(1); });
