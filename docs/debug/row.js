const path = require('path'), W = require('../../../www/js/wear/wear-core.js'), readPng = require('../png.js');
for (const f of ['side1', 'side2', 'side3', 'side4']) { const im = readPng(path.join(__dirname, '..', 'samples', f + '.png')), G = W.gray(im);
  for (const y of [120, 160, 200]) { const r = []; for (let x = 50; x < 136; x += 2) r.push(Math.round(G.g[y * G.w + x])); console.log(f, y, r.join(' ')); } }
