'use strict';
const path = require('path'), W = require('../../../www/js/wear/wear-core.js'), readPng = require('../png.js'), {up} = require('./al.js');
const DEG = Math.PI / 180;
function band(G, grad, t) {
  const {w, h, g} = G, {gx, gy} = grad, c = Math.cos(t), s = Math.sin(t), U = Math.ceil(Math.hypot(w, h)), off = U / 2, cx0 = w / 2, cy0 = h / 2;
  const E = new Float64Array(U + 1), N = new Float64Array(U + 1), B = new Float64Array(U + 1);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x, k = Math.round((x - cx0) * c - (y - cy0) * s + off); E[k] += Math.min(400, Math.hypot(gx[i], gy[i])); N[k]++; }
  for (let k = 0; k <= U; k++) E[k] = N[k] > .3 * h ? E[k] / N[k] : NaN;
  return {E, off, U};
}
for (const F of [1, 4, 8]) for (const f of ['side1', 'side2', 'side3', 'side4']) {
  const im = up(readPng(path.join(__dirname, '..', 'samples', f + '.png')), F), G = W.gray(im), grad = W.sobel(G), {w} = G;
  let best = null;
  for (let a = -15; a <= 15; a++) {
    const {E, off, U} = band(G, grad, a * DEG), cs = new Float64Array(U + 2), cn = new Float64Array(U + 2);
    for (let k = 0; k <= U; k++) { cs[k + 1] = cs[k] + (Number.isNaN(E[k]) ? 0 : E[k]); cn[k + 1] = cn[k] + (Number.isNaN(E[k]) ? 0 : 1); }
    const m = (a0, b0) => { a0 = Math.max(0, a0); b0 = Math.min(U + 1, b0); const n = cn[b0] - cn[a0]; return n > 2 ? (cs[b0] - cs[a0]) / n : NaN; };
    for (let l = 0; l < U; l += Math.max(1, F >> 1)) for (let sep = Math.round(.1 * w); sep < .7 * w; sep += Math.max(1, F >> 1)) {
      const r = l + sep, o = Math.round(.25 * sep), inn = m(l, r), out = Math.max(m(l - o, l), m(r, r + o));
      const J = inn / out; if (Number.isFinite(J) && (!best || J > best.J)) best = {a, l: (l - off) / F + w / 2 / F, r: (r - off) / F + w / 2 / F, J};
    }
  }
  console.log(F, f, JSON.stringify(best, (k, v) => typeof v === 'number' ? +v.toFixed(2) : v));
}
