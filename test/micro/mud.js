// MUDESTREDA helpers for the microscope tests: items of a split, image + label, label oracle, label-derived VB.
'use strict';
const fs = require('fs'), path = require('path');
const readPng = require('../wear/png.js'), {readLabel} = require('../wear/png-write.js'), MC = require('../../www/js/micro/micro-core.js');
const DS = process.env.TOOLWEAR || 'C:/agent_research_team/datasets/toolwear';
function items(split) {
  const m = JSON.parse(fs.readFileSync(path.join(DS, 'manifest.json'), 'utf8'));
  return m.items.filter(i => i.id.startsWith('mud_') && i.split === split).map(i => {
    const li = path.join(DS, 'processed/labelinfo', i.id + '.json');
    return Object.assign({}, i, {info: fs.existsSync(li) ? JSON.parse(fs.readFileSync(li, 'utf8')) : {}});
  });
}
const load = it => ({img: readPng(path.join(DS, it.image)), lab: readLabel(path.join(DS, it.mask))});
// label as one-hot probabilities at native resolution (255 -> tool: not counted as wear, not background)
function oracle(lab, q) {
  const L = MC.rotate({width: lab.w, height: lab.h, data: Uint8ClampedArray.from({length: 4 * lab.w * lab.h}, (_, i) => i % 4 ? 0 : lab.m[i >> 2])}, q);
  const w = L.width, h = L.height, n = w * h, prob = new Float32Array(5 * n), ign = new Uint8Array(n);
  for (let i = 0; i < n; i++) { let c = L.data[4 * i]; if (c === 255) { ign[i] = 1; c = 1; } prob[Math.min(4, c) * n + i] = 1; }
  return {seg: {prob, w, h, scale: [1, 1]}, ign, w, h};
}
module.exports = {DS, items, load, oracle};
