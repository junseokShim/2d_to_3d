/* Tool3D photo enhancement before measurement. Pure JS, offline, no DOM in the core; browser (Tool3D.enhance) and Node.
 * enhance(img, opts) -> new RGBA image {width, height, data}. Steps (each can be switched off with opts.<step> = false):
 *  1. wb      grey-world white balance on mid-tones (gains clamped 0.6..1.6)
 *  2. glare   specular clamp: luminance above a knee (p99.5, >= 200) compressed 4:1, so glints no longer saturate the edge
 *  3. denoise light bilateral on luminance (5x5, sigma_s 1.5, sigma_r from the Immerkaer noise estimate)
 *  4. stretch global exposure stretch p1..p99.5 -> 8..245 when the usable range is short (low light)
 *  5. clahe   CLAHE on luminance (8x8 tiles, clip 2.5x mean), bilinear between tile maps
 *  6. sharpen unsharp mask on luminance (Gaussian sigma 1.2, amount 0.6)
 * Colour is carried additively (c' = c_wb + L' - L), so hue is kept and dark pixels do not blow up.
 * Geometry is untouched (same size, same pixel grid): px/mm and silhouette positions do not move.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.enhance = Object.assign(root.Tool3D.enhance || {}, api); }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DEFAULTS = {wb: true, glare: true, denoise: true, stretch: true, clahe: true, sharpen: true, clip: 2.5, tiles: 8, sharpenSigma: 1.2, sharpenAmount: .6};
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v;
  const hist = (g, step = 1) => { const H = new Float64Array(256); let n = 0; for (let i = 0; i < g.length; i += step) { H[clamp(Math.round(g[i]))]++; n++; } return {H, n}; };
  const pct = ({H, n}, p) => { let c = 0; for (let v = 0; v < 256; v++) { c += H[v]; if (c >= p * n) return v; } return 255; };

  function whiteBalance(d, N) {
    let sr = 0, sg = 0, sb = 0;
    for (let i = 0; i < N; i++) { const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2], l = .299 * r + .587 * g + .114 * b; if (l > 20 && l < 235) { sr += r; sg += g; sb += b; } }
    if (!sr || !sg || !sb) return [1, 1, 1];
    const m = (sr + sg + sb) / 3, k = [m / sr, m / sg, m / sb].map(x => Math.max(.6, Math.min(1.6, x)));
    for (let i = 0; i < N; i++) for (let c = 0; c < 3; c++) d[4 * i + c] = clamp(d[4 * i + c] * k[c]);
    return k;
  }

  function noiseSigma(L, w, h) {   // Immerkaer (1996)
    let s = 0, n = 0;
    for (let y = 1; y < h - 1; y += 2) for (let x = 1; x < w - 1; x += 2) {
      const i = y * w + x; s += Math.abs(L[i - w - 1] - 2 * L[i - w] + L[i - w + 1] - 2 * L[i - 1] + 4 * L[i] - 2 * L[i + 1] + L[i + w - 1] - 2 * L[i + w] + L[i + w + 1]); n++;
    }
    return n ? Math.sqrt(Math.PI / 2) * s / (6 * n) : 0;
  }

  function bilateral(L, w, h, sr) {
    const o = new Float32Array(L.length), ws = [], k2 = 1 / (2 * sr * sr);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) ws.push([dx, dy, Math.exp(-(dx * dx + dy * dy) / (2 * 1.5 * 1.5))]);
    const lut = new Float32Array(256); for (let v = 0; v < 256; v++) lut[v] = Math.exp(-v * v * k2);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x, c = L[i]; let s = 0, n = 0;
      for (const [dx, dy, g] of ws) {
        const X = x + dx, Y = y + dy; if (X < 0 || Y < 0 || X >= w || Y >= h) continue;
        const v = L[Y * w + X], q = g * lut[Math.min(255, Math.abs(v - c) | 0)]; s += q * v; n += q;
      }
      o[i] = s / n;
    }
    return o;
  }

  function gauss(L, w, h, sigma) {
    const r = Math.ceil(3 * sigma), k = []; let t = 0; for (let i = -r; i <= r; i++) { const v = Math.exp(-i * i / (2 * sigma * sigma)); k.push(v); t += v; }
    for (let i = 0; i < k.length; i++) k[i] /= t;
    const a = new Float32Array(L.length), b = new Float32Array(L.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let j = -r; j <= r; j++) s += k[j + r] * L[y * w + Math.min(w - 1, Math.max(0, x + j))]; a[y * w + x] = s; }
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let s = 0; for (let j = -r; j <= r; j++) s += k[j + r] * a[Math.min(h - 1, Math.max(0, y + j)) * w + x]; b[y * w + x] = s; }
    return b;
  }

  // contrast-limited adaptive histogram equalisation, tiles x tiles grid, clip = limit relative to the mean bin count
  function clahe(L, w, h, tiles, clip) {
    const tx = Math.max(1, Math.min(tiles, Math.floor(w / 16))), ty = Math.max(1, Math.min(tiles, Math.floor(h / 16)));
    const maps = [];
    for (let j = 0; j < ty; j++) for (let i = 0; i < tx; i++) {
      const x0 = Math.floor(i * w / tx), x1 = Math.floor((i + 1) * w / tx), y0 = Math.floor(j * h / ty), y1 = Math.floor((j + 1) * h / ty);
      const H = new Float64Array(256); let n = 0;
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { H[clamp(Math.round(L[y * w + x]))]++; n++; }
      const lim = Math.max(1, clip * n / 256); let ex = 0;
      for (let v = 0; v < 256; v++) if (H[v] > lim) { ex += H[v] - lim; H[v] = lim; }
      const add = ex / 256, m = new Float32Array(256); let c = 0;
      for (let v = 0; v < 256; v++) { c += H[v] + add; m[v] = 255 * c / n; }
      maps.push(m);
    }
    const o = new Float32Array(L.length), cxs = w / tx, cys = h / ty;
    for (let y = 0; y < h; y++) {
      const fy = Math.max(0, Math.min(ty - 1, (y + .5) / cys - .5)), j0 = Math.floor(fy), j1 = Math.min(ty - 1, j0 + 1), b = fy - j0;
      for (let x = 0; x < w; x++) {
        const fx = Math.max(0, Math.min(tx - 1, (x + .5) / cxs - .5)), i0 = Math.floor(fx), i1 = Math.min(tx - 1, i0 + 1), a = fx - i0, v = clamp(Math.round(L[y * w + x]));
        o[y * w + x] = (maps[j0 * tx + i0][v] * (1 - a) + maps[j0 * tx + i1][v] * a) * (1 - b) + (maps[j1 * tx + i0][v] * (1 - a) + maps[j1 * tx + i1][v] * a) * b;
      }
    }
    return o;
  }

  function enhance(img, opts) {
    const o = Object.assign({}, DEFAULTS, opts), {width: w, height: h} = img, N = w * h, d = new Uint8ClampedArray(img.data), info = {};
    if (o.wb) info.wbGains = whiteBalance(d, N).map(v => Math.round(v * 1e3) / 1e3);
    const L0 = new Float32Array(N); for (let i = 0; i < N; i++) L0[i] = .299 * d[4 * i] + .587 * d[4 * i + 1] + .114 * d[4 * i + 2];
    let L = Float32Array.from(L0);
    if (o.glare) {
      const knee = Math.max(200, pct(hist(L, 3), .995)); let n = 0;
      for (let i = 0; i < N; i++) if (L[i] > knee) { L[i] = knee + (L[i] - knee) / 4; n++; }
      info.glareKnee = knee; info.glareFrac = Math.round(n / N * 1e4) / 1e4;
    }
    if (o.denoise) { const s = noiseSigma(L, w, h); info.noise = Math.round(s * 100) / 100; if (s > 1.5) L = bilateral(L, w, h, Math.max(6, 2.5 * s)); }
    if (o.stretch) {
      const H = hist(L, 3), lo = pct(H, .01), hi = pct(H, .995);
      if (hi - lo < 150 && hi > lo) { const k = (245 - 8) / (hi - lo); for (let i = 0; i < N; i++) L[i] = clamp(8 + (L[i] - lo) * k); info.stretch = [lo, hi]; }
    }
    if (o.clahe) L = clahe(L, w, h, o.tiles, o.clip);
    if (o.sharpen) { const B = gauss(L, w, h, o.sharpenSigma); for (let i = 0; i < N; i++) L[i] = L[i] + o.sharpenAmount * (L[i] - B[i]); }
    for (let i = 0; i < N; i++) { const dl = L[i] - L0[i]; for (let c = 0; c < 3; c++) d[4 * i + c] = clamp(d[4 * i + c] + dl); d[4 * i + 3] = 255; }
    return {width: w, height: h, data: d, info};
  }

  // side photos -> {images: enhanced, quality: per-shot assess() of the original (if quality.js is available)}
  function prepareShots(sides, opts = {}) {
    const Q = (() => { try { return typeof require === 'function' ? require('./quality.js') : null; } catch (e) { return null; } })() || (typeof self !== 'undefined' && self.Tool3D && self.Tool3D.enhance && self.Tool3D.enhance.quality);
    return {images: sides.map(s => s && enhance(s, opts)), quality: sides.map(s => s && Q ? Q.assess(s, {diameterMm: opts.diameterMm}) : null)};
  }

  // browser: image/canvas -> enhanced canvas at the analysis resolution (same downscale as wear.js, so px/mm matches)
  function toCanvas(src, opts = {}) {
    const max = opts.maxPx || 2400, w0 = src.naturalWidth || src.width, h0 = src.naturalHeight || src.height, k = Math.min(1, max / Math.max(w0, h0));
    const c = Object.assign(document.createElement('canvas'), {width: Math.round(w0 * k), height: Math.round(h0 * k)}), x = c.getContext('2d', {willReadFrequently: true});
    x.drawImage(src, 0, 0, c.width, c.height);
    const e = enhance(x.getImageData(0, 0, c.width, c.height), opts), im = x.createImageData(c.width, c.height);
    im.data.set(e.data); x.putImageData(im, 0, 0); c.enhanceInfo = e.info; return c;
  }

  return {DEFAULTS, enhance, prepareShots, toCanvas, whiteBalance, clahe, bilateral, gauss, noiseSigma};
});
