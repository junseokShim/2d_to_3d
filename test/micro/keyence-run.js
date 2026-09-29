// Keyence VHX reference (first real-instrument ground truth) vs microscope mode.
// Run: node test/micro/keyence-run.js   (TOOLWEAR=<dir> if the dataset is elsewhere; KEYENCE_NONET=1 skips the network;
//      SEG_MODEL=<model .onnx.js> runs another export, e.g. www/models/wear-seg-micro.onnx.js)
// Per image (datasets/toolwear/reference/keyence, labelled by scripts/data/label_keyence.py at <= 1600 px, px/mm from the
// VHX scale bar):
//  app VB   microscope mode as in the app: seg-wear.js U-Net + micro-core maths, calibrated px/mm, auto rotation
//  mask VB  the same micro-core maths on the hand mask (label oracle; the clean twin's mask where there is one: the same
//           pixels without the Keyence overlays): VBmax over the edge, and VB at the Keyence arrow
//  VB methods (micro-core vbRef): ref = Keyence-style reference line fitted on the unworn edge (default), edge = fitted edge
//           line. VB at the arrow = median of the row VBs within +-12 px of the arrow foot along the edge; rows whose far
//           boundary lies next to an ignore pixel of the image's own mask (overlay arrow / label box) are left out
//  K-line   the Keyence method on the mask: from the Keyence reference line (through the arrow foot, normal to the arrow)
//           along the arrow to the far end of the wear land (so only the label is compared, not the edge fit)
//  Keyence  the operator's printed value;  seg IoU of the network (wear threshold rule of the app) vs the mask, 255 ignored
// Checks (exit 1 on a FAIL): the label and the default VB maths on the mask (fixed, see research/keyence-reference.md);
// the network rows are reported, with thresholds set from the leave-one-view-out result (KEYENCE_NET_CHECK=0 skips them).
'use strict';
const fs = require('fs'), path = require('path');
const MC = require('../../www/js/micro/micro-core.js'), readPng = require('../wear/png.js'), {readLabel} = require('../wear/png-write.js'), {oracle} = require('./mud.js');
const DS = process.env.TOOLWEAR || 'C:/agent_research_team/datasets/toolwear', KD = path.join(DS, 'reference', 'keyence');
// label for the maths: 255 (ignore) filled from the nearest labelled pixel (BFS), so ignored dust / UI boxes in the
// background are background and the band on the coating side of the wear boundary splits evenly (mud.js maps 255 -> tool).
// Wear (2/3) grows at most WEAR_FILL px into an ignore region: thin ignore rims inside the land close, but an overlay box
// sitting on the wear boundary (152822 has no clean twin: the "[1]77.60um" label box) is not turned into wear.
const WEAR_FILL = 6;
// ovl: overlay pixels (label box) where wear does not grow at all: the boundary under them is unknown
function filled(lab, ovl) {
  const {w, h, m} = lab, o = Uint8Array.from(m), d = new Uint16Array(o.length), q = [];
  for (let i = 0; i < o.length; i++) if (o[i] !== 255) q.push(i);
  for (let k = 0; k < q.length; k++) {
    const i = q[k], x = i % w, c = o[i];
    if ((c === 2 || c === 3) && d[i] >= WEAR_FILL) continue;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < o.length && o[j] === 255 && !((c === 2 || c === 3) && ovl && ovl.m[j])) { o[j] = c; d[j] = d[i] + 1; q.push(j); }
  }
  return {w, h, m: o, ign: Uint8Array.from(m, v => v === 255 ? 1 : 0)};
}
// label oracle; seg.ign lets micro-core skip edge points inside a wide ignore band (the edge is unknown there)
const orc = (L, q) => { const O = oracle(L, q); const I = oracle({w: L.w, h: L.h, m: L.ign.map(v => v ? 255 : 0)}, q); O.ign = I.ign; O.seg.ign = I.ign; return O; };
const f1 = v => v == null || !isFinite(v) ? '-' : (+v).toFixed(1);

