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
  let NET_TOOL_PX = 320;     // tool diameter in network pixels (one feature cell = D/40)
  const EDGE_U = .9, STRIDE = 8, PAD = 32, PROJ = 128, BANK = 2000, COLW = 2, AIK = 1.5, HOLD = 4, MINSEP = 25;

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

  // one side: features -> projected patch vectors, cell kind (1 = query in the wear zone, 2 = unworn body reference),
  // cell row and column key (column relative to the tool axis, in cells; same key = same place on the cylinder)
  function cellsOf(feat, strip, zoneRows, refRows, cellFn) {
    const {C, fh, fw, data} = feat, n = fh * fw, Z = project(data, C, n), {g, w, cx, R, top} = strip, cw = STRIDE * 2 * R / NET_TOOL_PX;
    const kind = new Int8Array(n), rowOf = new Int32Array(n), col = new Int16Array(n);
    for (let i = 0; i < fh; i++) for (let j = 0; j < fw; j++) {
      const [xs, ys] = cellFn(i, j), c = i * fw + j; rowOf[c] = i; col[c] = Math.round((xs - cx) / cw);
      const xi = Math.round(xs), yi = Math.round(ys);
      if (Math.abs(xs - cx) >= R || yi >= strip.h || xi < 0 || xi >= w) continue;
      if (ys >= top && yi < top + zoneRows) kind[c] = 1;   // mirrored rows above the tip are padding, never queried
      // reference: fully inside the photo (cell +-1 cell) and beyond the zone
      else if (refRows && yi >= refRows[0] && yi < refRows[1] - STRIDE) {
        let ok = true; for (const dy of [-6, 0, 6]) for (const dx of [-6, 0, 6]) { const yy = Math.round(ys + dy / (NET_TOOL_PX / (2 * R))), xx = Math.round(xs + dx / (NET_TOOL_PX / (2 * R))); if (yy < 0 || yy >= strip.h || xx < 0 || xx >= w || Number.isNaN(g[yy * w + xx])) ok = false; }
        if (ok) kind[c] = 2;
      }
    }
    return {Z, kind, rowOf, col, n};
  }

  // PatchCore with a memory bank built at run time from the unworn body of the SAME tool: the body rows of every side
  // photo beyond the wear zone, pooled over all sides (each side shows the flutes at another helix phase). A query patch is
  // compared only with bank patches of its own column band (+-COLW cells): same curvature, silhouette and background.
  // Score = nearest-neighbour distance / tau, tau = 99th percentile of body-vs-body distances with the bank rows within
  // +-HOLD cell rows of the probe held out on every side (other flutes repeat the same rows, so holding out a side is not enough).
  function anomalyPooled(sides) {
    const E = [];   // bank entries: side, cell, column, cell row
    sides.forEach((S, s) => { for (let c = 0; c < S.n; c++) if (S.kind[c] === 2) E.push({s, c, col: S.col[c], row: S.rowOf[c]}); });
    if (E.length < 60) throw new Error(`AI: too little unworn body in the photos for a reference (${E.length} cells)`);
    const Zb = new Float32Array(E.length * PROJ);
    E.forEach((e, k) => Zb.set(sides[e.s].Z.subarray(e.c * PROJ, (e.c + 1) * PROJ), k * PROJ));
    const byCol = new Map();
    E.forEach((e, k) => { for (let d = -COLW; d <= COLW; d++) { const q = e.col + d; if (!byCol.has(q)) byCol.set(q, []); byCol.get(q).push(k); } });
    const self = [];
    for (const k of sample(E.map((_, k) => k), 800, 3)) {
      const e = E[k], b = (byCol.get(e.col) || []).filter(m => Math.abs(E[m].row - e.row) >= HOLD);
      if (b.length >= 8) self.push(nn(Zb, k, Zb, sample(b, BANK, k)));
    }
    const tau = Math.max(1e-6, self.length >= 40 ? quant(self, .99) : 1), banks = new Map();
    for (const [c, b] of byCol) banks.set(c, sample(b, BANK, 5 + c));
    return sides.map(S => {
      const score = new Float32Array(S.n); let nQuery = 0;
      for (let c = 0; c < S.n; c++) if (S.kind[c] === 1) { const b = banks.get(S.col[c]); nQuery++; score[c] = b && b.length ? nn(S.Z, c, Zb, b) / tau : 0; }
      return {score, tau, nRef: E.length, nQuery};
    });
  }
  // single photo (bank = its own body only)
  const anomalyCells = (feat, strip, zoneRows, refRows, cellFn) => anomalyPooled([cellsOf(feat, strip, zoneRows, refRows, cellFn)])[0];

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
  // Returns segmentAI(P) (one photo, own bank) with segmentAI.batch(Ps) (all sides of one tool, pooled bank; measureAsync uses it).
  function createSegmenter(runFeatures, core, opts = {}) {
    const aiK = opts.aiK || AIK; if (opts.netPx) NET_TOOL_PX = opts.netPx;
    async function featuresOf(P) {
      const {strip, zoneRows} = P;
      if (!strip.rgb) throw new Error('AI: colour strip missing');
      const inp = netInput(strip), feat = await runFeatures(inp.x, inp.Hn, inp.Wn);
      return {P, inp, feat, cells: cellsOf(feat, strip, zoneRows, core.refRows(strip, zoneRows), inp.cell)};
    }
    function finish({P: {strip, zoneRows, o}, inp, feat}, an) {
      const {w, h, g, cx, R, top} = strip, up = upsample(an.score, feat.fh, feat.fw, strip, inp.sc), y1 = Math.min(h, top + zoneRows);
      // gates: glints (+ their blended rim) are never wear; the silhouette rim (|u| > EDGE_U R) is foreshortened to a few px
      // per mm of arc and carries background bleed, so it is not scored
      const region = new Uint8Array(w * h), gl = core.glintMask(strip);
      for (let y = Math.max(0, top - 1); y < y1; y++) for (let x = 0; x < w; x++) { const i = y * w + x; if (Math.abs(x - cx) < EDGE_U * R && !Number.isNaN(g[i]) && !gl[i] && up[i] > aiK) region[i] = 1; }
      // pixel boundary (the AI map is one feature cell = D/40 coarse): nearest-prototype colour split, seeded by the AI
      // region. Body prototypes = the k-means colours of the unworn body (classic colour model, glints excluded).
      // A pixel is worn when it is nearer the wear prototype than every body colour.
      const cls = core.segmentColor(strip, zoneRows, o), grow = Math.ceil(STRIDE / inp.sc), cm = cls.colorModel, rgb = strip.rgb;
      let seg;
      if (cm) {
        const idx = []; for (let i = 0; i < w * h; i++) if (region[i]) idx.push(i);
        const d2 = (p, q) => (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2, px = i => [rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]];
        const dBody = p => Math.min(...cm.C.map(q => d2(p, q))), db = new Map(idx.map(i => [i, dBody(px(i))]));
        // wear prototype: median colour of the third of the AI region least like any body colour (the AI cell is coarser
        // than a thin band, so the region also holds body pixels; those are the most body-like and drop out here)
        idx.sort((a, b) => db.get(b) - db.get(a));
        const hi = idx.slice(0, Math.max(1, Math.ceil(idx.length / 3))), med = c => quant(hi.map(i => rgb[3 * i + c]), .5), P0 = [med(0), med(1), med(2)];
        const sep = Math.sqrt(dBody(P0));
        if (idx.length && sep >= MINSEP) {   // wear has its own colour: pixel-accurate edge
          // wear-coloured pixels of the zone, then only the connected pieces that touch the AI seed (hysteresis: the AI
          // says where, the colour says how far; a thin band along the edge keeps growing where the AI map is too coarse)
          const near = dilate(region, w, h, grow), cand = new Uint8Array(w * h), raw = new Uint8Array(w * h), st = [];
          for (let y = top + 1; y < y1; y++) for (let x = 0; x < w; x++) {   // row `top` blends tool and background
            const i = y * w + x; if (Math.abs(x - cx) >= EDGE_U * R || gl[i] || Number.isNaN(g[i])) continue;
            const p = px(i); if (d2(p, P0) < dBody(p)) { cand[i] = 1; if (near[i]) { raw[i] = 1; st.push(i); } }
          }
          while (st.length) { const i = st.pop(), x = i % w; for (const j of [i - 1, i + 1, i - w, i + w]) if (j >= 0 && j < w * h && Math.abs(j % w - x) <= 1 && cand[j] && !raw[j]) { raw[j] = 1; st.push(j); } }
          seg = {band: rimFill(core.bandFromMask(strip, raw), gl, strip), edge: 'color', wearRGB: P0.map(Math.round), sep: Math.round(sep)};
        }
      }
      let mx = 0, nSeed = 0; for (const v of an.score) if (v > mx) mx = v; for (const v of region) nSeed += v;
      // no colour of its own: texture-only wear is accepted only on a strong AI score, else it is structure the bank missed
      if (!seg) seg = mx > 2 * aiK ? {band: core.bandFromMask(strip, region), edge: 'ai-map'} : {band: new Uint8Array(w * h), edge: 'none'};
      // tip damage (chipping / broken end teeth) is measured the classic way, outside the AI band
      const tip = cm && core.tipDamage ? core.tipDamage(strip, cm, cls.thr, seg.band) : cls.tip;
      return Object.assign(seg, {thr: an.tau, med: 0, sig: 0, y1, method: 'ai', classicBand: cls.band, tip,
        ai: {edge: seg.edge, sep: seg.sep, seedPx: nSeed, tau: an.tau, nRef: an.nRef, nQuery: an.nQuery, fh: feat.fh, fw: feat.fw, maxScore: mx, cells: an.score, sc: inp.sc}});
    }
    const segmentAI = async P => { const F = await featuresOf(P); return finish(F, anomalyPooled([F.cells])[0]); };
    // all sides of one tool: features one after another (one wasm session), one pooled bank; an Error per failed side
    segmentAI.batch = async Ps => {
      const F = [];
      for (const P of Ps) F.push(P ? await featuresOf(P).catch(e => e) : null);
      const ok = F.filter(f => f && !(f instanceof Error));
      let an; try { an = anomalyPooled(ok.map(f => f.cells)); } catch (e) { return F.map(f => f && e); }
      return F.map(f => !f ? null : f instanceof Error ? f : finish(f, an[ok.indexOf(f)]));
    };
    // memory bank = unworn body beyond the zone; use as much of the photo as there is (the helix pattern repeats only
    // every pitch/tan(helix) along the axis, so a short reference misses flute phases and flags them as wear)
    segmentAI.prepare = a => ({stripMm: a.stripMm || 3 * a.diameterMm});
    return segmentAI;
  }
  // the glint gate also removed the 1-2 px rim between glint and wear; give those rim pixels back to a band that touches
  // them, so VB is measured from the glint (the cutting edge), not from 2 px behind it. The glint core stays out.
  function rimFill(band, gl, strip) {
    const {w, h, rgb} = strip, T = 225;
    for (let it = 0; it < 2; it++) {
      const add = [];
      for (let i = w; i < w * h - w; i++) if (gl[i] && !band[i] && !(rgb[3 * i] > T && rgb[3 * i + 1] > T && rgb[3 * i + 2] > T) && (band[i - 1] || band[i + 1] || band[i - w] || band[i + w])) add.push(i);
      for (const i of add) band[i] = 1;
    }
    return band;
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
      const T = self.Tool3D, b = base(), shared = T.wear && T.wear.seg && T.wear.seg.ortInit;   // one runtime per page (seg-wear.js)
      let ort;
      if (shared) ort = await shared();
      else {
        if (!self.ort) await loadScript(b + 'vendor/ort/ort.wasm.min.js');
        if (!T.ortGlue) await loadScript(b + 'vendor/ort/ort-wasm-glue.js');
        if (!T.ortWasmB64) await loadScript(b + 'vendor/ort/ort-wasm-bin.js');
        ort = self.ort;
        ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false;
        ort.env.wasm.wasmBinary = b64(T.ortWasmB64);
        ort.env.wasm.wasmPaths = {mjs: URL.createObjectURL(new Blob([T.ortGlue], {type: 'text/javascript'}))};
      }
      if (!T.aiModelB64) await loadScript(b + 'models/wear-backbone.onnx.js');
      const session = await ort.InferenceSession.create(b64(T.aiModelB64), {executionProviders: ['wasm'], graphOptimizationLevel: 'all'});
      T.aiModelB64 = null; if (!shared) T.ortWasmB64 = null;   // free the base64 copies
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
    const {result, debug} = await W.measureAsync(Object.assign({}, opts, {sides, top, enhanced: W.enhanceSides && W.enhanceSides(sides, opts)}), seg, 'ai');
    debug.aiMs = Date.now() - t0;
    T.wearResult = result; T.wearDebug = debug;
    window.dispatchEvent(new CustomEvent('tool3d:wear', {detail: result}));
    return result;
  }

  return {createSegmenter, netInput, cellsOf, anomalyPooled, anomalyCells, upsample, load, run, NET_TOOL_PX};
});
