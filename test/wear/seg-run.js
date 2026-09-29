// AI (Seg) path: the trained U-Net (www/models/wear-seg.onnx.js) in onnxruntime-web (wasm), as the app runs it.
//  1. parity: the wasm result on test/wear/seg/parity.png matches the torch result written by scripts/seg/export.py
//  2. held-out synthetic photos (test/wear/seg, never trained on): per-photo tool / wear IoU against the exact labels
//  3. the full engine (wear-core alignment -> seg-wear.js -> VB maths): VBmax per flute, no invented wear on a clean tool
//  4. the human's photos (test/wear/samples): the network reads the tool and finds the tip damage, nothing on the background
// Run: node test/wear/seg-run.js
'use strict';
const path = require('path'), fs = require('fs');
const W = require('../../www/js/wear/wear-core.js'), SEG = require('../../www/js/wear/seg-wear.js'), readPng = require('./png.js'), loadSeg = require('./ort-seg-node.js'), {readLabel} = require('./png-write.js');
const DIR = path.join(__dirname, 'seg');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };
const f3 = v => (+v).toFixed(3);

// IoU of a predicate on the network grid against the label resampled (nearest) to that grid
function iou(seg, lab, pred) {
  let i = 0, u = 0;
  for (let Y = 0; Y < seg.h; Y++) for (let X = 0; X < seg.w; X++) {
    const x = Math.min(lab.w - 1, Math.floor((X + .5) * seg.scale[0])), y = Math.min(lab.h - 1, Math.floor((Y + .5) * seg.scale[1]));
    const a = pred(seg.mask[Y * seg.w + X]), b = pred(lab.m[y * lab.w + x]);
    if (a && b) i++; if (a || b) u++;
  }
  return u ? i / u : 1;
}

(async () => {
  const t0 = Date.now(), run = await loadSeg();
  console.log(`# model loaded in ${Date.now() - t0} ms`);

  console.log('\n# 1. parity torch (export.py) vs onnxruntime-web wasm');
  const fx = JSON.parse(fs.readFileSync(path.join(DIR, 'parity.json'), 'utf8')), im = readPng(path.join(DIR, 'parity.png'));
  const P = im.width * im.height, x = new Float32Array(3 * P);
  for (let i = 0; i < P; i++) for (let c = 0; c < 3; c++) x[c * P + i] = im.data[4 * i + c] / 255;
  const prob = await run(x, im.height, im.width), counts = [0, 0, 0, 0, 0], sums = [0, 0, 0, 0, 0];
  for (let i = 0; i < P; i++) { let b = 0; for (let c = 0; c < 5; c++) { sums[c] += prob[c * P + i]; if (prob[c * P + i] > prob[b * P + i]) b = c; } counts[b]++; }
  const dCount = counts.reduce((s, v, c) => s + Math.abs(v - fx.counts[c]), 0) / P, dSum = Math.max(...sums.map((v, c) => Math.abs(v - fx.probSums[c]) / P));
  check('argmax agrees on >= 99.9 % of pixels', dCount <= .001, `diff ${(100 * dCount).toFixed(3)} %`);
  check('mean class probability within 1e-3', dSum < 1e-3, `max diff ${dSum.toExponential(2)}`);

  console.log('\n# 2. held-out synthetic photos: IoU against exact labels');
  const idx = JSON.parse(fs.readFileSync(path.join(DIR, 'index.json'), 'utf8'));
  let toolSum = 0, wearI = 0, n = 0;
  const cases = {};
  for (const e of idx) {
    const img = readPng(path.join(DIR, e.file)), lab = readLabel(path.join(DIR, e.label));
    const seg = await SEG.segmentImage(run, img, 512);
    const tI = iou(seg, lab, c => c > 0), wI = iou(seg, lab, c => c >= 2);
    let wl = 0; for (const c of lab.m) if (c >= 2) wl++;
    console.log(`      ${e.file.padEnd(18)} tool IoU ${f3(tI)}  wear IoU ${wl ? f3(wI) : '  -  '}  (label wear px ${wl})`);
    toolSum += tI; n++; if (wl) { wearI += wI; cases.nw = (cases.nw || 0) + 1; }
    const cs = cases[e.case] = cases[e.case] || {e, sides: [], top: null};
    if (e.view === 'top') cs.top = img; else cs.sides.push(img);
  }
  check('mean tool IoU >= 0.90', toolSum / n >= .9, f3(toolSum / n));
  check('mean wear IoU >= 0.30 (thin bands at 13-20 px/mm)', wearI / cases.nw >= .3, f3(wearI / cases.nw));

  console.log('\n# 3. full engine: wear-core alignment -> seg -> VB');
  for (const [name, c] of Object.entries(cases)) {
    if (name === 'nw') continue;
    const k = c.e.flutes, seg = SEG.createSegmenter(run, W, {flutes: k});
    const {result: R, debug} = await W.measureAsync({sides: c.sides, flutes: k, diameterMm: c.e.D}, seg, 'seg');
    const S = debug.sides || [], got = R.perFlute.map(f => f.vbMaxMm), want = c.e.vbMaxMm;
    const nSeg = S.filter(s => s && s.method === 'seg').length;
    console.log(`      ${name}: VBmax ${got.map(f3).join(' ')}  want ${want.map(f3).join(' ')}  seg sides ${nSeg}/${k} ${S.map(s => s && s.aiError || '').filter(Boolean).join('; ')}`);
    check(`${name}: every side segmented by the network`, nSeg === k);
    if (name === 'clean') check('clean tool: VBmax < 0.05 mm', Math.max(...got) < .05, `got ${f3(Math.max(...got))}`);
    else {
      const mw = Math.max(...want), mg = Math.max(...got);
      check(`${name}: tool VBmax within 0.1 mm (+-35 %)`, Math.abs(mg - mw) <= Math.max(.1, .35 * mw), `got ${f3(mg)} want ${f3(mw)}`);
    }
  }

  console.log("\n# 4. the human's photos (test/wear/samples; tip/end-teeth damage visible, D10 at ~11 px/mm)");
  const SD = path.join(__dirname, 'samples'), sides = [1, 2, 3, 4].map(i => readPng(path.join(SD, `side${i}.png`)));
  const seg = SEG.createSegmenter(run, W, {flutes: 4});
  const {result: R, debug} = await W.measureAsync({sides, flutes: 4, diameterMm: 10}, seg, 'seg');
  const S = debug.sides || [], faces = seg.faces;
  console.log(`      VBmax ${R.perFlute.map(f => f3(f.vbMaxMm)).join(' ')}  methods ${S.map(s => s && (s.method + (s.aiError ? ' (' + s.aiError + ')' : ''))).join(', ')}`);
  faces.forEach((f, i) => f && console.log(`      side${i + 1}: toolFrac ${f.toolFrac}  areas mm2 flank ${f.areasMm2[2]} chip ${f.areasMm2[3]} adh ${f.areasMm2[4]}  conf ${f.confidence}`));
  check('network reads the tool on >= 3 of 4 sides', S.filter(s => s && s.method === 'seg').length >= 3);
  const dmg = faces.filter(Boolean).map(f => f.areasMm2[2] + f.areasMm2[3]);
  check('damage found on the worn sides (>= 2 sides with flank+chip area >= 0.05 mm2)', dmg.filter(a => a >= .05).length >= 2, dmg.map(f3).join(' '));
  const top = readPng(path.join(SD, 'top.png')), ts = await SEG.segmentImage(run, top, 512);
  let tool = 0; for (const c of ts.mask) if (c) tool++;
  check('top photo: the network sees the end face', tool > 200, `tool px ${tool}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
