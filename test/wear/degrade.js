// Camera-quality degradations for synthetic end-mill photos (Node, no deps). Every function takes and returns
// {width, height, data: RGBA} and never changes the input. Used by degrade-run.js to find where real phone photos fail.
'use strict';

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const gauss = r => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
const clone = im => ({width: im.width, height: im.height, data: new Uint8ClampedArray(im.data)});
const map = (im, f) => { const o = clone(im), d = o.data; for (let i = 0; i < d.length; i += 4) { const v = f(d[i], d[i + 1], d[i + 2], i >> 2); d[i] = v[0]; d[i + 1] = v[1]; d[i + 2] = v[2]; } return o; };

// separable Gaussian blur (defocus / camera shake / lens MTF)
function blur(im, sigma) {
  const {width: w, height: h} = im, r = Math.ceil(3 * sigma), k = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-i * i / (2 * sigma * sigma)));
  const s = k.reduce((a, b) => a + b, 0), K = k.map(v => v / s), src = im.data, t = new Float32Array(w * h * 3), o = clone(im);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) { let a = 0; for (let j = -r; j <= r; j++) a += K[j + r] * src[4 * (y * w + Math.min(w - 1, Math.max(0, x + j))) + c]; t[3 * (y * w + x) + c] = a; }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) { let a = 0; for (let j = -r; j <= r; j++) a += K[j + r] * t[3 * (Math.min(h - 1, Math.max(0, y + j)) * w + x) + c]; o.data[4 * (y * w + x) + c] = a; }
  return o;
}

// sensor noise: luminance + chroma Gaussian
function noise(im, sigma, seed = 1) { const r = rng(seed); return map(im, (R, G, B) => { const n = gauss(r) * sigma; return [R + n + gauss(r) * sigma * .4, G + n + gauss(r) * sigma * .4, B + n + gauss(r) * sigma * .4]; }); }

// under-exposure: scene * gain, shot noise, 8-bit quantisation (the phone later brightens it: gamma)
function lowLight(im, gain = .25, seed = 2) {
  const r = rng(seed);
  return map(im, (R, G, B) => [R, G, B].map(v => { const e = v * gain; return Math.round(Math.max(0, e + gauss(r) * Math.sqrt(e + 1) * .8)); }));
}

// colour cast (tungsten / fluorescent white balance error)
const cast = (im, m = [1.25, 1, .7]) => map(im, (R, G, B) => [R * m[0], G * m[1], B * m[2]]);

// JPEG round trip without entropy coding: YCbCr, 4:2:0 chroma, 8x8 DCT, IJG quality-scaled tables, rounding
const QL = [16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99];
const QC = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99].concat(Array(32).fill(99));
function jpeg(im, q = 50) {
  const {width: w, height: h} = im, sc = q < 50 ? 5000 / q : 200 - 2 * q, qt = T => T.map(v => Math.max(1, Math.min(255, Math.floor((v * sc + 50) / 100))));
  const ql = qt(QL), qc = qt(QC), C = Array.from({length: 8}, (_, u) => Array.from({length: 8}, (_, x) => (u ? .5 : Math.SQRT1_2 / 2 * 1) * Math.cos((2 * x + 1) * u * Math.PI / 16)));
  const Y = new Float32Array(w * h), Cb = new Float32Array(w * h), Cr = new Float32Array(w * h), d = im.data;
  for (let i = 0; i < w * h; i++) { const r = d[4 * i], g = d[4 * i + 1], b = d[4 * i + 2]; Y[i] = .299 * r + .587 * g + .114 * b; Cb[i] = 128 - .168736 * r - .331264 * g + .5 * b; Cr[i] = 128 + .5 * r - .418688 * g - .081312 * b; }
  const sub = P => { const W2 = Math.ceil(w / 2), H2 = Math.ceil(h / 2), o = new Float32Array(W2 * H2); for (let y = 0; y < H2; y++) for (let x = 0; x < W2; x++) { let a = 0, n = 0; for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) { const X = 2 * x + i, Yy = 2 * y + j; if (X < w && Yy < h) { a += P[Yy * w + X]; n++; } } o[y * W2 + x] = a / n; } return {p: o, w: W2, h: H2}; };
  const code = ({p, w: W, h: H}, qtab) => {
    const blk = new Float32Array(64), co = new Float32Array(64);
    for (let by = 0; by < H; by += 8) for (let bx = 0; bx < W; bx += 8) {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) blk[y * 8 + x] = p[Math.min(H - 1, by + y) * W + Math.min(W - 1, bx + x)] - 128;
      // C = orthonormal 8x8 DCT basis; transform, quantise + dequantise, inverse transform
      for (let k = 0; k < 64; k++) { let a = 0; for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) a += C[k % 8][x] * C[k >> 3][y] * blk[y * 8 + x]; co[k] = Math.round(a / qtab[k]) * qtab[k]; }
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { if (by + y >= H || bx + x >= W) continue; let a = 0; for (let v = 0; v < 8; v++) for (let u = 0; u < 8; u++) a += C[u][x] * C[v][y] * co[v * 8 + u]; p[(by + y) * W + bx + x] = a + 128; }
    }
  };
  const full = {p: Y, w, h}, cb = sub(Cb), cr = sub(Cr);
  code(full, ql); code(cb, qc); code(cr, qc);
  const o = clone(im);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, j = (y >> 1) * cb.w + (x >> 1), yy = Y[i], u = cb.p[j] - 128, v = cr.p[j] - 128;
    o.data[4 * i] = yy + 1.402 * v; o.data[4 * i + 1] = yy - .344136 * u - .714136 * v; o.data[4 * i + 2] = yy + 1.772 * u;
  }
  return o;
}

