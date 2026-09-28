'use strict';
const path = require('path'), W = require('../../../www/js/wear/wear-core.js'), readPng = require('../png.js'), {up} = require('./al.js');
const DEG = Math.PI / 180;
const clean = img => { const {width: w, height: h, data: d} = img, o = new Uint8ClampedArray(d), yel = i => d[i] > d[i + 2] + 45 && d[i + 1] > d[i + 2] + 45 && Math.abs(d[i] - d[i + 1]) < 60;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const i = 4 * (y * w + x); if (!yel(i)) continue; let n = 0, s = [0, 0, 0];
    for (let r = 1; r < 6 && !n; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue; const j = 4 * (Y * w + X); if (!yel(j)) { n++; for (let c = 0; c < 3; c++) s[c] += d[j + c]; } }
    if (n) for (let c = 0; c < 3; c++) o[i + c] = s[c] / n; }
  return {width: w, height: h, data: o}; };
module.exports = {clean};
const GT = {side1: [67, 116], side2: [72, 115.5], side3: [69.5, 115.5], side4: [70, 118]};
if (require.main === module) for (const CL of [0, 1]) for (const F of [1, 4, 8]) for (const f of ['side1', 'side2', 'side3', 'side4']) {
  let im = readPng(path.join(__dirname, '..', 'samples', f + '.png')); if (CL) im = clean(im); im = up(im, F);
  const G = W.gray(im), {gx, gy} = W.sobel(G), {w, h} = G, mag = new Float32Array(w * h); for (let i = 0; i < w * h; i++) mag[i] = Math.hypot(gx[i], gy[i]);
  const U = Math.ceil(Math.hypot(w, h)), off = U / 2, cx0 = w / 2, cy0 = h / 2, T = 40;
  const count = t => { const c = Math.cos(t), s = Math.sin(t), C = new Float32Array(U + 1);
    for (let y = 1; y < h - 1; y++) for (let x = 2; x < w - 2; x++) { const i = y * w + x, gu = gx[i] * c - gy[i] * s, gv = gx[i] * s + gy[i] * c, a = Math.abs(gu);
      if (a < T || a < 2 * Math.abs(gv) || mag[i] < mag[i - 1] || mag[i] < mag[i + 1]) continue; C[Math.round((x - cx0) * c - (y - cy0) * s + off)] += 1; }
    const Q = new Float32Array(U + 1); for (let i = 1; i < U; i++) Q[i] = C[i - 1] + C[i] + C[i + 1]; return Q; };
  const cands = [];
  for (let a = -15; a <= 15; a++) { const t = a * DEG, Q = count(t); const pk = []; for (let i = 1; i < U; i++) if (Q[i] >= Q[i - 1] && Q[i] > Q[i + 1]) pk.push(i);
    pk.sort((p, q) => Q[q] - Q[p]).splice(12);
    for (const l of pk) for (const r of pk) if (r - l > .08 * w && r - l < .8 * w) cands.push({a, l, r, sc: Math.min(Q[l], Q[r])}); }
  const top = Math.max(...cands.map(c => c.sc)); const b = cands.filter(c => c.sc >= .7 * top).sort((p, q) => (q.r - q.l) - (p.r - p.l))[0], bb = cands.sort((p, q) => q.sc - p.sc)[0];
  const cv = c => [c.a, ((c.l - off) / F + w / 2 / F).toFixed(1), ((c.r - off) / F + w / 2 / F).toFixed(1), (c.sc / h).toFixed(2)].join(' ');
  console.log('clean' + CL, F, f, 'GT', GT[f].join(' '), '| widest-strong', cv(b), '| strongest', cv(bb));
}
