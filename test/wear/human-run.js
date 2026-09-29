// The human's USB-microscope photos (datasets/human_samples, 3 tools: 10Pi_1, 10Pi_2 = D10, 12Pi = D12; 4 side views x 2
// shots + a top view each; ~47 px/mm on the D10 sets, the D12 set is zoomed so the tool is wider than the frame) and a
// few QIT-CEMC close-ups, through the app's engine: wear-core alignment -> seg-wear (U-Net) -> VB / tip damage.
// Report only unless the labels exist (datasets/toolwear/reference/human_gt.json, worker-hlabel): then per tool
//   chip / tip-damage depth vs the labelled chip depth, flank VB vs the labelled land width, never a confident 0 on a
//   labelled damage, px/mm vs the labelled scale.
// Needs the PNG cache (Node has no JPEG decoder): python scripts/data/human_png.py
// Run: node test/wear/human-run.js [--classic] [--shot 1|2] [--tool 10Pi_1] [--no-gt]
'use strict';
const fs = require('fs'), path = require('path');
const W = require('../../www/js/wear/wear-core.js'), SEG = require('../../www/js/wear/seg-wear.js'), readPng = require('./png.js');
const DATA = process.env.HUMAN_PNG || 'C:/agent_research_team/datasets/human_samples/png';
const GT_FILE = process.env.HUMAN_GT || 'C:/agent_research_team/datasets/toolwear/reference/human_gt.json';
const TOOLS = [['10Pi_1', 10, '10'], ['10Pi_2', 10, '10'], ['12Pi', 12, '12']];
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const f3 = v => v == null ? '  -  ' : (+v).toFixed(3);
// thresholds (per tool, on the sides the labels give a scale for)
const TOL = {chipMm: .5, chipRel: .3, vbMm: .3, ppmRel: .08};
let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };

(async () => {
  if (!fs.existsSync(DATA)) { console.log(`no PNG cache at ${DATA}: run python scripts/data/human_png.py`); process.exit(0); }
  const gt = !process.argv.includes('--no-gt') && fs.existsSync(GT_FILE) ? JSON.parse(fs.readFileSync(GT_FILE, 'utf8')) : null;
  const G = {}; if (gt) for (const e of gt.images) G[e.image.replace(/\.jpg$/i, '')] = e;
  const classic = process.argv.includes('--classic'), run = classic ? null : await require('./ort-seg-node.js')();
  const shots = arg('--shot') ? [arg('--shot')] : ['1', '2'], only = arg('--tool');
  const rows = [];
  for (const [tool, D, p] of TOOLS) {
    if (only && only !== tool) continue;
    for (const k of shots) {
      const names = [1, 2, 3, 4].map(s => `${tool}/${p}-${s}-${k}`), sides = names.map(n => readPng(path.join(DATA, n + '.png')));
      const args = {sides, flutes: 4, diameterMm: D};
      const {result, debug} = classic ? W.measure(args) : await W.measureAsync(args, SEG.createSegmenter(run, W, {flutes: 4}), 'seg');
      console.log(`\n# ${tool} shot ${k} (D${D}, ${classic ? 'classic' : 'seg'}): VBmax ${f3(result.totals.vbMaxMm)}`);
      debug.sides.forEach((s, i) => {
        const g = G[names[i]], r = {tool, name: names[i], s, g, ai: debug.aiErrors[i]};
        rows.push(r);
        console.log(`  ${names[i].padEnd(16)} ` + (s ? `${(s.align.method || 'edges').padEnd(8)} tilt ${(+s.align.tiltDeg).toFixed(1).padStart(5)} ppm ${(+s.align.pxPerMm).toFixed(1).padStart(5)}  VB ${f3(s.vbMaxMm)} flank ${f3(s.vbFlankMaxMm)} tip ${f3(s.vbTipMm)}  ${s.needsOperator ? 'OPERATOR' : 'confident'} [${s.reasons}]` : 'NOT MEASURED (side failed)')
          + (g ? `   | label: ppm ${g.pxPerMm == null ? '  -  ' : g.pxPerMm.toFixed(1)} chip ${f3(g.chipDepthMm)} VB ${f3(g.vbMaxMm)}` : ''));
      });
    }
  }
  if (!gt) { console.log('\n(no labels: report only)'); return; }
  console.log('\n# against the labels (per tool; sides without a labelled scale are checked for flags only)');
  for (const [tool] of TOOLS) {
    const R = rows.filter(r => r.tool === tool && r.g); if (!R.length) continue;
    const scaled = R.filter(r => r.g.pxPerMm);
    // never a confident 0 / confident small number on a side with labelled damage
    const silent = R.filter(r => (r.g.hasChip || r.g.hasWear) && (!r.s || (!r.s.needsOperator && r.s.vbMaxMm < .5 * Math.max(r.g.chipDepthMm || 0, r.g.vbMaxMm || 0, .2))));
    check(`${tool}: no silent miss on labelled damage (${R.length} sides)`, !silent.length, silent.map(r => r.name).join(' '));
    const ppmBad = scaled.filter(r => r.s && Math.abs(r.s.align.pxPerMm / r.g.pxPerMm - 1) > TOL.ppmRel && !(r.s.reasons || []).includes('tool-cut-off'));
    check(`${tool}: px/mm within ${100 * TOL.ppmRel} % of the label or flagged tool-cut-off`, !ppmBad.length, ppmBad.map(r => `${r.name} ${r.s.align.pxPerMm.toFixed(1)}/${r.g.pxPerMm}`).join(' '));
    const ch = scaled.filter(r => r.g.hasChip && r.s && !(r.s.reasons || []).includes('tool-cut-off'));
    if (ch.length) {
      const err = ch.map(r => Math.abs((r.s.vbTipMm || 0) - r.g.chipDepthMm)), mae = err.reduce((a, b) => a + b, 0) / err.length;
      const found = ch.filter(r => r.s.vbTipMm > 0).length;
      check(`${tool}: chipped corners reported as tip damage (VBC) on >= 75 % of the labelled sides`, found >= .75 * ch.length, `${found}/${ch.length}`);
      check(`${tool}: chip depth MAE <= max(${TOL.chipMm} mm, ${100 * TOL.chipRel} %)`, mae <= Math.max(TOL.chipMm, TOL.chipRel * ch.reduce((a, r) => a + r.g.chipDepthMm, 0) / ch.length), `MAE ${f3(mae)} mm`);
    }
    const noLand = scaled.filter(r => !r.g.hasWear && r.s && r.s.vbFlankMaxMm > TOL.vbMm);
    check(`${tool}: no flank land where none is labelled (specular streaks are not wear)`, !noLand.length, noLand.map(r => `${r.name} ${f3(r.s.vbFlankMaxMm)}`).join(' '));
    const land = scaled.filter(r => r.g.hasWear && r.g.vbMaxMm && r.s && !(r.s.reasons || []).includes('tool-cut-off'));
    if (land.length) { const e = land.map(r => Math.abs(r.s.vbFlankMaxMm - r.g.vbMaxMm)), m = e.reduce((a, b) => a + b, 0) / e.length; check(`${tool}: flank VB MAE <= ${TOL.vbMm} mm`, m <= TOL.vbMm, `MAE ${f3(m)} mm`); }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
