// Tool3D render: parametric carbide end mill geometry (three.js r147, classic script).
// Tool frame: z = tool axis, tip at z = 0, shank toward +z, units mm.
// Cross-section per flute (CCW): heel -> secondary clearance -> primary flank land -> cutting edge
// -> rake face -> chip pocket (core) -> next heel. Sections are swept with the helix twist.
(function () {
  'use strict';
  const T3 = window.Tool3D = window.Tool3D || {};
  const NS = T3._render = T3._render || {};
  const DEG = Math.PI / 180;
  const CORE = {2: .55, 3: .6, 4: .65, 5: .7, 6: .72};       // core / D (matches index.html defaults)

  // Defaults from typical carbide square end mills; anything measured from photos overrides.
  function defaults(p) {
    p = Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== null && !Number.isNaN(v)));
    const k = Math.max(2, Math.min(6, Math.round(p.flutes || 4)));
    const D = Math.max(1, +p.diameterMm || 10);
    const q = Object.assign({
      flutes: k, diameterMm: D,
      helixDeg: k <= 2 ? 30 : k === 3 ? 35 : 38,
      hand: 1,                         // +1 right hand helix / right hand cut
      phaseRad: 0,                     // azimuth of flute 0 cutting edge at the tip
      coreRatio: CORE[k],
      rakeDeg: 8,
      clear1Deg: 8, land1Mm: .04 * D,  // primary flank land (VB lives here)
      clear2Deg: 18, land2Mm: .08 * D,
      toothFrac: k <= 2 ? .42 : .47,   // tooth angular width / pitch
      cornerRadiusMm: .03 * D,
      dishDeg: 2, endClear1Deg: 8, endLand1Mm: .05 * D, endClear2Deg: 15,
      fluteLenMm: 2.2 * D, runoutMm: .7 * D, shankLenMm: 1.2 * D, shankDiaMm: D, chamferMm: .04 * D
    }, p);
    q.flutes = k; q.diameterMm = D;
    return q;
  }

  // One closed cross-section (at the tip, no twist). Returns points with metadata.
  function section(q) {
    const k = q.flutes, R = q.diameterMm / 2, pitch = 2 * Math.PI / k, rc = q.coreRatio * R;
    const thT = q.toothFrac * pitch, t1 = Math.tan(q.clear1Deg * DEG), t2 = Math.tan(q.clear2Deg * DEG);
    const w1 = q.land1Mm, w2 = q.land2Mm, rHeel = rc + .55 * (R - rc);
    const pts = [];          // {x,y,tooth,s,reg,brk}; s = arc length behind edge (body), -1 in flute
    const add = (r, a, tooth, s, reg, brk) => pts.push({x: r * Math.cos(a), y: r * Math.sin(a), tooth, s, reg, brk: !!brk});
    for (let i = 0; i < k; i++) {
      const a0 = q.phaseRad + i * pitch;
      // body, from heel (a0 - thT) to edge (a0); built edge-backwards then reversed
      const body = [];
      const sEnd = R * thT, s2 = w1 + w2, n1 = 26, n2 = 12, n3 = 18;
      for (let j = 0; j <= n1; j++) { const s = w1 * j / n1; body.push([R - s * t1, s, 0, j === 0 || j === n1]); }
      const r1 = R - w1 * t1;
      for (let j = 1; j <= n2; j++) { const s = w1 + w2 * j / n2; body.push([r1 - (s - w1) * t2, s, 1, j === n2]); }
      const r2 = r1 - w2 * t2;
      for (let j = 1; j <= n3; j++) {                      // heel: rounded fall-off to rHeel
        const u = j / n3, s = s2 + (sEnd - s2) * u;
        body.push([r2 - (r2 - rHeel) * Math.pow(u, 2.2), s, 2, j === n3]);
      }
      body.reverse();
      for (const [r, s, reg, brk] of body) add(r, a0 - s / r1, i, s, reg, brk);
      // rake face: straight from the edge, tilted by rake angle into the tooth
      const g = q.rakeDeg * DEG, ex = R * Math.cos(a0), ey = R * Math.sin(a0);
      const dx = -Math.cos(a0 - g), dy = -Math.sin(a0 - g), Lr = .45 * (R - rc), nr = 10;
      for (let j = 1; j <= nr; j++) {
        const t = Lr * j / nr, x = ex + dx * t, y = ey + dy * t;
        pts.push({x, y, tooth: i, s: -1, reg: 3, brk: j === nr});
      }
      // chip pocket: polar blend from rake end, around the core, up to next heel
      const pe = pts[pts.length - 1], rP = Math.hypot(pe.x, pe.y);
      let aP = Math.atan2(pe.y, pe.x); while (aP < a0 - Math.PI) aP += 2 * Math.PI; while (aP > a0 + Math.PI) aP -= 2 * Math.PI;
      const aH = a0 + pitch - thT, np = 40;
      for (let j = 1; j < np; j++) {
        const u = j / np, a = aP + (aH - aP) * u;
        const r = rc + (rP - rc) * Math.pow(1 - u, 2.4) + (rHeel - rc) * Math.pow(u, 3);
        add(r, a, i, -1, 4, false);
      }
    }
    return {pts, R, rc};
  }

  // End-face height (z >= 0) for a point: dish + end clearance behind each end cutting edge.
  function endZ(q, x, y) {
    const k = q.flutes, pitch = 2 * Math.PI / k, r = Math.hypot(x, y), R = q.diameterMm / 2;
    const a = Math.atan2(y, x);
    let d = Infinity;
    for (let i = 0; i < k; i++) { let v = (q.phaseRad + i * pitch - a) % (2 * Math.PI); if (v < 0) v += 2 * Math.PI; d = Math.min(d, v); }
    const s = Math.max(r, .15 * R) * d, w = q.endLand1Mm;
    const cl = s < w ? s * Math.tan(q.endClear1Deg * DEG) : w * Math.tan(q.endClear1Deg * DEG) + (s - w) * Math.tan(q.endClear2Deg * DEG);
    return (R - r) * Math.tan(q.dishDeg * DEG) + Math.min(cl, .045 * q.diameterMm);
  }

  const smooth = u => u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u);

  function build(p) {
    const q = defaults(p || {});
    const {pts, R} = section(q);
    // split columns at sharp breaks so normals stay crisp at edge / land / heel
    const cols = [];
    pts.forEach((pt, i) => { cols.push(pt); if (pt.brk) cols.push(Object.assign({}, pt, {dup: true})); });
    cols.push(Object.assign({}, cols[0]));                   // close the ring (seam column)
    const NC = cols.length;
    const Rs = q.shankDiaMm / 2, rE = q.cornerRadiusMm, Lf = q.fluteLenMm, Lr = q.runoutMm;
    const Ltot = Lf + Lr + q.shankLenMm, tanH = Math.tan(q.helixDeg * DEG) / R * q.hand;
    // non-uniform levels: dense at the corner, then even
    const hs = [];
    const nC = 14; for (let j = 0; j < nC; j++) hs.push(rE * (1 - Math.cos(j / nC * Math.PI / 2)));
    const step = Math.min(.25, q.diameterMm / 50);
    for (let h = rE; h < Lf + Lr; h += step) hs.push(h);
    for (let h = Lf + Lr; h < Ltot - q.chamferMm; h += q.diameterMm / 10) hs.push(h);
    hs.push(Ltot - q.chamferMm, Ltot);
    const NR = hs.length;
    const Lz = .35 * q.diameterMm;
    // bottom ring with corner applied (radius clipped to R - rE); its z is the end-face height there
    const bot = cols.map(c => { const r = Math.hypot(c.x, c.y), f = r > R - rE ? (R - rE) / r : 1; return [c.x * f, c.y * f]; });
    const zb = bot.map(([x, y]) => endZ(q, x, y));
    const pos = new Float32Array(NR * NC * 3), meta = new Float32Array(NR * NC * 4);   // tooth, s, reg, zMm
    for (let j = 0; j < NR; j++) {
      const h = hs[j], fl = 1 - smooth((h - Lf) / Lr);      // flute depth factor (runout)
      const cham = h > Ltot - q.chamferMm ? (h - (Ltot - q.chamferMm)) : 0;
      for (let m = 0; m < NC; m++) {
        const c = cols[m], r0 = Math.hypot(c.x, c.y), a0 = Math.atan2(c.y, c.x);
        let r = Rs - (Rs - r0) * fl;
        if (h < rE && r > R - rE) r = Math.min(r, R - rE + Math.sqrt(Math.max(0, rE * rE - (rE - h) ** 2)));
        r -= cham;
        const z = h < Lz ? zb[m] + h * (Lz - zb[m]) / Lz : h;   // fade end-face height out over Lz
        const a = a0 + tanH * Math.min(z, Lf + Lr);
        const o = 3 * (j * NC + m);
        pos[o] = r * Math.cos(a); pos[o + 1] = r * Math.sin(a); pos[o + 2] = z;
        const e = 4 * (j * NC + m);
        meta[e] = c.tooth; meta[e + 1] = fl > .5 ? c.s : -1; meta[e + 2] = c.reg; meta[e + 3] = z;
      }
    }
    const idx = [];
    for (let j = 0; j < NR - 1; j++) for (let m = 0; m < NC - 1; m++) {
      const i = j * NC + m;
      idx.push(i, i + 1, i + NC + 1, i, i + NC + 1, i + NC);
    }
    const side = new THREE.BufferGeometry();
    side.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    side.setIndex(idx);
    side.computeVertexNormals();
    side.userData = {meta, NC, NR};

    // end face: rings scaled from the (corner-clipped) bottom ring toward the axis
    const ring = [];
    cols.forEach((c, m) => { if (!c.dup && m < NC - 1) ring.push(bot[m]); });
    const NRg = 24, NP = ring.length, ep = [], ei = [], em = [];
    for (let t = 0; t <= NRg; t++) {
      const f = 1 - Math.pow(t / NRg, 1.5);                 // dense near the rim
      for (let m = 0; m < NP; m++) {
        const x = ring[m][0] * f, y = ring[m][1] * f;
        ep.push(x, y, endZ(q, x, y));
        em.push(-1, -1, 5, 0);
      }
    }
    for (let t = 0; t < NRg; t++) for (let m = 0; m < NP; m++) {
      const a = t * NP + m, b = t * NP + (m + 1) % NP;
      ei.push(a, b + NP, b, a, a + NP, b + NP);
    }
    const end = new THREE.BufferGeometry();
    end.setAttribute('position', new THREE.Float32BufferAttribute(ep, 3));
    end.setIndex(ei);
    end.computeVertexNormals();
    end.userData = {meta: new Float32Array(em)};

    // shank back cap
    const top = [], ti = [], base = (NR - 1) * NC;
    top.push(0, 0, Ltot);
    for (let m = 0; m < NC; m++) top.push(pos[3 * (base + m)], pos[3 * (base + m) + 1], Ltot);
    for (let m = 1; m < NC; m++) ti.push(0, m + 1, m);
    const cap = new THREE.BufferGeometry();
    cap.setAttribute('position', new THREE.Float32BufferAttribute(top, 3));
    cap.setIndex(ti);
    cap.computeVertexNormals();
    cap.userData = {meta: new Float32Array((NC + 1) * 4).fill(-1)};

    return {params: q, parts: {side, end, cap}, lengthMm: Ltot};
  }

  NS.geometry = {build, defaults, endZ};
})();
