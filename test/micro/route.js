// Microscope view routing (www/js/micro/micro-core.js detectView). Run: node test/micro/route.js [--no-net]
//  1. routing: the human USB-microscope photos (27: side views of the whole tool + a top view per tool) must go to the
//     camera side-view pipeline ('side'); Keyence VHX and MUDESTREDA flank close-ups must stay in micro-core ('closeup').
//     Calibration = the image's own px/mm (human: the labelled scale, as the magnification's calibration would give;
//     Keyence: the measured scale; MUDESTREDA publishes none: 800 px/mm, the docs' figure).
//  2. report (no pass/fail on accuracy; the camera path's accuracy is test/wear): microscope mode on the human side views,
//     before (micro-core on the whole image: tip line read as the cutting edge) and after (camera side-view pipeline at the
//     calibrated px/mm), VBmax / VBC vs datasets/toolwear/reference/human_gt.json.
'use strict';
const fs = require('fs'), path = require('path');
const MC = require('../../www/js/micro/micro-core.js'), readPng = require('../wear/png.js'), mud = require('./mud.js');
const DS = mud.DS, HP = process.env.HUMAN_PNG || 'C:/agent_research_team/datasets/human_samples/png', LI = path.join(DS, 'processed/labelinfo');
const GT_FILE = path.join(DS, 'reference/human_gt.json');
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };
const f3 = v => v == null ? '  -  ' : (+v).toFixed(3);

