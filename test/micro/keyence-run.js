// Keyence VHX reference (first real-instrument ground truth) vs microscope mode. Report only: no pass threshold yet, exit 0.
// Run: node test/micro/keyence-run.js   (TOOLWEAR=<dir> if the dataset is elsewhere; KEYENCE_NONET=1 skips the network)
// Per image (datasets/toolwear/reference/keyence, labelled by scripts/data/label_keyence.py at <= 1600 px, px/mm from the
// VHX scale bar):
//  app VB   microscope mode as in the app: seg-wear.js U-Net + micro-core maths, calibrated px/mm, auto rotation
//  mask VB  the same micro-core maths on the hand mask (label oracle): VBmax over the edge, and VB at the Keyence arrow
//  K-line   the Keyence method on the mask: from the Keyence reference line (through the arrow foot, normal to the arrow)
//           along the arrow to the far end of the wear land (so only the label is compared, not the edge fit)
//  Keyence  the operator's printed value;  seg IoU of the network (wear threshold rule of the app) vs the mask, 255 ignored
'use strict';
const fs = require('fs'), path = require('path');
const MC = require('../../www/js/micro/micro-core.js'), readPng = require('../wear/png.js'), {readLabel} = require('../wear/png-write.js'), {oracle} = require('./mud.js');
const DS = process.env.TOOLWEAR || 'C:/agent_research_team/datasets/toolwear', KD = path.join(DS, 'reference', 'keyence');
// label for the maths: 255 (ignore) filled from the nearest labelled pixel (BFS), so ignored dust / UI boxes in the
// background are background and the band on the coating side of the wear boundary splits evenly (mud.js maps 255 -> tool)
function filled(lab) {
  const {w, h, m} = lab, o = Uint8Array.from(m), q = [];
  for (let i = 0; i < o.length; i++) if (o[i] !== 255) q.push(i);
  for (let k = 0; k < q.length; k++) {
    const i = q[k], x = i % w;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) if (j >= 0 && j < o.length && o[j] === 255) { o[j] = o[i]; q.push(j); }
  }
  return {w, h, m: o, ign: Uint8Array.from(m, v => v === 255 ? 1 : 0)};
}
const orc = (L, q) => { const O = oracle(L, q); const I = oracle({w: L.w, h: L.h, m: L.ign.map(v => v ? 255 : 0)}, q); O.ign = I.ign; return O; };
const f1 = v => v == null || !isFinite(v) ? '-' : (+v).toFixed(1);

