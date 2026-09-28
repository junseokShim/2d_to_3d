/* Tool3D wear, AI stage: pretrained-feature anomaly detection of the worn flank land (self-referenced PatchCore).
 * Needs wear-core.js. Runs offline: onnxruntime-web (wasm, www/vendor/ort) + ResNet-18 ImageNet backbone (www/models).
 *
 * Why this works without wear training data: the same photo shows unworn body (flutes, lands, margins, glints) above
 * the wear zone. Its patch features (ResNet-18 layer2+layer3, 3x3 pooled, stride 8) form the memory bank. A patch in
 * the wear zone is worn when it is unlike every body patch: score = nearest-neighbour distance / body self-distance
 * (99th percentile, cross-validated on held-out body rows). Score > 1 marks wear regions at patch resolution; the
 * boundary is then placed per pixel with the colour model of wear-core (half-contrast), so VB keeps pixel accuracy.
 * The AI region replaces the brightness/colour guess of "what is wear"; the VB/area/volume maths is unchanged.
 *
 * Browser: await Tool3D.wear.ai.run(shots, opts)  -> same contract as Tool3D.wear.run (wearResult), engine 'ai'.
 * Node:    require('ai-wear.js').createSegmenter(runFeatures, core)
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.Tool3D = root.Tool3D || {}; root.Tool3D.wear = root.Tool3D.wear || {}; root.Tool3D.wear.ai = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const NET_TOOL_PX = 320;   // tool diameter in network pixels (one feature cell = D/40)
  const STRIDE = 8, PAD = 32, PROJ = 128, BANK = 2000;

  function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  const quant = (a, p) => { const b = Float32Array.from(a).sort(); return b.length ? b[Math.min(b.length - 1, Math.floor(p * b.length))] : 0; };

  // strip (rectified side, tip at row `top`) -> network input; rows above the tip are mirrored so the tip boundary
  // (tool -> background) does not look like damage; outside the photo = mean body colour
  function netInput(strip) {
    const {w, h, rgb, g, R, top} = strip, sc = NET_TOOL_PX / (2 * R);
    const Wn = Math.ceil(w * sc / 16) * 16, Hn = Math.ceil((PAD + (h - top) * sc) / 16) * 16, x = new Float32Array(3 * Wn * Hn);
    let mr = 0, mg = 0, mb = 0, n = 0;
    for (let i = top * w; i < w * h; i += 7) if (!Number.isNaN(g[i])) { mr += rgb[3 * i]; mg += rgb[3 * i + 1]; mb += rgb[3 * i + 2]; n++; }
    const mean = [mr / n / 255, mg / n / 255, mb / n / 255], P = Wn * Hn;
    for (let Y = 0; Y < Hn; Y++) {
      let yy = (Y - PAD + .5) / sc - .5; if (yy < 0) yy = -yy;
      const ys = top + yy, y0 = Math.min(h - 2, Math.floor(ys)), fy = ys - y0;
      for (let X = 0; X < Wn; X++) {
        const xs = (X + .5) / sc - .5, x0 = Math.max(0, Math.min(w - 2, Math.floor(xs))), fx = Math.max(0, Math.min(1, xs - x0)), o = Y * Wn + X;
        const i = y0 * w + x0;
        if (ys > h - 1 || Number.isNaN(g[i]) || Number.isNaN(g[i + 1]) || Number.isNaN(g[i + w]) || Number.isNaN(g[i + w + 1])) { for (let c = 0; c < 3; c++) x[c * P + o] = mean[c]; continue; }
        for (let c = 0; c < 3; c++) x[c * P + o] = ((rgb[3 * i + c] * (1 - fx) + rgb[3 * i + 3 + c] * fx) * (1 - fy) + (rgb[3 * (i + w) + c] * (1 - fx) + rgb[3 * (i + w) + 3 + c] * fx) * fy) / 255;
      }
    }
    // cell centre -> strip coordinates
    const cell = (i, j) => [(STRIDE * j + STRIDE / 2 - .5 + .5) / sc - .5, top + (STRIDE * i + STRIDE / 2 - PAD) / sc - .5];
    return {x, Wn, Hn, sc, cell};
  }

  // fixed random projection 384 -> 128 (Johnson-Lindenstrauss; keeps nearest-neighbour distances, 3x faster search)
  let projM = null;
  function project(F, C, n) {
    if (!projM || projM.C !== C) { const r = rng(12345), M = new Float32Array(C * PROJ); for (let i = 0; i < M.length; i++) { const u = r() || 1e-9, v = r(); M[i] = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) / Math.sqrt(PROJ); } projM = {M, C}; }
    const out = new Float32Array(n * PROJ), M = projM.M;
    for (let c = 0; c < C; c++) { const Fc = F.subarray(c * n, (c + 1) * n); for (let k = 0; k < PROJ; k++) { const m = M[c * PROJ + k]; if (!m) continue; for (let p = 0; p < n; p++) out[p * PROJ + k] += m * Fc[p]; } }
    return out;
  }
  function nn(Q, qi, B, bank) {
    let best = Infinity; const q = qi * PROJ;
    for (const b of bank) { let d = 0; const o = b * PROJ; for (let k = 0; k < PROJ; k++) { const t = Q[q + k] - B[o + k]; d += t * t; if (d >= best) break; } if (d < best) best = d; }
    return Math.sqrt(best);
  }
  const sample = (a, n, seed) => { if (a.length <= n) return a; const r = rng(seed), b = a.slice(); for (let i = 0; i < n; i++) { const j = i + Math.floor(r() * (b.length - i)); [b[i], b[j]] = [b[j], b[i]]; } return b.slice(0, n); };

  // features {data (C x fh x fw), C, fh, fw} + strip -> anomaly score per cell (1 = the body's own 99th percentile)
  function anomalyCells(feat, strip, zoneRows, refRows, cellFn) {
    const {C, fh, fw, data} = feat, n = fh * fw, Z = project(data, C, n), {g, w, cx, R, top} = strip;
    const kind = new Int8Array(n), rowOf = new Int32Array(n);   // 1 = query (wear zone), 2 = reference body
    for (let i = 0; i < fh; i++) for (let j = 0; j < fw; j++) {
      const [xs, ys] = cellFn(i, j), c = i * fw + j; rowOf[c] = i;
      const xi = Math.round(xs), yi = Math.round(ys);
      if (Math.abs(xs - cx) >= R || yi >= strip.h || xi < 0 || xi >= w) continue;
      if (yi >= top - 2 && yi < top + zoneRows) kind[c] = 1;
      // reference: fully inside the photo (cell +-1 cell) and beyond the zone
      else if (refRows && yi >= refRows[0] && yi < refRows[1] - STRIDE) {
        let ok = true; for (const dy of [-6, 0, 6]) for (const dx of [-6, 0, 6]) { const yy = Math.round(ys + dy / (NET_TOOL_PX / (2 * R))), xx = Math.round(xs + dx / (NET_TOOL_PX / (2 * R))); if (yy < 0 || yy >= strip.h || xx < 0 || xx >= w || Number.isNaN(g[yy * w + xx])) ok = false; }
        if (ok) kind[c] = 2;
      }
    }
    const ref = [], qry = []; for (let c = 0; c < n; c++) { if (kind[c] === 2) ref.push(c); else if (kind[c] === 1) qry.push(c); }
    if (ref.length < 60) throw new Error(`AI: too little unworn body in the photo for a reference (${ref.length} cells)`);
    // calibration: body cells scored against a bank built from the other block of rows (blocks of 4 cell rows)
    const A = ref.filter(c => (rowOf[c] >> 2) % 2 === 0), B = ref.filter(c => (rowOf[c] >> 2) % 2 === 1), self = [];
    if (A.length >= 20 && B.length >= 20) {
      const bA = sample(A, BANK, 1), bB = sample(B, BANK, 2);
      for (const c of sample(B, 400, 3)) self.push(nn(Z, c, Z, bA));
      for (const c of sample(A, 400, 4)) self.push(nn(Z, c, Z, bB));
    }
    const tau = Math.max(1e-6, self.length ? quant(self, .99) : 1), bank = sample(ref, BANK, 5), score = new Float32Array(n);
    for (const c of qry) score[c] = nn(Z, c, Z, bank) / tau;
    return {score, kind, tau, nRef: ref.length, nQuery: qry.length};
  }

  // cell scores -> per-pixel map on the strip (bilinear between cell centres)
  function upsample(score, fh, fw, strip, sc) {
    const {w, h, top} = strip, out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      const I = ((y - top + .5) * sc + PAD - STRIDE / 2) / STRIDE, i0 = Math.max(0, Math.min(fh - 2, Math.floor(I))), fi = Math.max(0, Math.min(1, I - i0));
      for (let x = 0; x < w; x++) {
        const J = ((x + .5) * sc - STRIDE / 2) / STRIDE, j0 = Math.max(0, Math.min(fw - 2, Math.floor(J))), fj = Math.max(0, Math.min(1, J - j0)), k = i0 * fw + j0;
        out[y * w + x] = (score[k] * (1 - fj) + score[k + 1] * fj) * (1 - fi) + (score[k + fw] * (1 - fj) + score[k + fw + 1] * fj) * fi;
      }
    }
    return out;
  }

  // runFeatures(x Float32Array, H, W) -> Promise<{data, C, fh, fw}>;  core = wear-core api
  function createSegmenter(runFeatures, core, opts = {}) {
    const aiK = opts.aiK || 1;
    return async function segmentAI(P) {
      const {strip, zoneRows, o} = P;
      if (!strip.rgb) throw new Error('AI: colour strip missing');
      const inp = netInput(strip), feat = await runFeatures(inp.x, inp.Hn, inp.Wn);
      const rows = core.refRows(strip, zoneRows);
      const an = anomalyCells(feat, strip, zoneRows, rows, inp.cell);
      const {w, h, g, cx, R, top} = strip, up = upsample(an.score, feat.fh, feat.fw, strip, inp.sc), y1 = Math.min(h, top + zoneRows);
      const region = new Uint8Array(w * h);
      for (let y = Math.max(0, top - 1); y < y1; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (Math.abs(x - cx) < .96 * R && !Number.isNaN(g[i]) && up[i] > aiK) region[i] = 1; }
      // pixel boundary: colour score of the classic model, restricted to the AI region grown by one feature cell
      const cls = core.segmentColor(strip, zoneRows, o), grow = Math.ceil(STRIDE / inp.sc);
      let seg;
      if (cls.score) {
        const near = dilate(region, w, h, grow), raw = new Uint8Array(w * h);
        let nr = 0, ni = 0; for (let i = 0; i < w * h; i++) { if (region[i]) nr++; if (near[i] && cls.score[i] > .5) { raw[i] = 1; ni++; } }
        if (nr && ni >= .25 * nr) {   // wear shows colour contrast: pixel-accurate edge (half contrast)
          const sc2 = new Float32Array(w * h); for (let i = 0; i < w * h; i++) sc2[i] = raw[i] ? Math.max(cls.score[i], 1.0001) : 0;
          seg = core.refineBand(strip, core.bandFromMask(strip, raw), sc2);
          seg.edge = 'color';
        }
      }
      if (!seg) { seg = {band: core.bandFromMask(strip, region), edge: 'ai-map'}; }   // texture-only wear: AI map boundary
      return Object.assign(seg, {thr: an.tau, med: 0, sig: 0, y1, method: 'ai', classicBand: cls.band,
        ai: {tau: an.tau, nRef: an.nRef, nQuery: an.nQuery, fh: feat.fh, fw: feat.fw, maxScore: Math.max(0, ...an.score), cells: an.score, sc: inp.sc}});
    };
  }
  function dilate(m, w, h, r) {
    const a = new Uint8Array(w * h), b = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) { let last = -1e9; for (let x = 0; x < w; x++) { if (m[y * w + x]) last = x; if (x - last <= r) a[y * w + x] = 1; } last = 1e9; for (let x = w - 1; x >= 0; x--) { if (m[y * w + x]) last = x; if (last - x <= r) a[y * w + x] = 1; } }
    for (let x = 0; x < w; x++) { let last = -1e9; for (let y = 0; y < h; y++) { if (a[y * w + x]) last = y; if (y - last <= r) b[y * w + x] = 1; } last = 1e9; for (let y = h - 1; y >= 0; y--) { if (a[y * w + x]) last = y; if (last - y <= r) b[y * w + x] = 1; } }
    return b;
  }

  // ---------- browser: lazy-load onnxruntime-web + model (works from file://, https://localhost and http) ----------
  let sessionP = null;
  const base = () => { const s = typeof document !== 'undefined' && [...document.scripts].find(e => /js\/wear\/ai-wear\.js/.test(e.src)); return s ? s.src.replace(/js\/wear\/ai-wear\.js.*$/, '') : ''; };
  const loadScript = src => new Promise((ok, bad) => { const e = document.createElement('script'); e.src = src; e.onload = ok; e.onerror = () => bad(new Error('load ' + src)); document.head.appendChild(e); });
  const b64 = s => { const bin = atob(s), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  function load() {
    if (sessionP) return sessionP;
    sessionP = (async () => {
      const T = self.Tool3D, b = base();
      if (!self.ort) await loadScript(b + 'vendor/ort/ort.wasm.min.js');
      if (!T.ortGlue) await loadScript(b + 'vendor/ort/ort-wasm-glue.js');
      if (!T.ortWasmB64) await loadScript(b + 'vendor/ort/ort-wasm-bin.js');
      if (!T.aiModelB64) await loadScript(b + 'models/wear-backbone.onnx.js');
      const ort = self.ort;
      ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
      ort.env.wasm.wasmBinary = b64(T.ortWasmB64);
      ort.env.wasm.wasmPaths = {mjs: URL.createObjectURL(new Blob([T.ortGlue], {type: 'text/javascript'}))};
      const session = await ort.InferenceSession.create(b64(T.aiModelB64), {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
      T.aiModelB64 = T.ortWasmB64 = null;   // free the base64 copies
      return {ort, session};
    })();
    sessionP.catch(() => { sessionP = null; });
    return sessionP;
  }
  const ortRunner = ({ort, session}) => async (x, H, W) => {
    const out = (await session.run({image: new ort.Tensor('float32', x, [1, 3, H, W])})).features;
    return {data: out.data, C: out.dims[1], fh: out.dims[2], fw: out.dims[3]};
  };

  // same inputs as Tool3D.wear.run; resolves to the wearResult (engine 'ai'); sides the AI cannot handle use the classic path
  async function run(shots, opts) {
    const T = self.Tool3D, W = T.wear, k = opts.flutes;
    const sides = shots.slice(0, k).filter(Boolean).map(W.toImage), top = shots[k] ? W.toImage(shots[k]) : null;
    if (sides.length < k) throw new Error(`wear: need ${k} side photos, got ${sides.length}`);
    const t0 = Date.now(), rt = await load(), seg = createSegmenter(ortRunner(rt), W);
    const {result, debug} = await W.measureAsync(Object.assign({}, opts, {sides, top}), seg, 'ai');
    debug.aiMs = Date.now() - t0;
    T.wearResult = result; T.wearDebug = debug;
    window.dispatchEvent(new CustomEvent('tool3d:wear', {detail: result}));
    return result;
  }

  return {createSegmenter, netInput, anomalyCells, upsample, load, run, NET_TOOL_PX};
});