// original image point P -> edge coordinate u (rows of vbPx) of a result r (or of its alt: the other VB method)
function uOf(q, r, W, H, P) {
  const [X, Y] = q === 0 ? P : q === 1 ? [H - 1 - P[1], P[0]] : q === 2 ? [W - 1 - P[0], H - 1 - P[1]] : [P[1], W - 1 - P[0]];
  return X * r.frame.t[0] + (Y - r.refLine.a) * r.frame.t[1] - r.frame.u0;
}
// Keyence overlay pixels of an image without a clean twin: ignore regions thick enough to hold a label box (a 17 x 17
// all-ignore core, grown back by 10 px). The ~6-16 px ignore rims along label boundaries are not overlay.
function overlay(raw) {
  const {w, h, m} = raw, box = (src, r) => {       // count of set pixels in the (2r+1)^2 window (integral image)
    const I = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) for (let x = 0, row = 0; x < w; x++) { row += src[y * w + x]; I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row; }
    const o = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1), y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
      o[y * w + x] = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
    }
    return o;
  };
  const ign = Uint8Array.from(m, v => v === 255 ? 1 : 0), c = box(ign, 8), core = Uint8Array.from(c, v => v >= 289 ? 1 : 0), g = box(core, 10);
  return {w, h, m: Uint8Array.from(g, v => v > 0 ? 1 : 0)};
}
// VB at the Keyence arrow (px): median of raw rows within +-HALF of u; rows whose far boundary is next to an overlay
// pixel (arrow, label box) are dropped
const HALF = 12;
function vbAt(r, u, ovl) {
  const near = (x, y) => { if (!ovl) return false; for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const X = Math.round(x) + dx, Y = Math.round(y) + dy; if (X >= 0 && Y >= 0 && X < ovl.w && Y < ovl.h && ovl.m[Y * ovl.w + X]) return true; } return false; };
  const dbg = [];
  for (const half of [HALF, 2 * HALF, 4 * HALF]) {       // widened when the overlay covers the rows next to the arrow
    const a = [];
    for (let k = Math.max(0, Math.round(u - half)); k <= Math.min(r.vbRawPx.length - 1, Math.round(u + half)); k++) {
      const v = r.vbRawPx[k]; if (v > 0) { const [x, y] = r.toImg(k, v - .5); if (near(x, y)) { if (process.env.KEYENCE_DBG) dbg.push((k - u).toFixed(0) + ':x'); continue; } } a.push(v); if (process.env.KEYENCE_DBG) dbg.push((k - u).toFixed(0) + ':' + v.toFixed(0));
    }
    if (process.env.KEYENCE_DBG) console.log('   rows', half, dbg.join(' '));
    if (a.length >= 5) { a.sort((p, q) => p - q); return a[a.length >> 1]; }
  }
  return null;
}
// Keyence method on the mask: from the arrow foot on the Keyence reference line (labelinfo footW, fitted to the overlay
// pixels) along its normal into the tool: far = last wear (2/3) pixel (scanned from the reference line on, gaps <= 2 px bridged), edge = first tool pixel
// (negative = the actual edge lies outside the reference line). far is the median over rays shifted +-4..12 px along the
// edge on the raw mask: the ray on the arrow itself runs under the arrow / label box overlay when the image has
// no clean twin (152822), and one ray is noisy on a ragged boundary.
function ray(lab, foot, nv, span, s) {
  const tv = [-nv[1], nv[0]], at = t => { const x = Math.round(foot[0] + tv[0] * s + nv[0] * t), y = Math.round(foot[1] + tv[1] * s + nv[1] * t); return x < 0 || y < 0 || x >= lab.w || y >= lab.h ? -1 : lab.m[y * lab.w + x]; };
  let far = null, gap = 0, edge = null;
  for (let t = -span; t < 3 * span; t += .25) { const c = at(t); if (edge == null && c > 0 && c !== 255) edge = t; if ((c === 2 || c === 3) && t >= 0) { far = t; gap = 0; } else if (far != null && ++gap > 8) break; }
  return {far, edge};
}
function kline(lab, raw, foot, nv, span) {
  const f = [-12, -10, -8, -6, -4, 4, 6, 8, 10, 12].map(s => ray(raw, foot, nv, span, s).far).filter(v => v != null).sort((a, b) => a - b);
  return {far: f.length ? f[f.length >> 1] : null, edge: ray(lab, foot, nv, span, 0).edge};
}
// IoU at network resolution (app threshold rule), label nearest pixel in the rotated frame; 255 ignored
function iou(seg, O) {
  const {w, h, scale: [sx, sy]} = seg, W = O.w, H = O.h, lab = O.seg.prob, n = W * H, I = {wear: [0, 0], tool: [0, 0]};
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const X = Math.min(W - 1, Math.round((x + .5) * sx - .5)), Y = Math.min(H - 1, Math.round((y + .5) * sy - .5)), j = Y * W + X;
    if (O.ign[j]) continue;
    const c = MC.classAtImg(seg, X, Y, W, H, MC.WEAR_THR), tWear = lab[2 * n + j] || lab[3 * n + j], tTool = !lab[j];
    const pw = c === 2, pt = c !== 0;
    I.wear[0] += pw && tWear; I.wear[1] += pw || tWear; I.tool[0] += pt && tTool; I.tool[1] += pt || tTool;
  }
  return {wear: I.wear[1] ? I.wear[0] / I.wear[1] : null, tool: I.tool[1] ? I.tool[0] / I.tool[1] : null};
}