(async () => {
  if (!fs.existsSync(LI) || !fs.existsSync(HP)) { console.log('datasets not on this machine: skipped'); return; }
  console.log('# 1. routing');
  const hum = fs.readdirSync(LI).filter(f => f.startsWith('hum_')).sort().map(f => JSON.parse(fs.readFileSync(path.join(LI, f), 'utf8')))
    .map(j => Object.assign(j, {png: path.join(HP, j.tool, path.basename(j.rawImage).replace(/\.\w+$/, '.png'))}));
  const size = p => { const b = fs.readFileSync(p); return {width: b.readUInt32BE(16), height: b.readUInt32BE(20)}; };   // PNG IHDR
  const hv = hum.map(j => Object.assign({id: j.id || path.basename(j.png)}, MC.detectView(size(j.png), {pxPerMm: j.pxPerMm, diameterMm: j.D})));
  const hMiss = hv.filter(v => v.view !== 'side');
  check(`human USB photos -> side view (camera path) ${hv.length - hMiss.length}/${hv.length}`, hv.length === 27 && !hMiss.length,
    `field of view ${Math.min(...hv.map(v => v.fovD)).toFixed(2)}-${Math.max(...hv.map(v => v.fovD)).toFixed(2)} D ${hMiss.map(v => v.id).join(' ')}`);
  const KD = path.join(DS, 'reference/keyence'), key = fs.readdirSync(path.join(KD, 'labelinfo')).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(KD, 'labelinfo', f), 'utf8')));
  const kv = key.map(j => Object.assign({id: j.id}, MC.detectView(size(path.join(KD, 'images', j.id + '.png')), {pxPerMm: j.pxPerMm, diameterMm: 10})));
  check(`Keyence VHX close-ups -> closeup ${kv.filter(v => v.view === 'closeup').length}/${kv.length}`, kv.length >= 5 && kv.every(v => v.view === 'closeup'), `max ${Math.max(...kv.map(v => v.fovD)).toFixed(2)} D`);
  const mi = ['train', 'val', 'test'].flatMap(s => mud.items(s)), mv = mi.map(it => Object.assign({id: it.id}, MC.detectView(size(path.join(DS, it.image)), {pxPerMm: 800, diameterMm: 10})));
  check(`MUDESTREDA close-ups -> closeup ${mv.filter(v => v.view === 'closeup').length}/${mv.length}`, mv.length > 100 && mv.every(v => v.view === 'closeup'), `max ${Math.max(...mv.map(v => v.fovD)).toFixed(2)} D`);
  check('no calibration -> closeup (micro-core, as before)', MC.detectView({width: 640, height: 480}, {diameterMm: 10}).view === 'closeup');
  check('override-free boundary: VIEW_FOV x D field of view is a side view', MC.detectView({width: 400, height: 300}, {pxPerMm: 100, diameterMm: 4 / MC.VIEW_FOV}).view === 'side');

  if (process.argv.includes('--no-net') || !fs.existsSync(GT_FILE)) { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }
  console.log('\n# 2. report: microscope mode on the human side views, before (micro-core) / after (camera side-view path), vs human_gt');
  const gt = JSON.parse(fs.readFileSync(GT_FILE, 'utf8')), G = {}; for (const e of gt.images) G[e.image.replace(/\.jpg$/i, '')] = e;
  const W = require('../../www/js/wear/wear-core.js'), SEG = require('../../www/js/wear/seg-wear.js'), run = await require('../wear/ort-seg-node.js')();
  const TOOLS = [['10Pi_1', 10, '10'], ['10Pi_2', 10, '10'], ['12Pi', 12, '12']], rows = [];
  for (const [tool, D, p] of TOOLS) for (const k of ['1', '2']) {
    const names = [1, 2, 3, 4].map(s => `${tool}/${p}-${s}-${k}`), sides = names.map(n => readPng(path.join(HP, n + '.png')));
    const cp = names.map(n => G[n] && G[n].pxPerMm).filter(Boolean).sort((a, b) => a - b), ppm = cp[cp.length >> 1];   // one calibration per shot set
    let after = null; try { after = (await W.measureAsync({sides, flutes: 4, diameterMm: D, pxPerMm: ppm}, SEG.createSegmenter(run, W, {flutes: 4}), 'seg')).debug.sides; } catch (e) { console.log(`  ${tool} shot ${k}: camera path error ${e.message}`); }
    for (let i = 0; i < 4; i++) {
      let b = null; try { const r = await MC.analyzeImage(sides[i], {runProbs: run, seg: SEG, pxPerMm: ppm, corner: 'none'}); b = {vb: r.stats.vbMax, q: r.q, flags: r.flags}; } catch (e) { b = {err: e.message}; }
      const s = after && after[i], g = G[names[i]];
      rows.push({name: names[i], g, b, s});
      console.log(`  ${names[i].padEnd(15)} before VB ${f3(b.vb)} (rot ${b.q == null ? '-' : 90 * b.q} deg${b.flags && b.flags.length ? ', ' + b.flags.join(',') : ''})  after VBmax ${f3(s && s.vbMaxMm)} flank ${f3(s && s.vbFlankMaxMm)} VBC ${f3(s && s.vbTipMm)}${s && s.needsOperator ? ' [' + s.reasons.join(',') + ']' : ''}` +
        (g ? `  | gt VBC ${f3(g.vbcMm)} VBmax ${f3(g.vbMaxMm)} chip ${f3(g.chipDepthMm)}` : ''));
    }
  }
  const dmg = rows.filter(r => r.g && (r.g.hasChip || r.g.hasWear)), ref = r => Math.max(r.g.vbcMm || 0, r.g.vbMaxMm || 0, r.g.chipDepthMm || 0);
  const zeroB = dmg.filter(r => !(r.b.vb > 0)).length, zeroA = dmg.filter(r => !(r.s && (r.s.vbMaxMm > 0 || r.s.needsOperator))).length;
  const mae = f => { const e = dmg.map(f).filter(v => v != null); return e.length ? e.reduce((a, c) => a + c, 0) / e.length : null; };
  console.log(`\n  labelled damage sides ${dmg.length}: silent 0 before ${zeroB}, after ${zeroA}; |VB - gt max(VBC, VBmax)| MAE before ${f3(mae(r => r.b.vb == null ? null : Math.abs(r.b.vb - ref(r))))} mm, after ${f3(mae(r => r.s ? Math.abs(r.s.vbMaxMm - ref(r)) : null))} mm`);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
