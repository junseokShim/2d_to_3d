'use strict';
const path = require('path'), W = require('../../../www/js/wear/wear-core.js'), readPng = require('../png.js'), {up} = require('./al.js');
const DEG = Math.PI / 180;
for (const F of [1, 8]) for (const f of ['side1', 'side2', 'side3', 'side4']) {
  const im = up(readPng(path.join(__dirname, '..', 'samples', f + '.png')), F), G = W.gray(im), {gx, gy} = W.sobel(G), {w, h} = G;
  const U = Math.ceil(Math.hypot(w, h)), off = U / 2, cx0 = w / 2, cy0 = h / 2;
  const proj = t => { const c = Math.cos(t), s = Math.sin(t), P = new Float64Array(U + 1), N = new Float64Array(U + 1);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) { const i = y * w + x, gu = gx[i] * c - gy[i] * s, gv = gx[i] * s + gy[i] * c; if (Math.abs(gu) > 2 * Math.abs(gv)) { const k = Math.round((x - cx0) * c - (y - cy0) * s + off); P[k] += gu; N[k] += Math.abs(gu); } }
    const Q = new Float64Array(U + 1), sm = Math.max(1, Math.round(F / 2)); for (let i = sm; i < U - sm; i++) { let a = 0; for (let j = -sm; j <= sm; j++) a += P[i + j]; Q[i] = a; } return Q; };
  let best = null;
  for (let a = -15; a <= 15; a++) { const t = a * DEG, Q = proj(t); let mx = 0; for (const q of Q) mx = Math.max(mx, Math.abs(q));
    const pk = []; for (let i = 1; i < U; i++) { const q = Math.abs(Q[i]); if (q >= Math.abs(Q[i - 1]) && q > Math.abs(Q[i + 1]) && q > .2 * mx) pk.push(i); }
    for (const l of pk) for (const r of pk) if (r - l > .1 * w && r - l < .6 * w && Q[l] * Q[r] < 0) { const sc = Math.min(Math.abs(Q[l]), Math.abs(Q[r])); if (!best || sc > best.sc) best = {a, l: (l - off) / F + w / 2 / F, r: (r - off) / F + w / 2 / F, sc, sgn: Math.sign(Q[l])}; } }
  console.log(F, f, JSON.stringify(best, (k, v) => typeof v === 'number' ? +v.toFixed(1) : v));
}