let pass = 0, fail = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name} ${info}`); ok ? pass++ : fail++; };

(async () => {
  if (!fs.existsSync(path.join(KD, 'labelinfo'))) { console.log('SKIP  Keyence reference not found at ' + KD); return; }
  const only = process.env.KEYENCE_ONLY ? new RegExp(process.env.KEYENCE_ONLY) : null;
  const infos = fs.readdirSync(path.join(KD, 'labelinfo')).filter(f => f.endsWith('.json') && (!only || only.test(f))).sort().map(f => JSON.parse(fs.readFileSync(path.join(KD, 'labelinfo', f), 'utf8')));
  let SEG = null, run = null;
  if (!process.env.KEYENCE_NONET) { SEG = require('../../www/js/wear/seg-wear.js'); run = await require('../wear/ort-seg-node.js')(); }
  const rows = [], pct = (v, k) => v == null || k == null ? null : (v / k - 1) * 100;
  const netCache = {};
  for (const info of infos) {
    const img = readPng(path.join(KD, 'images', info.id + '.png')), raw = readLabel(path.join(KD, 'masks', info.id + '.png')), ppm = info.pxPerMm, um = px => px == null ? null : px / ppm * 1000;
    // with a clean twin (same pixels without the overlays) the maths and the network run on the twin; without one (152822)
    // the label box lies on the wear boundary next to the arrow: wear is not filled into it, rows under it are unknown
    const twin = info.cleanTwin && 'keyence_' + info.cleanTwin !== info.id, cid = twin ? 'keyence_' + info.cleanTwin : info.id;
    const cleanRaw = twin ? readLabel(path.join(KD, 'masks', cid + '.png')) : raw, ovl = twin ? null : overlay(raw), clean = filled(cleanRaw, ovl);
    const cimg = twin ? readPng(path.join(KD, 'images', cid + '.png')) : img;
    // mask through the app maths: rotation from the label itself
    const O0 = orc(clean, 0), side = MC.toolSide(O0.seg), O = orc(clean, side.q);
    const t = await MC.analyzeImage(cimg, {oracle: () => O.seg, rotate: side.q, pxPerMm: ppm});
    let n = null, nerr = null, IoU = null;
    if (run) {
      if (!netCache[cid]) { try { const r = await MC.analyzeImage(cimg, {runProbs: run, seg: SEG, pxPerMm: ppm, uRel: .01}); netCache[cid] = {n: r, IoU: iou(r.seg, orc(clean, r.q))}; } catch (e) { netCache[cid] = {err: e.message}; } }
      ({n, IoU} = netCache[cid]); nerr = netCache[cid].err || null;
    }
    const both = (r, what) => r ? {ref: r.methods.reference[what] * 1000, edge: r.methods.edge[what] * 1000} : {ref: null, edge: null};
    const base = {id: info.id, mag: info.magnification, ppm, q: side.q, refSrc: t.ref.source, maskMax: both(t, 'vbMax'), maskB: both(t, 'vbb'), appMax: both(n, 'vbMax'), appB: both(n, 'vbb'),
      appRefSrc: n ? n.ref.source : null, appQ: n ? n.q : null, appFlags: n ? n.flags.join(',') : nerr, IoU};
    const ms = (info.measurements || []).filter(m => m.p1w);
    if (!ms.length) rows.push(Object.assign(base, {k: '-', keyence: null}));
    for (const m of ms) {
      const foot = m.footW || m.p2w, d = Math.hypot(m.p1w[0] - m.p2w[0], m.p1w[1] - m.p2w[1]), nv = m.normalW || [(m.p1w[0] - m.p2w[0]) / d, (m.p1w[1] - m.p2w[1]) / d];
      const kl = kline(clean, cleanRaw, foot, nv, 200), isVB = /VB/.test(m.what);
      // both VB methods at the arrow (r = the default method's result, r.alt = the other one)
      const at = r => {
        if (!r || !isVB) return null;
        const R = r.vbRef === 'edge' ? r.alt : r, E = r.vbRef === 'edge' ? r : r.alt;
        return {ref: um(vbAt(R, uOf(r.q, R, raw.w, raw.h, foot), r === t ? null : ovl)), edge: um(vbAt(E, uOf(r.q, E, raw.w, raw.h, foot), r === t ? null : ovl))};
      };
      const r = Object.assign({}, base, {k: m.label, keyence: m.valueUm, what: isVB ? 'VB' : 'edge offset', maskAt: at(t), appAt: at(n),
        kMask: isVB ? (kl.far == null ? null : um(kl.far)) : (kl.edge == null ? null : um(-kl.edge)), outside: isVB ? null : t.ref.outsideMm * 1000});
      r.dev = pct(r.kMask, m.valueUm);
      if (r.maskAt) { r.devRef = pct(r.maskAt.ref, m.valueUm); r.devEdge = pct(r.maskAt.edge, m.valueUm); }
      if (r.appAt) { r.devApp = pct(r.appAt.ref, m.valueUm); r.devAppE = pct(r.appAt.edge, m.valueUm); }
      rows.push(r);
    }
  }
  const sg = v => v == null ? '     -' : ((v >= 0 ? '+' : '') + v.toFixed(1)).padStart(6), p2 = o => o ? `${f1(o.ref).padStart(6)} ${f1(o.edge).padStart(6)}` : '     -      -';
  console.log('Keyence VHX reference vs microscope mode (um; px/mm = VHX scale bar at working resolution; pairs = ref / edge VB method)\n');
  console.log('image            mag    px/mm  Keyence      | K-line  dev% | mask@arrow ref edge  dev% ref edge | mask VBmax    | mask VBB      | app@arrow ref edge  dev% ref edge | app VBmax     | IoU wear tool | ref source, app flags');
  for (const r of rows) {
    const mid = r.maskAt ? `${p2(r.maskAt)} ${sg(r.devRef)} ${sg(r.devEdge)}` : r.outside != null ? `edge outside ref (p95) ${f1(r.outside).padStart(5)}      ` : ' '.repeat(33);
    const app = r.appAt ? `${p2(r.appAt)} ${sg(r.devApp)} ${sg(r.devAppE)}` : ' '.repeat(33);
    console.log(`${r.id.padEnd(16)} ${String(r.mag).padEnd(6)} ${r.ppm.toFixed(0).padStart(5)}  ${(r.keyence == null ? '-' : r.k + ' ' + r.keyence.toFixed(2)).padEnd(12)} | ${f1(r.kMask).padStart(6)} ${sg(r.dev)} | ${mid} | ${p2(r.maskMax)} | ${p2(r.maskB)} | ${app} | ${p2(r.appMax)} | ${r.IoU ? `${f1(100 * r.IoU.wear).padStart(5)} ${f1(100 * r.IoU.tool).padStart(5)}` : '    -     -'} | mask ${r.refSrc}${r.appRefSrc ? ', app ' + r.appRefSrc : ''} ${r.appFlags || ''}${r.appQ != null && r.appQ !== r.q ? ` (app turned ${r.appQ}x90, mask ${r.q}x90)` : ''}`);
  }
  console.log('\n3D profile edge recession (151813/151922, [1] 52.90 um along the edge): height map views, not a flank image -> no mask, not comparable to VB.\n');
  // label + maths checks (the mask is the operator's boundary; the default VB maths must read Keyence's number from it)
  const vb = rows.filter(r => r.what === 'VB');
  for (const r of vb) check(`${r.id} ${r.k}: label K-line within 5 % of Keyence`, Math.abs(r.dev) <= 5, `${sg(r.dev)} %`);
  for (const r of vb) check(`${r.id} ${r.k}: mask VB at the arrow (default '${MC.VB_REF}' maths) within 5 % of Keyence`, r.devRef != null && Math.abs(MC.VB_REF === 'edge' ? r.devEdge : r.devRef) <= 5, `${sg(MC.VB_REF === 'edge' ? r.devEdge : r.devRef)} %`);
  console.log(`\n${rows.length} rows, ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})().catch(e => { console.error(e); process.exit(1); }).then(() => process.exit(process.exitCode || 0));