// rotated-frame point -> edge coordinate u (rows of vbPx); P in original image px
function uOf(r, W, H, P) {
  const q = r.q, [X, Y] = q === 0 ? P : q === 1 ? [H - 1 - P[1], P[0]] : q === 2 ? [W - 1 - P[0], H - 1 - P[1]] : [P[1], W - 1 - P[0]];
  return (X - 0) * r.frame.t[0] + (Y - r.line.a) * r.frame.t[1] - r.frame.u0;
}
const vbAt = (r, u, half) => { let m = 0; for (let k = Math.max(0, Math.round(u - half)); k <= Math.min(r.vbPx.length - 1, Math.round(u + half)); k++) m = Math.max(m, r.vbPx[k]); return m; };
// Keyence method on the mask: from the arrow foot on the Keyence reference line (labelinfo footW, fitted to the overlay
// pixels) along its normal into the tool: far = last wear (2/3) pixel (gaps <= 2 px bridged), edge = first tool pixel
// (negative = the actual edge lies outside the reference line)
function kline(lab, foot, nv, span) {
  const at = t => { const x = Math.round(foot[0] + nv[0] * t), y = Math.round(foot[1] + nv[1] * t); return x < 0 || y < 0 || x >= lab.w || y >= lab.h ? -1 : lab.m[y * lab.w + x]; };
  let far = null, gap = 0, edge = null;
  for (let t = -span; t < 3 * span; t += .25) { const c = at(t); if (edge == null && c > 0 && c !== 255) edge = t; if (c === 2 || c === 3) { far = t; gap = 0; } else if (far != null && ++gap > 8) break; }
  return {far, edge};
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

(async () => {
  if (!fs.existsSync(path.join(KD, 'labelinfo'))) { console.log('SKIP  Keyence reference not found at ' + KD); return; }
  const infos = fs.readdirSync(path.join(KD, 'labelinfo')).filter(f => f.endsWith('.json')).sort().map(f => JSON.parse(fs.readFileSync(path.join(KD, 'labelinfo', f), 'utf8')));
  let SEG = null, run = null;
  if (!process.env.KEYENCE_NONET) { SEG = require('../../www/js/wear/seg-wear.js'); run = await require('../wear/ort-seg-node.js')(); }
  const rows = [];
  for (const info of infos) {
    const img = readPng(path.join(KD, 'images', info.id + '.png')), raw = readLabel(path.join(KD, 'masks', info.id + '.png')), lab = filled(raw), ppm = info.pxPerMm, um = px => px / ppm * 1000;
    // mask through the app maths: rotation from the label itself
    const O0 = orc(lab, 0), side = MC.toolSide(O0.seg), O = orc(lab, side.q);
    const t = await MC.analyzeImage(img, {oracle: () => O.seg, rotate: side.q, pxPerMm: ppm});
    let n = null, nerr = null, IoU = null;
    if (run) { try { n = await MC.analyzeImage(img, {runProbs: run, seg: SEG, pxPerMm: ppm, uRel: .01}); } catch (e) { nerr = e.message; } }
    if (n) { const On = n.q === side.q ? O : orc(lab, n.q); IoU = iou(n.seg, On); }
    const base = {id: info.id, mag: info.magnification, ppm, q: side.q, maskMax: um(t.stats.vbMax * ppm), maskB: um(t.stats.vbb * ppm), appMax: n ? um(n.stats.vbMax * ppm) : null, appB: n ? um(n.stats.vbb * ppm) : null,
      appQ: n ? n.q : null, appFlags: n ? n.flags.join(',') : nerr, edgeDeg: Math.atan(t.line.b) * 180 / Math.PI, IoU};
    const ms = (info.measurements || []).filter(m => m.p1w), clean = filled(readLabel(path.join(KD, 'masks', 'keyence_' + info.cleanTwin + '.png')));
    if (!ms.length) rows.push(Object.assign(base, {k: '-', keyence: null}));
    for (const m of ms) {
      const foot = m.footW || m.p2w, u = uOf(t, lab.w, lab.h, foot), kl = kline(clean, foot, m.normalW || [(m.p1w[0] - m.p2w[0]) / Math.hypot(m.p1w[0] - m.p2w[0], m.p1w[1] - m.p2w[1]), (m.p1w[1] - m.p2w[1]) / Math.hypot(m.p1w[0] - m.p2w[0], m.p1w[1] - m.p2w[1])], 200), isVB = /VB/.test(m.what);
      const r = Object.assign({}, base, {k: m.label, keyence: m.valueUm, what: isVB ? 'VB' : 'edge offset',
        maskAt: isVB ? um(vbAt(t, u, 6)) : null, appAt: isVB && n && n.q === t.q ? um(vbAt(n, uOf(n, lab.w, lab.h, foot), 6)) : null,
        kMask: isVB ? (kl.far == null ? null : um(kl.far)) : (kl.edge == null ? null : um(-kl.edge)), kLine: m.linePxW != null ? um(m.linePxW) : null, kArrowPx: Math.hypot(m.p1w[0] - m.p2w[0], m.p1w[1] - m.p2w[1])});
      r.dev = r.kMask != null ? (r.kMask / m.valueUm - 1) * 100 : null;
      rows.push(r);
    }
  }
  console.log('Keyence VHX reference vs microscope mode (um; px/mm = VHX scale bar at working resolution)\n');
  console.log('image            mag    px/mm  Keyence       mask K-line  dev%  | mask@arrow mask VBmax mask VBB | app@arrow app VBmax app VBB | IoU wear tool | app flags');
  for (const r of rows) console.log(`${r.id.padEnd(16)} ${String(r.mag).padEnd(6)} ${r.ppm.toFixed(0).padStart(5)}  ${(r.keyence == null ? '-' : r.k + ' ' + r.keyence.toFixed(2)).padEnd(12)} ${f1(r.kMask).padStart(6)} ${r.dev == null ? '   -' : ((r.dev >= 0 ? '+' : '') + r.dev.toFixed(1)).padStart(6)}  | ${f1(r.maskAt).padStart(9)} ${f1(r.maskMax).padStart(10)} ${f1(r.maskB).padStart(8)} | ${f1(r.appAt).padStart(9)} ${f1(r.appMax).padStart(10)} ${f1(r.appB).padStart(7)} | ${r.IoU ? `${f1(100 * r.IoU.wear)} ${f1(100 * r.IoU.tool)}` : '-'} | ${r.appFlags || ''}${r.appQ != null && r.appQ !== r.q ? ` (app turned ${r.appQ}x90, mask ${r.q}x90)` : ''}`);
  console.log('\n3D profile edge recession (151813/151922, [1] 52.90 um along the edge): height map views, not a flank image -> no mask, not comparable to VB.');
  console.log(`\n${rows.length} rows (report only, exit 0)`);
})().catch(e => { console.error(e); process.exit(1); }).then(() => process.exit(0));