// perspective: camera pitched by `k` (keystone: top row scaled by 1-k about the centre) plus a small roll, bilinear
function perspective(im, k = .08, rollDeg = 4) {
  const {width: w, height: h, data: d} = im, o = clone(im), cr = Math.cos(rollDeg * Math.PI / 180), sr = Math.sin(rollDeg * Math.PI / 180);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let X = x - w / 2, Y = y - h / 2; const t = Y / h + .5, s = 1 - k * (1 - t);   // output row -> scale of that row
    X /= s; const xr = X * cr - Y * sr + w / 2, yr = X * sr + Y * cr + h / 2;
    const x0 = Math.floor(xr), y0 = Math.floor(yr), fx = xr - x0, fy = yr - y0, i = 4 * (y * w + x);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) { o.data.set([90, 88, 85], i); continue; }
    for (let c = 0; c < 3; c++) { const j = 4 * (y0 * w + x0) + c; o.data[i + c] = (d[j] * (1 - fx) + d[j + 4] * fx) * (1 - fy) + (d[j + 4 * w] * (1 - fx) + d[j + 4 * w + 4] * fx) * fy; }
  }
  return o;
}

// cluttered background: a bright bar parallel to the tool (fixture/ruler edge), a ruler with ticks, a table edge,
// dark and bright blobs. `mask(x, y)` says where the tool is (clutter is drawn only outside it).
function clutter(im, isTool, seed = 5) {
  const {width: w, height: h} = im, r = rng(seed), o = clone(im), put = (x, y, c) => { if (x >= 0 && y >= 0 && x < w && y < h && !isTool(x, y)) o.data.set(c, 4 * (y * w + x)); };
  const bx = Math.round(w * .06);
  for (let y = 0; y < h; y++) for (let x = bx; x < bx + Math.round(w * .05); x++) put(x, y, [235, 232, 225]);                 // bright bar
  for (let y = 0; y < h; y++) for (let x = w - Math.round(w * .12); x < w - Math.round(w * .02); x++) put(x, y, [215, 190, 60]); // ruler
  for (let y = 0; y < h; y += Math.max(3, Math.round(h / 60))) for (let x = w - Math.round(w * .12); x < w - Math.round(w * .07); x++) put(x, y, [20, 20, 20]);
  const ty = Math.round(h * .8); for (let y = ty; y < h; y++) for (let x = 0; x < w; x++) if (!isTool(x, y)) { const j = 4 * (y * w + x); o.data[j] *= .6; o.data[j + 1] *= .6; o.data[j + 2] *= .6; }
  for (let b = 0; b < 6; b++) { const cx = r() * w, cy = r() * h, rr = 8 + r() * w * .05, c = r() < .5 ? [30, 30, 35] : [220, 215, 200]; for (let y = cy - rr; y < cy + rr; y++) for (let x = cx - rr; x < cx + rr; x++) if ((x - cx) ** 2 + (y - cy) ** 2 < rr * rr) put(Math.round(x), Math.round(y), c); }
  return o;
}

// fingers holding the shank: two skin-coloured capsules crossing the lower tool body from the left
function fingers(im, y0) {
  const {width: w, height: h} = im, o = clone(im);
  for (const [cy, len] of [[y0, .55], [y0 + h * .09, .6]]) for (let y = Math.round(cy - h * .035); y < cy + h * .035; y++) for (let x = 0; x < w * len; x++) {
    if (y < 0 || y >= h) continue; const e = Math.hypot(Math.max(0, x - w * (len - .04)) / (w * .04), (y - cy) / (h * .035)); if (e > 1) continue;
    const sh = .8 + .2 * Math.cos((y - cy) / (h * .035) * 1.4); o.data.set([225 * sh, 170 * sh, 145 * sh], 4 * (y * w + x));
  }
  return o;
}

// area downsample by an integer factor (a far shot with the same phone: fewer px/mm)
function down(im, f) {
  const W = Math.floor(im.width / f), H = Math.floor(im.height / f), o = {width: W, height: H, data: new Uint8ClampedArray(W * H * 4)};
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (let c = 0; c < 4; c++) { let a = 0; for (let j = 0; j < f; j++) for (let i = 0; i < f; i++) a += im.data[4 * ((y * f + j) * im.width + x * f + i) + c]; o.data[4 * (y * W + x) + c] = a / f / f; }
  return o;
}

// embed a photo in a larger frame (tool small in a big phone photo)
function pad(im, W, H, bg = [120, 118, 112]) {
  const o = {width: W, height: H, data: new Uint8ClampedArray(W * H * 4)}, ox = (W - im.width) >> 1, oy = (H - im.height) >> 1;
  for (let i = 0; i < W * H; i++) o.data.set([...bg, 255], 4 * i);
  for (let y = 0; y < im.height; y++) o.data.set(im.data.subarray(4 * y * im.width, 4 * (y + 1) * im.width), 4 * ((y + oy) * W + ox));
  return o;
}

module.exports = {rng, blur, noise, lowLight, cast, jpeg, perspective, clutter, fingers, down, pad};
