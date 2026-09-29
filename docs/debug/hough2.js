'use strict';
const path = require('path'), W = require('../../../www/js/wear/wear-core.js'), readPng = require('../png.js'), {up} = require('./al.js'), {clean} = require('./hough.js');
const DEG = Math.PI / 180;
const GT = {side1: [67, 116], side2: [72, 115.5], side3: [69.5, 115.5], side4: [70, 118]};
let ok = 0, n = 0;
for (const CL of [0, 1]) for (const F of [1, 4, 8]) for (const f of ['side1', 'side2', 'side3', 'side4']) {
  let im = readPng(path.join(__dirname, '..', 'samples', f + '.png')); if (CL) im = clean(im); im = up(im, F);
  const G = W.gray(im), {gx, gy} = W.sobel(G), {w, h, g} = G, mag = new Float32Array(w * h); for (let i = 0; i < w * h; i++) mag[i] = Math.hypot(gx[i], gy[i]);
  // busyness: local mean of gradient magnitude, box radius rb (integral image)
  const rb = Math.max(2, Math.round(Math.max(w, h) / 120)), I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) { let s = 0; for (let x = 0; x < w; x++) { s += Math.min(300, mag[y * w + x]); I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + s; } }
  const busy = (x, y) => { const x0 = Math.max(0, x - rb), x1 = Math.min(w, x + rb + 1), y0 = Math.max(0, y - rb), y1 = Math.min(h, y + rb + 1); return (I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0]) / ((x1 - x0) * (y1 - y0)); };
  const U = Math.ceil(Math.hypot(w, h)), off = U / 2, cx0 = w / 2, cy0 = h / 2, T = 40;
  const cands = [];
  for (let a = -15; a <= 15; a++) { const t = a * DEG, c = Math.cos(t), s = Math.sin(t), C = new Float32Array(U + 1), Bs = new Float64Array(U + 1), Bn = new Float64Array(U + 1);
    for (let y = 1; y < h - 1; y++) for (let x = 2; x < w - 2; x++) { const i = y * w + x, k = Math.round((x - cx0) * c - (y - cy0) * s + off); if ((x + y) % 3 === 0) { Bs[k] += busy(x, y); Bn[k]++; }
      const gu = gx[i] * c - gy[i] * s, gv = gx[i] * s + gy[i] * c, av = Math.abs(gu);
      if (av < T || av < 2 * Math.abs(gv) || mag[i] < mag[i - 1] || mag[i] < mag[i + 1]) continue; C[k] += 1; }
    const Q = new Float32Array(U + 1); for (let i = 1; i < U; i++) Q[i] = C[i - 1] + C[i] + C[i + 1];
    const cb = new Float64Array(U + 2), cn = new Float64Array(U + 2); for (let k = 0; k <= U; k++) { cb[k + 1] = cb[k] + Bs[k]; cn[k + 1] = cn[k] + Bn[k]; }
    const mb = (p, q) => { p = Math.max(0, Math.round(p)); q = Math.min(U + 1, Math.round(q)); const m = cn[q] - cn[p]; return m > 5 ? (cb[q] - cb[p]) / m : NaN; };
    const pk = []; for (let i = 1; i < U; i++) if (Q[i] >= Q[i - 1] && Q[i] > Q[i + 1]) pk.push(i);
    pk.sort((p, q) => Q[q] - Q[p]).splice(14);
    for (const l of pk) for (const r of pk) { const sp = r - l; if (sp < .08 * w || sp > .8 * w) continue;
      const bi = mb(l + .1 * sp, r - .1 * sp), bl = mb(l - .3 * sp, l - .06 * sp), br = mb(r + .06 * sp, r + .3 * sp), bo = Math.max(Number.isNaN(bl) ? 0 : bl, Number.isNaN(br) ? 0 : br);
      const con = (bi - bo) / (bi + bo); if (!(con > 0)) continue;
      cands.push({a, l, r, sc: Math.min(Q[l], Q[r]) / h * con, con, Q, mb}); } }
  const b = cands.sort((p, q) => q.sc - p.sc)[0];
  { const {Q, mb} = b, sp = b.r - b.l, qi = mb(b.l + .1 * sp, b.r - .1 * sp);
    // outward: a weaker parallel edge just outside with quiet background beyond it = the true silhouette (inner one = flute edge)
    for (let u = b.l - 1; u >= b.l - .15 * sp; u--) if (Q[u] >= Q[u - 1] && Q[u] > Q[u + 1] && Q[u] >= +process.argv[2] * Q[b.l]) { const o = mb(u - .3 * sp, u - .04 * sp); if (o < .6 * qi) b.l = u; }
    for (let u = b.r + 1; u <= b.r + .15 * sp; u++) if (Q[u] >= Q[u - 1] && Q[u] > Q[u + 1] && Q[u] >= +process.argv[2] * Q[b.r]) { const o = mb(u + .04 * sp, u + .3 * sp); if (o < .6 * qi) b.r = u; } }
  const L = (b.l - off) / F + w / 2 / F, R = (b.r - off) / F + w / 2 / F, good = Math.abs(L - GT[f][0]) < 3 && Math.abs(R - GT[f][1]) < 3 && Math.abs(b.a) <= 3; ok += good; n++;
  console.log('clean' + CL, F, f, 'GT', GT[f].join(' '), '|', b.a, L.toFixed(1), R.toFixed(1), b.con.toFixed(2), good ? 'OK' : 'BAD');
}
console.log(ok, '/', n);
