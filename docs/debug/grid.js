const path = require('path'), readPng = require('../png.js'), {writePng} = require('../ai-diag.js');
const f = process.argv[2], F = 4, x0 = 40, y0 = 70, W0 = 110, H0 = 180;
const im = readPng(path.join(__dirname, '..', 'samples', f + '.png')), w = W0 * F, h = H0 * F, o = new Uint8Array(w * h * 3);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const X = x0 + Math.floor(x / F), Y = y0 + Math.floor(y / F), i = 4 * (Y * im.width + X), k = 3 * (y * w + x);
  const grid = (X % 10 === 0 && x % F === 0) || (Y % 10 === 0 && y % F === 0);
  for (let c = 0; c < 3; c++) o[k + c] = grid ? (c === 2 ? 255 : 0) : im.data[i + c]; }
writePng(path.join(__dirname, f + '-grid.png'), w, h, o);
