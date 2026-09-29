// AI (Seg) path: the trained U-Net (www/models/wear-seg.onnx.js) in onnxruntime-web (wasm), as the app runs it.
//  1. parity: the wasm result on test/wear/seg/parity.png matches the torch result written by scripts/seg/export.py
//  2. held-out synthetic photos (test/wear/seg, never trained on): per-photo tool / wear IoU against the exact labels
//  3. the full engine (wear-core alignment -> seg-wear.js -> VB maths): VBmax per flute, no invented wear on a clean tool
//  4. the human's photos (test/wear/samples): the network reads the tool and finds the tip damage, nothing on the background
// Run: node test/wear/seg-run.js
'use strict';
const path = require('path'), fs = require('fs');
const W = require('../../www/js/wear/wear-core.js'), SEG = require('../../www/js/wear/seg-wear.js'), readPng = require('./png.js'), loadSeg = require('./ort-seg-node.js'), {readLabel} = require('./png-write.js');
const DIR = path.join(__dirname, 'seg'), SET = process.env.SEG_SET || DIR;   // SEG_SET: another held-out set (sections 2-3), e.g. .work/valset1
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
  const idx = JSON.parse(fs.readFileSync(path.join(SET, 'index.json'), 'utf8'));
  let toolSum = 0, wearI = 0, n = 0;
  const cases = {};
  for (const e of idx) {
    const img = readPng(path.join(SET, e.file)), lab = readLabel(path.join(SET, e.label));
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

  console.log('\n# 3. full engine: wear-core alignment -> seg -> VB, per side, against the same pipeline fed the exact labels');
  // The reference is the VB the engine reads from the exact label masks (seg-oracle.js): it isolates the network's error
  // from the alignment and the VB maths. Only sides both runs segmented are compared (a side the alignment cannot place
  // falls back to the classic engine in both; that is wear-core's business, counted separately).
  // Reference = the land the render actually draws (index.json vbZoneBMm: ISO 8688-2 VBmax in zone B, corner excluded;
  // make_testset.py rendered_vb, same seeds, not fitted). The nominal per-flute vb (vbMaxMm) is 1.25-1.4x smaller than
  // the rendered land (ragged noise, corner boost); its comparison is printed for the record only.
  const pairs = [], cleanVb = [], app = {ok: 0, flagged: 0, silent: [], cleanOk: 0, cleanFlagged: 0, cleanSilent: []}, nomApp = {ok: 0, flagged: 0, silent: []}, corner = [];
  let nSides = 0, segSides = 0;
  for (const [name, c] of Object.entries(cases)) {
    if (name === 'nw') continue;
    const k = c.e.flutes, labs = idx.filter(e => e.case === name && e.view !== 'top').map(e => readLabel(path.join(SET, e.label)));
    const args = {sides: c.sides, flutes: k, diameterMm: c.e.D};
    const {result: R, debug} = await W.measureAsync(args, SEG.createSegmenter(run, W, {flutes: k}), 'seg');
    const {result: O, debug: dO} = await W.measureAsync(args, SEG.createSegmenter(null, W, {flutes: k, oracle: require('./seg-oracle.js')(labs)}), 'seg');
    const isSeg = (d, i) => d.sides && d.sides[i] && d.sides[i].method === 'seg';
    const row = [];
    for (let i = 0; i < k; i++) {
      nSides++; if (isSeg(debug, i)) segSides++;
      const g = R.perFlute[i].vbMaxMm, o = O.perFlute[i].vbMaxMm, want = (c.e.vbZoneBMm || c.e.vbMaxMm)[i], flag = debug.sides[i] && debug.sides[i].needsOperator;
      if (name !== 'clean') { const nw = c.e.vbMaxMm[i]; if (Math.abs(g - nw) <= .1) nomApp.ok++; else if (flag) nomApp.flagged++; else nomApp.silent.push(`${name}${i + 1}`); }
      const vt = debug.sides[i] && debug.sides[i].vbTipMm;
      if (vt > 0 && c.e.vbCornerMm) corner.push(`${name}${i + 1} VBC ${f3(vt)} vs rendered corner ${f3(c.e.vbCornerMm[i])}`);
      // what the app shows: a VBmax within 0.1 mm of the rendered land (clean: < 0.1 mm), or the side is sent to the operator
      if (name === 'clean') { if (g < .1) app.cleanOk++; else if (flag) app.cleanFlagged++; else app.cleanSilent.push(`${name}${i + 1} ${f3(g)}`); }
      else if (Math.abs(g - want) <= .1) app.ok++; else if (flag) app.flagged++; else app.silent.push(`${name}${i + 1} ${f3(g)} vs ${f3(want)}`);
      if (!isSeg(debug, i) || !isSeg(dO, i)) { row.push(`${f3(g)}/-`); continue; }
      // network vs exact labels on the flank land (the colour tip stage folded into VBmax is the same code in both runs' reach but
      // the oracle skips it; comparing VBmax would score wear-core's tip stage, not the network)
      const gf = debug.sides[i].vbFlankMaxMm, of = dO.sides[i].vbFlankMaxMm, gt = debug.sides[i].tip && debug.sides[i].tip.depthMm > 0;
      row.push(`${f3(g)}/${f3(o)}${gt ? ` (flank ${f3(gf)}/${f3(of)})` : ''}`);
      if (name === 'clean') cleanVb.push(g); else pairs.push({g: gf, o: of});
    }
    console.log(`      ${name.padEnd(7)} VBmax network/exact-label per side: ${row.join('  ')}   (rendered zone-B ${(c.e.vbZoneBMm || []).map(f3).join(' ')}, nominal ${c.e.vbMaxMm.map(f3).join(' ')})`);
  }
  const within = pairs.filter(p => Math.abs(p.g - p.o) <= Math.max(.1, .35 * p.o)).length;
  const mae = pairs.reduce((s, p) => s + Math.abs(p.g - p.o), 0) / Math.max(1, pairs.length);
  check('the network reads >= 80 % of the aligned sides', segSides >= .8 * nSides, `${segSides}/${nSides}`);
  check('worn sides: VBmax within 0.1 mm (+-35 %) of the exact-label VBmax on >= 60 %', within >= .6 * pairs.length, `${within}/${pairs.length}, mean |err| ${f3(mae)} mm`);
  check('clean tool: VBmax < 0.1 mm on every side', cleanVb.every(v => v < .1), cleanVb.map(f3).join(' '));
  console.log(`      (record) against the nominal vb instead: ${nomApp.ok} within, ${nomApp.flagged} flagged, ${nomApp.silent.length} silent-wrong ${nomApp.silent.join(' ')}`);
  if (corner.length) console.log(`      corner / tip (VBC) where the engine reports it: ${corner.join(', ')}`);
  check('app: every worn side within 0.1 mm of the rendered zone-B VBmax or flagged for the operator', !app.silent.length,
    `${app.ok} within, ${app.flagged} flagged, ${app.silent.length} silent-wrong ${app.silent.join(', ')}`);
  check('app: every clean side < 0.1 mm or flagged for the operator', !app.cleanSilent.length,
    `${app.cleanOk} < 0.1, ${app.cleanFlagged} flagged, ${app.cleanSilent.length} silent-wrong ${app.cleanSilent.join(', ')}`);

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
  S.forEach((s, i) => s && console.log(`      side${i + 1}: VBmax ${f3(s.vbMaxMm)} (flank ${f3(s.vbFlankMaxMm)}, tip ${f3(s.vbTipMm)} ${s.vbSource}; network chip ${faces[i] && faces[i].tip ? f3(faces[i].tip.netDepthMm) : '0.000'}, colour ${faces[i] && faces[i].tip ? f3(faces[i].tip.colorDepthMm) : '0.000'})  operator: ${s.needsOperator ? s.reasons.join(',') : 'no'}`));
  // the human's complaint was 'VB not detected': the chipped end teeth (wear-core tipDamage: s2 2.56, s3 1.33, s4 2.68 mm)
  // must reach the reported VBmax as VBC, or the side goes to the operator; never a confident small VB there
  for (const i of [1, 2, 3]) { const s = S[i]; check(`side ${i + 1}: tip damage >= 1 mm in VBmax (VBC) or flagged for the operator`, !!s && (s.vbTipMm >= 1 || s.needsOperator), s ? `VBmax ${f3(s.vbMaxMm)}, tip ${f3(s.vbTipMm)}, ${s.needsOperator ? s.reasons.join(',') : 'confident'}` : 'not aligned'); }
  const top = readPng(path.join(SD, 'top.png')), ts = await SEG.segmentImage(run, top, 512);
  let tool = 0; for (const c of ts.mask) if (c) tool++;
  check('top photo: the network sees the end face', tool > 200, `tool px ${tool}`);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
