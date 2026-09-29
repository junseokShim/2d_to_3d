/* Tool3D post-processing panel ⑤ (after the metrology panel ④): Keyence VHX style (measurement overlay on the image,
 * VB along the edge, statistics) and Alicona style (deviation worn vs nominal on the 3D model, EdgeQuality profile and
 * parameters, cross sections, WearMeasurementModule parameters, chipping list, tolerances, tool-life trend).
 * Reads Tool3D.metro (corrected VB rows), Tool3D.render / Tool3D._render.geometry (nominal model), the map3d result
 * (Tool3D.render.map atlas, Tool3D.map3dResult) and Tool3D.map3dCore. Refreshes on 'tool3d:metro' and 'tool3d:map3d'.
 * Exports: Tool3D.post {refresh, result, state, setTab, select}, Tool3D.postReport {csv, html, pdfPage} (metro-report).
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, C = T.postCore;
  if (!C) { console.warn('post: post-core.js missing'); return; }
  const $ = (s, r = document) => r.querySelector(s);
  const f1 = v => v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(1), f2 = v => v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(2), f3 = v => v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(3), f4 = v => v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(4);
  const store = (() => { try { return window.localStorage; } catch (e) { return null; } })() || {getItem: () => null, setItem: () => {}};
  const PREF = 'tool3d.post.prefs';
  const S = {tab: 'keyence', sel: 0, pos: null, R: null, anim: -1, playing: null,
    prefs: Object.assign({nLines: 5, defTol: C.DEFAULTS.defectTolUm, devTol: C.DEFAULTS.devTolUm, tol: Object.assign({}, C.DEFAULTS.tol)}, (() => { try { return JSON.parse(store.getItem(PREF) || '{}'); } catch (e) { return {}; } })())};
  const savePrefs = () => { try { store.setItem(PREF, JSON.stringify(S.prefs)); } catch (e) { /* private mode */ } };

  // ---------- DOM ----------
  let root;
  function build() {
    root = $('#post'); if (!root || root.dataset.built) return !!root;
    root.dataset.built = 1;
    root.innerHTML = `
<div class="ps-head"><div class="ps-title"><h2>⑤ 후처리 · Post-processing <small>Keyence VHX / Alicona 방식</small></h2><div id="psOverall" class="ps-badge">—</div></div>
  <div class="ps-bar"><div class="ps-seg" id="psTabs"><button data-tab="keyence" class="on">Keyence 방식 (VHX)</button><button data-tab="alicona">Alicona 방식 (3D 편차)</button></div>
  <div class="ps-seg" id="psFlutes"></div>
  <button id="psSave" title="이 결과를 공구 이력(후처리)에 저장 → 공구 수명 추세">이력 저장</button><button id="psCsv">후처리 CSV</button>
  <span class="ps-note">PDF/HTML/CSV 리포트(④)에 후처리 결과가 함께 들어갑니다.</span></div></div>
<div class="ps-empty hint" id="psEmpty">3D 생성 → ④ 측정 후 후처리 결과가 여기에 표시됩니다.</div>
<div id="psBody" hidden>
 <div class="ps-pane" data-pane="keyence">
  <div class="ps-grid">
   <div><div class="ps-cwrap"><canvas id="pkCanvas"></canvas></div>
    <div class="ps-ctl"><label>VB 화살표 <input id="pkN" type="number" min="1" max="12" value="${S.prefs.nLines}"></label><label title="긴 스트립(현미경 연결 영상)은 최대 VB 주변을 확대"><input id="pkZoom" type="checkbox" checked> 최대 VB 확대</label><span id="pkZoomTag" class="hint"></span><span class="hint">절삭날 기준선(점선)에서 마모 경계까지 수직 VB · 스케일바/배율은 교정 px/mm 기준 (배율 = Keyence VHX 환산)</span></div></div>
   <div><table class="ps-tab" id="pkList"></table><table class="ps-tab" id="pkStats"></table>
    <div class="ps-card"><div class="ps-h">VB 프로파일 · 절삭날 따라 <small>u = z / cos(헬릭스)</small></div><canvas id="pkChart" class="ps-dark"></canvas></div></div>
  </div>
 </div>
 <div class="ps-pane" data-pane="alicona" hidden>
  <div class="ps-grid">
   <div>
    <div class="ps-card"><div class="ps-h">3D 편차 맵 · 공칭 모델 대비 <small>음수 = 재료 손실 (µm)</small></div><div class="ps-3d" id="paView"><div class="ps-legend" id="paLegend"></div></div>
     <div class="hint">높이 데이터가 없는 사진 측정: 깊이는 쐐기 모델(VB·tan α) + 치핑 깊이(map3d) 추정값입니다.</div></div>
    <div class="ps-card"><div class="ps-h">Edge profile · 절삭날 따라 추출 프로파일 <small id="paProfTag"></small></div><canvas id="paProfile"></canvas></div>
    <div class="ps-card"><div class="ps-h">단면 (위치 i) · Cross section <small id="paSecTag"></small></div><canvas id="paSection"></canvas>
     <div class="ps-ctl"><input id="paPos" type="range" min="0" max="1000" value="500" style="flex:1"></div></div>
   </div>
   <div>
    <div class="ps-card"><div class="ps-h">EdgeQuality 결과 <small id="paEqTag"></small></div><table class="ps-tab ps-al" id="paEq"></table>
     <div class="ps-ctl"><label>결함 기준 <input id="paDefTol" type="number" min="0.5" step="0.5" value="${S.prefs.defTol}"> µm</label></div></div>
    <div class="ps-card"><div class="ps-h">Wear Measurement (ISO 8688) · 편차 파라미터</div><table class="ps-tab ps-al" id="paWmm"></table>
     <div class="ps-ctl"><label>편차 공차 <input id="paDevTol" type="number" min="0" step="1" value="${S.prefs.devTol}"> µm</label></div></div>
    <div class="ps-card"><div class="ps-h">면별 편차 · Per face</div><table class="ps-tab" id="paFaces"></table></div>
    <div class="ps-card"><div class="ps-h">치핑 목록 · Chipping</div><table class="ps-tab" id="paChips"></table></div>
    <div class="ps-card"><div class="ps-h">공차 판정 · Tolerance</div><table class="ps-tab" id="paTol"></table></div>
    <div class="ps-card"><div class="ps-h">공구 수명 추세 · Tool life <small id="paTrTag"></small></div><canvas id="paTrend"></canvas>
     <div class="ps-ctl"><button id="paPlay" title="저장된 측정의 VB 프로파일을 순서대로 재생">▶ 마모 진행</button><input id="paAnim" type="range" min="0" max="0" value="0" style="flex:1"><span id="paAnimTag" class="hint"></span></div></div>
   </div>
  </div>
 </div>
</div>`;
    root.querySelectorAll('[data-tab]').forEach(b => b.onclick = () => setTab(b.dataset.tab));
    $('#pkZoom').onchange = e => { S.prefs.zoom = e.target.checked; savePrefs(); render(); };
    $('#pkN').onchange = e => { S.prefs.nLines = Math.max(1, Math.min(12, +e.target.value || 5)); savePrefs(); refresh(); };
    $('#paDefTol').onchange = e => { S.prefs.defTol = Math.max(.1, +e.target.value || 5); savePrefs(); refresh(); };
    $('#paDevTol').onchange = e => { S.prefs.devTol = Math.max(0, +e.target.value || 0); savePrefs(); refresh(); };
    $('#paPos').oninput = e => { S.pos = +e.target.value / 1000; drawSection(); };
    $('#paAnim').oninput = e => { S.anim = +e.target.value; drawTrend(); };
    $('#paPlay').onclick = play;
    $('#psSave').onclick = saveHistory;
    $('#psCsv').onclick = () => { const R = S.R; if (!R) return; save(`tool3d-post-${safeId()}.csv`, new Blob(['﻿' + C.csvRows(R)], {type: 'text/csv'})); };
    addEventListener('resize', () => S.R && render());
    return true;
  }
  const mark = (sel, key, val) => root.querySelectorAll(sel).forEach(b => b.classList.toggle('on', b.dataset[key] === String(val)));
  function setTab(t) { S.tab = t; mark('[data-tab]', 'tab', t); root.querySelectorAll('[data-pane]').forEach(p => p.hidden = p.dataset.pane !== t); render(); }
  function select(i) { S.sel = i; S.pos = null; mark('[data-fl]', 'fl', i); render(); }
  const safeId = () => ((T.metro && T.metro.state.prefs.toolId) || 'tool').replace(/[^\w.-]+/g, '_');
  function save(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); }

  // ---------- compute ----------
  let lookCache = {layout: null, look: null};
  function compute() {
    const Mt = T.metro; if (!Mt || !Mt.state || !Mt.state.ready) return null;
    const st = Mt.state, sum = Mt.summary(), rp = (T.render && T.render.params) || {};
    const o = Object.assign({}, C.DEFAULTS, {clearanceDeg: rp.clear1Deg || C.DEFAULTS.clearanceDeg, rakeDeg: rp.rakeDeg == null ? C.DEFAULTS.rakeDeg : rp.rakeDeg,
      helixDeg: st.helix || rp.helixDeg || C.DEFAULTS.helixDeg, defectTolUm: S.prefs.defTol, devTolUm: S.prefs.devTol});
    const wpost = (st.base && st.base.post) || [];   // wear-post.js per-side edge metrics (seg engine / microscope mode)
    const flutes = st.ev.map((e, i) => {
      if (!e) return null;
      const F = st.F[i], ppmCal = F.strip.ppm / (st.cal ? st.cal.scaleFor(F.strip.ppm) : 1), prof = C.vbProfileU(e.rows, o.helixDeg);
      const E = C.edgeProfile(e.rows, Object.assign({}, o, {tipMm: e.tipMm, cornerMm: e.zones.cornerMm}));
      return {i, e, F, ppmCal, pxPerMm: C.r2(ppmCal), lines: C.vbLines(e.rows, e.edge, F.strip.top, {n: S.prefs.nLines, helixDeg: o.helixDeg}), prof, stats: C.vbStats(prof), E, eq: C.mergeEdge(C.edgeQuality(E, o.defectTolUm), wpost[i]),
        mag: C.keyenceMag(ppmCal, F.strip.w)};
    });
    const R = {o, flutes, inputMode: st.inputMode || 'camera', magnification: st.mag || null, vbMaxMm: sum.vbMax ? sum.vbMax.v : null, vbU: sum.vbMax ? sum.vbMax.U : null, limitMm: sum.limitMm,
      vbMeanMm: C.r4(flutes.filter(Boolean).reduce((s, f) => s + f.e.vbAvgMm, 0) / Math.max(1, flutes.filter(Boolean).length)), wmm: null, faces: [], chips: [], dev: null};
    // Alicona: deviation on the model from the map3d atlas
    const map = T.render && T.render.map, G = T._render && T._render.geometry, MC = T.map3dCore;
    if (map && map.atlas && G && MC && rp.flutes) {
      try {
        const layout = G.layout(rp);
        if (lookCache.key !== JSON.stringify(rp)) lookCache = {key: JSON.stringify(rp), layout, look: MC.toothLookup(layout)};
        R.dev = C.deviationAtlas(map.atlas, lookCache.look, Object.assign({}, o, {landMm: layout.land1Mm + layout.land2Mm}));
        R.wmm = C.wmm(R.dev, o.devTolUm);
        R.faces = C.perFace(R.dev, map.faces || [], map.atlas.azSign, o.devTolUm);
        R.chips = C.chipList(map.atlas, lookCache.look, o);
        R.map = map;
      } catch (err) { console.warn('post: deviation', err); }
    }
    const fl = flutes.filter(Boolean), dd = fl.length ? Math.min(...fl.map(f => f.eq.Ddmax)) : null;
    R.tol = C.tolerance({vbMaxMm: R.vbMaxMm, ddMaxUm: dd, pdPct: fl.length ? Math.max(...fl.map(f => f.eq.Pd)) : null,
      chipDepthUm: R.chips.length ? Math.max(...R.chips.map(c => c.maxDepthUm)) : R.wmm ? 0 : null, vdvMm3: R.wmm ? R.wmm.VdvMm3 : null},
      Object.assign({}, S.prefs.tol, {vbMaxMm: sum.limitMm || S.prefs.tol.vbMaxMm}));
    // tool-life history: this panel's entries, else the metrology history (VBmax only)
    const id = st.prefs.toolId || 'unnamed', post = C.history(store, id), metro = T.metroCore ? T.metroCore.history(store, id) : [];
    R.hist = post.length >= metro.length ? post : metro.map(h => ({date: h.date, vbMax: h.vbMax, U: h.U, cutMin: h.cutMin}));
    R.histSource = post.length >= metro.length ? 'post' : 'metro';
    R.trend = C.trend(R.hist, R.limitMm);
    return R;
  }

  // ---------- render ----------
  let timer = null;
  function refresh() { if (!build()) return; clearTimeout(timer); timer = setTimeout(run, 60); }
  function run() {
    S.R = compute(); T.post.result = S.R;
    $('#psBody').hidden = !S.R; $('#psEmpty').hidden = !!S.R; if (!S.R) return;
    const fl = S.R.flutes;
    if (!fl[S.sel]) S.sel = Math.max(0, fl.findIndex(Boolean));
    $('#psFlutes').innerHTML = fl.map((f, i) => `<button data-fl="${i}" ${f ? '' : 'disabled'} class="${i === S.sel ? 'on' : ''}">F${i + 1}</button>`).join('');
    root.querySelectorAll('[data-fl]').forEach(b => b.onclick = () => select(+b.dataset.fl));
    const t = S.R.tol, b = $('#psOverall');
    b.textContent = t.pass == null ? '판정 없음' : t.pass ? `공차 적합 · PASS` : `공차 초과 · FAIL (${t.failed.length})`; b.dataset.pass = t.pass == null ? '' : t.pass ? '1' : '0';
    render();
    window.dispatchEvent(new CustomEvent('tool3d:post', {detail: S.R}));
  }
  function render() {
    if (!S.R) return;
    if (S.tab === 'keyence') { drawKeyence(); renderKeyenceTables(); drawVbChart(); }
    else { view3d(); drawProfile(); drawSection(); renderAlicona(); drawTrend(); }
  }
  function canvasFit(c, h) { const dpr = devicePixelRatio || 1, w = c.clientWidth || 400; c.width = Math.round(w * dpr); c.height = Math.round(h * dpr); c.style.height = h + 'px'; const x = c.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); return [x, w, h]; }
  const cur = () => S.R && S.R.flutes[S.sel];

  // Keyence overlay: rectified strip, dotted reference edge line, red VB arrows with [n] labels, blue scale bar, magnification
  function drawKeyence() {
    const f = cur(), c = $('#pkCanvas'), [x, W, H] = canvasFit(c, 470); x.fillStyle = '#000'; x.fillRect(0, 0, W, H); if (!f) return;
    const img = T.metro.stripImage(f.i), top = f.F.strip.top; let y0 = Math.max(0, top - 12), y1 = Math.min(img.height, top + f.F.n + 12);
    // Keyence frames one field of view: a long thin strip (microscope stitch) is shown zoomed around the VB maximum
    const zoom = S.prefs.zoom !== false && img.width * H / (y1 - y0) < .3 * W;
    if (zoom) { const rows = H / Math.min(.5 * W / img.width, 40), mx = f.lines.find(l => l.isMax) || f.lines[0], cy = mx ? mx.y : (y0 + y1) / 2;
      y0 = Math.max(0, Math.round(cy - rows / 2)); y1 = Math.min(img.height, y0 + Math.round(rows)); y0 = Math.max(0, y1 - Math.round(rows)); }
    $('#pkZoom').checked = S.prefs.zoom !== false; $('#pkZoomTag').textContent = zoom ? `표시 ${f3((y1 - y0) / f.ppmCal)} mm 구간` : '';
    const s = Math.min(W / img.width, H / (y1 - y0)), ox = (W - img.width * s) / 2, oy = (H - (y1 - y0) * s) / 2, P = (ix, iy) => [ox + ix * s, oy + (iy - y0) * s];
    x.imageSmoothingEnabled = s < 3; x.drawImage(img, 0, y0, img.width, y1 - y0, ox, oy, img.width * s, (y1 - y0) * s);
    const {A, B} = f.e.rows, edgeX = r => f.e.edge === 'a' ? A[r] - .5 : B[r] + .5, frontX = r => f.e.edge === 'a' ? B[r] + .5 : A[r] - .5;
    x.setLineDash([2, 3]); x.lineWidth = 1.6; x.strokeStyle = '#48e0e0'; x.beginPath();
    for (let r = 0; r < f.F.n; r++) { const [px, py] = P(edgeX(r), top + r + .5); r ? x.lineTo(px, py) : x.moveTo(px, py); } x.stroke();
    x.setLineDash([]); x.strokeStyle = 'rgba(255,212,0,.55)'; x.lineWidth = 1; x.beginPath(); let on = false;
    for (let r = 0; r < f.F.n; r++) { if (!(f.e.rows.vb[r] > 0)) { on = false; continue; } const [px, py] = P(frontX(r), top + r + .5); on ? x.lineTo(px, py) : x.moveTo(px, py); on = true; } x.stroke();
    const side = (f.lines[0] && f.lines[0].xFront > f.lines[0].xEdge) ? 1 : -1, arrow = (a, b) => {
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hd = 7;
      x.beginPath(); x.moveTo(...a); x.lineTo(...b); x.stroke();
      for (const [p, d] of [[a, ang + Math.PI], [b, ang]]) { x.beginPath(); x.moveTo(...p); x.lineTo(p[0] - hd * Math.cos(d - .45), p[1] - hd * Math.sin(d - .45)); x.lineTo(p[0] - hd * Math.cos(d + .45), p[1] - hd * Math.sin(d + .45)); x.closePath(); x.fill(); }
    };
    x.font = '600 12px system-ui,sans-serif'; let lastY = -99;
    for (const l of f.lines) {
      if (l.y < y0 || l.y > y1) continue;
      const a = P(l.xEdge, l.y), b = P(l.xFront, l.y), grow = Math.max(0, 16 - Math.abs(b[0] - a[0])) / 2;   // tiny lands: arrows still readable
      x.strokeStyle = x.fillStyle = l.isMax ? '#ff2020' : '#ff4040'; x.lineWidth = l.isMax ? 2.4 : 1.8;
      arrow([a[0] - side * grow, a[1]], [b[0] + side * grow, b[1]]);
      const t = `[${l.n}]${l.vbUm.toFixed(2)}µm`, tw = x.measureText(t).width, lx = side > 0 ? Math.min(W - tw - 8, b[0] + grow + 10) : Math.max(4, a[0] - grow - tw - 14);
      let ly = Math.max(lastY + 18, b[1] - 8); lastY = ly;
      x.strokeStyle = '#ff4040'; x.lineWidth = 1; x.beginPath(); x.moveTo(side > 0 ? b[0] + grow : a[0] - grow, b[1]); x.lineTo(side > 0 ? lx : lx + tw + 6, ly + 8); x.stroke();
      x.fillStyle = '#fff'; x.fillRect(lx, ly, tw + 6, 17); x.strokeStyle = '#000'; x.strokeRect(lx + .5, ly + .5, tw + 5, 16); x.fillStyle = '#000'; x.fillText(t, lx + 3, ly + 13);
    }
    // scale bar + magnification (Keyence screen conventions)
    const bar = C.scaleBar(f.ppmCal * s, .22 * W), bx1 = W - 14, bx0 = bx1 - bar.px, by = H - 34;
    x.strokeStyle = '#1b2cff'; x.lineWidth = 2; x.beginPath(); x.moveTo(bx0, by); x.lineTo(bx1, by); x.moveTo(bx0, by - 4); x.lineTo(bx0, by + 4); x.moveTo(bx1, by - 4); x.lineTo(bx1, by + 4); x.stroke();
    x.font = '13px system-ui,sans-serif'; const bt = bar.label, btw = x.measureText(bt).width;
    x.fillStyle = '#fff'; x.fillRect(bx1 - btw - 6, by + 8, btw + 6, 18); x.strokeStyle = '#000'; x.lineWidth = 1; x.strokeRect(bx1 - btw - 5.5, by + 8.5, btw + 5, 17); x.fillStyle = '#000'; x.fillText(bt, bx1 - btw - 3, by + 22);
    const vis = C.keyenceMag(f.ppmCal, Math.min(img.width, W / s)), lab = `${S.R.inputMode === 'microscope' && S.R.magnification ? `현미경 X${S.R.magnification} · ` : ''}배율 환산 ${vis.label} · ${vis.umPerPx} µm/px · F${f.i + 1}`;
    x.font = '13px system-ui,sans-serif'; const lw = x.measureText(lab).width; x.fillStyle = '#fff'; x.fillRect(6, 6, lw + 8, 19); x.strokeStyle = '#000'; x.strokeRect(6.5, 6.5, lw + 7, 18); x.fillStyle = '#000'; x.fillText(lab, 10, 20);
  }
  function renderKeyenceTables() {
    const f = cur(); if (!f) return;
    $('#pkList').innerHTML = `<tr><th>No.</th><th>측정</th><th>u (mm)</th><th>z (mm)</th><th>값</th></tr>` + f.lines.map(l =>
      `<tr${l.isMax ? ' class="ps-max"' : ''}><td>[${l.n}]</td><td>VB ${l.isMax ? '(max)' : ''}</td><td>${f3(l.uMm)}</td><td>${f3(l.zMm)}</td><td><b>${f2(l.vbUm)} µm</b></td></tr>`).join('');
    const s = f.stats;
    $('#pkStats').innerHTML = `<tr><th colspan="2">통계 F${f.i + 1} (µm)</th><th colspan="2">배율 / 스케일</th></tr>
      <tr><td>VBmax</td><td>${f2(s.maxUm)}</td><td>배율 환산</td><td>${f.mag.label}</td></tr>
      <tr><td>VB 평균</td><td>${f2(s.meanUm)}</td><td>px/mm</td><td>${f2(f.pxPerMm)}</td></tr>
      <tr><td>VB 최소</td><td>${f2(s.minUm)}</td><td>µm/px</td><td>${f3(f.mag.umPerPx)}</td></tr>
      <tr><td>표준편차 σ</td><td>${f2(s.sdUm)}</td><td>시야 폭</td><td>${f3(f.mag.fovMm)} mm</td></tr>
      <tr><td>중앙값 (Q1–Q3)</td><td>${f2(s.medianUm)} (${f1(s.p25Um)}–${f1(s.p75Um)})</td><td>평가 길이</td><td>${f3(s.lengthMm)} mm</td></tr>
      <tr><td>마모 길이</td><td>${f3(s.wornMm)} mm (${f1(s.wornPct)} %)</td><td>U (k=2) VBmax</td><td>${f1(f.e.q.vbMax.U * 1000)} µm</td></tr>` +
      (f.eq.keyence ? `<tr><th colspan="4">기준선 방식 (AI 마모 영역, 미마모 날에 맞춘 직선)</th></tr>
      <tr><td title="기준선에서 마모 경계까지 수직 거리의 최대">VBmax (기준선)</td><td>${f2(f.eq.keyence.VBmaxUm)}</td><td title="기준선 아래로 후퇴한 절삭날 = 치핑 ([2] 값)">날 후퇴</td><td>${f2(f.eq.keyence.recessionUm)} µm</td></tr>
      <tr><td>VB 평균 (기준선)</td><td>${f2(f.eq.keyence.VBmeanUm)}</td><td>위치 (날 따라)</td><td>${f1(f.eq.keyence.VBmaxAtUm)} / ${f1(f.eq.keyence.recessionAtUm)} µm</td></tr>` : '');
  }
  function drawVbChart() {
    const f = cur(), [x, W, H] = canvasFit($('#pkChart'), 200); x.fillStyle = '#000'; x.fillRect(0, 0, W, H); if (!f) return;
    const pr = f.prof, uMax = pr.length ? pr[pr.length - 1].uMm * 1000 : 1, vMax = Math.max(20, f.stats.maxUm * 1.15), pad = {l: 50, r: 10, t: 14, b: 26};
    const X = u => pad.l + u / uMax * (W - pad.l - pad.r), Y = v => H - pad.b - v / vMax * (H - pad.t - pad.b);
    x.strokeStyle = '#9aa'; x.lineWidth = 1; x.strokeRect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b);
    x.fillStyle = '#ddd'; x.font = '10px system-ui'; x.textAlign = 'right';
    for (let j = 0; j <= 4; j++) { const v = vMax * j / 4; x.fillText(v.toFixed(1), pad.l - 4, Y(v) + 3); }
    x.textAlign = 'center'; for (let j = 0; j <= 5; j++) { const u = uMax * j / 5; x.fillText(u.toFixed(0), X(u), H - pad.b + 13); }
    x.textAlign = 'left'; x.fillText('µm', 4, 10); x.fillText('u µm', W - 34, H - 2);
    x.strokeStyle = '#2fd0d0'; x.lineWidth = 1.4; x.beginPath(); pr.forEach((p, j) => { const px = X(p.uMm * 1000), py = Y(p.vbUm); j ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
    x.setLineDash([4, 3]); x.strokeStyle = '#e0c040'; x.beginPath(); x.moveTo(pad.l, Y(f.stats.meanUm)); x.lineTo(W - pad.r, Y(f.stats.meanUm)); x.stroke(); x.setLineDash([]);
    if (f.stats.uAtMaxMm != null) { const px = X(f.stats.uAtMaxMm * 1000), py = Y(f.stats.maxUm); x.strokeStyle = x.fillStyle = '#ff3030'; x.beginPath(); x.moveTo(px - 4, py - 4); x.lineTo(px + 4, py + 4); x.moveTo(px + 4, py - 4); x.lineTo(px - 4, py + 4); x.stroke(); x.fillStyle = '#ffe14d'; x.font = '12px system-ui'; x.fillText(`[max]${f.stats.maxUm.toFixed(2)}µm`, Math.min(W - 110, px + 6), Math.max(12, py - 6)); }
  }

  // ---------- Alicona ----------
  function devColor(d, range) {   // Alicona-like pseudo colour: 0 green, below -> cyan / blue / magenta, above -> yellow / red
    const t = Math.max(-1, Math.min(1, d / range)), stops = t < 0 ? [[0, [.25, .78, .3]], [-.33, [.1, .8, .85]], [-.66, [.15, .3, .95]], [-1, [.85, .1, .8]]] : [[0, [.25, .78, .3]], [.5, [.95, .9, .15]], [1, [.95, .15, .1]]];
    for (let j = 1; j < stops.length; j++) { const [a, ca] = stops[j - 1], [b, cb] = stops[j]; if ((t - a) * (t - b) <= 0) { const u = (t - a) / (b - a || 1); return ca.map((v, k) => v + (cb[k] - v) * u); } }
    return stops[stops.length - 1][1];
  }
  const devRange = R => {
    if (R.rngUm) return R.rngUm;
    const a = []; if (R.dev) for (const arr of [R.dev.side, R.dev.end]) for (let k = 0; k < arr.length; k++) if (arr[k]) a.push(-arr[k] * 1000);
    a.sort((p, q) => p - q); const p90 = a.length ? a[Math.floor(.9 * (a.length - 1))] : 0;
    return (R.rngUm = Math.max(2 * R.o.devTolUm, 10, Math.min(1.25 * p90, R.wmm ? Math.abs(R.wmm.DminUm) : Infinity)));
  };
  let V = null;   // 3D deviation viewer
  function view3d() {
    const R = S.R, box = $('#paView'); if (!box) return;
    const THREE = window.THREE, G = T._render && T._render.geometry, rp = T.render && T.render.params;
    const rng = devRange(R), lg = $('#paLegend');
    lg.innerHTML = `<div class="ps-lgbar" style="background:linear-gradient(${[1, .5, 0, -.33, -.66, -1].map(t => `rgb(${devColor(t * rng, rng).map(v => Math.round(255 * v)).join(',')})`).join(',')})"></div>
      <div class="ps-lgt">${[1, .5, 0, -.5, -1].map(t => `<span>${(t * rng).toFixed(1)}</span>`).join('')}</div><div class="ps-lgu">µm${R.wmm && Math.abs(R.wmm.DminUm) > rng + .5 ? `<br>≤−${rng.toFixed(0)} 포화 (최저 ${R.wmm.DminUm.toFixed(0)})` : ''}</div>`;
    if (!THREE || !G || !rp || !R.dev) { box.dataset.state = 'no-map'; return; }
    if (!V) {
      const r = new THREE.WebGLRenderer({antialias: true, preserveDrawingBuffer: true}); r.setPixelRatio(Math.min(2, devicePixelRatio || 1));
      r.outputEncoding = THREE.sRGBEncoding; box.prepend(r.domElement); r.domElement.style.cssText = 'width:100%;height:100%;display:block';
      const scene = new THREE.Scene(); scene.background = new THREE.Color(0x14171c);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x303338, .75)); const key = new THREE.DirectionalLight(0xffffff, .8); key.position.set(3, 5, 4); scene.add(key);
      const cam = new THREE.PerspectiveCamera(22, 1, .1, 2000), head = new THREE.DirectionalLight(0xffffff, .5); head.position.set(0, 0, 1); cam.add(head); scene.add(cam);
      const ctl = new THREE.OrbitControls(cam, r.domElement); ctl.enableDamping = false;
      const group = new THREE.Group(); group.rotation.x = Math.PI / 2; scene.add(group);
      V = {r, scene, cam, ctl, group, key: null, draw: () => r.render(scene, cam)};
      ctl.addEventListener('change', V.draw);
      new ResizeObserver(() => { const w = box.clientWidth || 400, h = box.clientHeight || 340; r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); V.draw(); }).observe(box);
    }
    const key = [R.map, R.o.devTolUm, JSON.stringify(rp)].map(v => typeof v === 'object' ? v && v.faces && v.faces.length : v).join('|') + (R.map && R.map.totals && R.map.totals.chip.areaMm2);
    if (V.key !== key || V.map !== R.map) {
      V.key = key; V.map = R.map;
      while (V.group.children.length) { const m = V.group.children.pop(); m.geometry.dispose(); }
      const deform = R.map && R.map.totals && R.map.totals.chip.areaMm2 > 0 && T.map3dCore ? T.map3dCore.deformer(R.map) : null;
      const b = G.build(rp, deform), mat = new THREE.MeshStandardMaterial({vertexColors: true, roughness: .55, metalness: .1});
      let nDev = 0;
      for (const [name, g] of Object.entries(b.parts)) {
        const p = g.getAttribute('position').array, col = new Float32Array(p.length);
        for (let v = 0; v < p.length; v += 3) {
          const d = name === 'cap' ? 0 : C.devAt(R.dev, p[v], p[v + 1], p[v + 2], name === 'end' ? 'end' : 'side') * 1000;
          if (d) nDev++;
          const c = d ? devColor(d, rng) : [.55, .58, .6];                      // untouched surface: neutral grey
          col[v] = c[0]; col[v + 1] = c[1]; col[v + 2] = c[2];
        }
        g.setAttribute('color', new THREE.BufferAttribute(col, 3));
        V.group.add(new THREE.Mesh(g, mat));
      }
      box.dataset.state = 'ok'; box.dataset.devVerts = nDev;
      const D = rp.diameterMm, tgt = new THREE.Vector3(0, -.45 * D, 0), dir = new THREE.Vector3(.75, .55, .9).normalize();
      V.cam.position.copy(tgt).addScaledVector(dir, 3.4 * D); V.ctl.target.copy(tgt); V.ctl.update();
    }
    const w = box.clientWidth || 400, h = box.clientHeight || 340; V.r.setSize(w, h, false); V.cam.aspect = w / h; V.cam.updateProjectionMatrix(); V.draw();
  }
  function drawProfile() {
    const f = cur(), [x, W, H] = canvasFit($('#paProfile'), 190); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); if (!f) return;
    const E = f.E, q = f.eq, L = E.u.length ? E.u[E.u.length - 1] + E.du / 2 : 1, dMin = Math.min(-2 * q.tolUm, q.Ddmax || 0, ...E.D) * 1.1, dMax = Math.max(4, .15 * -dMin), pad = {l: 44, r: 10, t: 10, b: 24};
    const X = u => pad.l + u / L * (W - pad.l - pad.r), Y = d => pad.t + (dMax - d) / (dMax - dMin) * (H - pad.t - pad.b);
    const ks = q.source === 'wear-post' && q.L ? L / q.L : 1, Xd = u => X(u * ks);   // measured defects lie along the AI land: scaled to this edge
    x.fillStyle = 'rgba(230,40,40,.13)'; for (const d of q.defects) x.fillRect(Xd(d.u0Um), pad.t, Math.max(2, Xd(d.u1Um) - Xd(d.u0Um)), H - pad.t - pad.b);
    x.strokeStyle = '#ccd'; x.lineWidth = 1; x.font = '10px system-ui'; x.fillStyle = '#334'; x.textAlign = 'right';
    const step = Math.pow(10, Math.floor(Math.log10(dMax - dMin))) / (dMax - dMin > 50 ? 1 : 2);
    for (let v = Math.ceil(dMin / step) * step; v <= dMax; v += step) { x.beginPath(); x.moveTo(pad.l, Y(v)); x.lineTo(W - pad.r, Y(v)); x.stroke(); x.fillText(v.toFixed(0), pad.l - 4, Y(v) + 3); }
    x.textAlign = 'center'; for (let j = 0; j <= 5; j++) x.fillText((L * j / 5).toFixed(0), X(L * j / 5), H - pad.b + 13);
    x.textAlign = 'left'; x.fillText('[µm]', 2, 10); x.fillText('[µm]', W - 30, H - 2);
    x.setLineDash([5, 3]); x.strokeStyle = '#d0342c'; x.beginPath(); x.moveTo(pad.l, Y(-q.tolUm)); x.lineTo(W - pad.r, Y(-q.tolUm)); x.stroke(); x.setLineDash([]);
    x.strokeStyle = '#1f3fbf'; x.lineWidth = 1.5; x.beginPath(); E.D.forEach((d, j) => { const px = X(E.u[j]), py = Y(d); j ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke();
    if (q.uAtDdmax != null) { x.fillStyle = q.source === 'wear-post' ? '#d0342c' : '#1f3fbf'; x.font = '600 11px system-ui'; const px = Xd(q.uAtDdmax), py = Y(q.Ddmax); x.fillText('+', px - 3, py + 4); x.fillText(`Ddmax ${q.Ddmax.toFixed(1)} µm`, Math.min(W - 110, px + 6), Math.min(H - pad.b - 4, py + 14)); }
    const pos = S.pos == null ? null : X(S.pos * L); if (pos != null) { x.strokeStyle = '#111'; x.setLineDash([2, 2]); x.beginPath(); x.moveTo(pos, pad.t); x.lineTo(pos, H - pad.b); x.stroke(); x.setLineDash([]); }
    $('#paProfTag').textContent = `F${f.i + 1} · 파랑 = 모델 깊이 VB·tan α (α ${f1(S.R.o.clearanceDeg)}°)` + (q.source === 'wear-post' ? ` · 빨강 = AI 영역 측정 결함 (날 후퇴, 기준 −${f1(q.tolUm)} µm)` : ` · 결함 기준 −${q.tolUm} µm`);
  }
  function drawSection() {
    const f = cur(), [x, W, H] = canvasFit($('#paSection'), 220); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H); if (!f) return;
    const E = f.E, n = E.D.length; if (!n) return;
    if (S.pos == null) { const iMin = E.D.reduce((b, d, j) => d < E.D[b] ? j : b, 0); S.pos = (iMin + .5) / n; $('#paPos').value = Math.round(S.pos * 1000); }
    const i = Math.max(0, Math.min(n - 1, Math.floor(S.pos * n))), vb = E.vb[i] / 1000, o = S.R.o, corner = !!E.corner[i];
    const w = C.wedgeSection(corner ? -E.D[i] / 1000 / Math.tan(o.clearanceDeg * Math.PI / 180) : vb, {clearanceDeg: o.clearanceDeg, rakeDeg: o.rakeDeg, lenMm: Math.max(.06, 2.4 * Math.max(vb, .02))});
    const pts = w.nominal.concat(w.worn), xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), xmin = Math.min(...xs), ymin = Math.min(...ys);
    const s = Math.min((W - 130) / (0 - xmin || 1), (H - 50) / (0 - ymin || 1)) * .9, ox = W - 90, oy = 28, P = p => [ox + p[0] * s, oy - p[1] * s];
    // worn body (filled), nominal outline dashed
    x.fillStyle = '#e4e1e1'; x.strokeStyle = '#111'; x.lineWidth = 1.4; x.beginPath(); w.worn.forEach((p, j) => j ? x.lineTo(...P(p)) : x.moveTo(...P(p)));
    x.lineTo(...P([xmin, ymin])); x.closePath(); x.fill(); x.beginPath(); w.worn.forEach((p, j) => j ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.stroke();
    x.setLineDash([5, 4]); x.strokeStyle = '#1f5fbf'; x.beginPath(); w.nominal.forEach((p, j) => j ? x.lineTo(...P(p)) : x.moveTo(...P(p))); x.stroke(); x.setLineDash([]);
    x.font = '11px system-ui'; x.fillStyle = '#333'; x.fillText('경사면 (rake)', ...P([w.nominal[0][0] + .02 * (0 - xmin), w.nominal[0][1] * .6]));
    x.fillText('여유면 (clearance)', P([xmin * .75, 0])[0], P(w.nominal[2])[1] + 16);
    if (vb > 0 || corner) {
      const [ex, ey] = P([0, 0]), [lx, ly] = P([-w.hMm * Math.tan(o.rakeDeg * Math.PI / 180), -w.hMm]);
      x.strokeStyle = '#d0342c'; x.beginPath(); x.moveTo(ex, ey); x.lineTo(ex, ly); x.stroke(); x.fillStyle = '#d0342c'; x.fillText(`D ${(w.hMm * 1000).toFixed(1)} µm`, ex + 4, (ey + ly) / 2 + 4);
      x.fillStyle = '#333'; x.fillText(`Ldc ${(w.LdcMm * 1000).toFixed(1)} µm`, P([-w.LdcMm * .7, -w.hMm])[0] - 30, ly + 16); x.fillText(`Ldr ${(w.LdrMm * 1000).toFixed(1)} µm`, lx - 70, ly - 6);
    }
    $('#paSecTag').textContent = `F${f.i + 1} · u = ${f1(E.u[i])} µm · VB ${f1(E.vb[i])} µm${corner ? ' · 코너 파손' : ''} · 쐐기각 ${w.wedgeDeg}°`;
    drawProfile();
  }
  function renderAlicona() {
    const R = S.R, f = cur(); if (!f) return;
    const q = f.eq, fmt = (k, v) => v == null ? '—' : /^(Nd|Vdmax|Vdmean)$/.test(k) ? String(Math.round(v)) : f2(v);
    const src = k => q.measured.includes(k) ? '<span class="ps-src m" title="AI 마모 영역에서 측정 (wear-post)">측정</span>' : '<span class="ps-src" title="쐐기 모델 추정 (VB·tan α): 사진으로는 경사면·높이를 알 수 없음">모델</span>';
    $('#paEq').innerHTML = `<tr><th>Name</th><th>Value</th><th>[u]</th><th>Description</th><th></th></tr>` + C.EQ_ROWS.map(([k, u, d]) => `<tr><td>${k}</td><td>${fmt(k, q[k])}</td><td>${u}</td><td>${d}</td><td>${src(k)}</td></tr>`).join('');
    $('#paEqTag').textContent = `F${f.i + 1} · ${q.Nd}개 결함 · ${q.source === 'wear-post' ? '날 프로파일 = AI 마모 영역 (결함 기준 ' + f1(q.tolUm) + ' µm)' : '쐐기 모델'}`;
    const w = R.wmm;
    $('#paWmm').innerHTML = `<tr><th>Name</th><th>Value</th><th>[u]</th><th>Description</th></tr>` + (w ? C.WMM_ROWS.map(([n, k, u, d]) => `<tr><td>${n}</td><td>${/Mm3/.test(k) ? f4(w[k]) : f2(w[k])}</td><td>${u}</td><td>${d}</td></tr>`).join('') : '<tr><td colspan="4" class="hint">3D 매핑 결과 없음</td></tr>') +
      `<tr><td>VBmax</td><td>${f3(R.vbMaxMm)}</td><td>mm</td><td>최대 플랭크 마모 (④ 측정)</td></tr><tr><td>VBmean</td><td>${f3(R.vbMeanMm)}</td><td>mm</td><td>평균 플랭크 마모</td></tr>` +
      `<tr><td>VB</td><td>${f3(f.E.vb[Math.max(0, Math.min(f.E.vb.length - 1, Math.floor((S.pos || 0) * f.E.vb.length)))] / 1000)}</td><td>mm</td><td>현재 위치 VB (단면 슬라이더)</td></tr>`;
    $('#paFaces').innerHTML = `<tr><th>면</th><th>Dmin µm</th><th>Dmean µm</th><th>Vv mm³</th><th>Vdv mm³</th><th>편차 면적 mm²</th></tr>` +
      (R.faces.length ? R.faces.map(p => `<tr><td>${p.face}${p.kind === 'side' ? ` (${Math.round(p.angleDeg)}°)` : ''}</td><td>${f1(p.DminUm)}</td><td>${f1(p.DmeanUm)}</td><td>${f4(p.VvMm3)}</td><td>${f4(p.VdvMm3)}</td><td>${f3(p.areaMm2)}</td></tr>`).join('') : '<tr><td colspan="6" class="hint">—</td></tr>');
    $('#paChips').innerHTML = `<tr><th>#</th><th>위치</th><th>날</th><th>z (mm)</th><th>길이 mm</th><th>면적 mm²</th><th>최대 깊이 µm</th><th>체적 mm³</th></tr>` +
      (R.chips.length ? R.chips.slice(0, 12).map(c => `<tr><td>${c.n}</td><td>${c.where === 'end' ? '끝면' : '측면'}</td><td>${c.tooth == null ? '—' : c.tooth + 1}</td><td>${c.where === 'end' ? `r≤${f2(c.rMaxMm)}` : `${f2(c.z0Mm)}–${f2(c.z1Mm)}`}</td><td>${f3(c.lengthMm)}</td><td>${f4(c.areaMm2)}</td><td>${f1(c.maxDepthUm)}</td><td>${f4(c.volumeMm3)}</td></tr>`).join('') : '<tr><td colspan="8" class="hint">치핑 없음</td></tr>');
    const tl = R.tol, keyU = {vbMaxMm: .01, ddMaxUm: 1, pdPct: 1, chipDepthUm: 1, vdvMm3: .001};
    $('#paTol').innerHTML = `<tr><th>항목</th><th>값</th><th>한계</th><th>판정</th></tr>` + tl.rows.map(r => `<tr><td>${r.label}</td><td>${r.value == null ? '—' : r.unit === 'mm³' ? f4(r.value) : r.unit === 'mm' ? f3(r.value) : f1(r.value)} ${r.unit}</td>
      <td>${r.key === 'vbMaxMm' ? `${f3(r.limit)} <small>(④)</small>` : `<input data-tol="${r.key}" type="number" step="${keyU[r.key]}" min="0" value="${r.limit}">`}</td><td>${r.pass == null ? '<span class="hint">—</span>' : r.pass ? '<b class="ps-ok">PASS</b>' : '<b class="ps-ng">FAIL</b>'}</td></tr>`).join('') +
      `<tr class="ps-foot"><td colspan="3">종합</td><td>${tl.pass == null ? '—' : tl.pass ? '<b class="ps-ok">PASS</b>' : '<b class="ps-ng">FAIL</b>'}</td></tr>`;
    root.querySelectorAll('[data-tol]').forEach(inp => inp.onchange = e => { S.prefs.tol[e.target.dataset.tol] = +e.target.value; savePrefs(); refresh(); });
  }
  function drawTrend() {
    const R = S.R, [x, W, H] = canvasFit($('#paTrend'), 190); x.fillStyle = '#fff'; x.fillRect(0, 0, W, H);
    const list = R.hist.concat([{vbMax: R.vbMaxMm, current: true, profile: profileOf(worstFlute())}]), tr = R.trend, L = R.limitMm || .3;
    $('#paTrTag').textContent = `${safeId()} · ${R.hist.length}건 (${R.histSource === 'post' ? '후처리 이력' : '④ 측정 이력'})` + (tr ? ` · ${tr.slope > 0 ? '+' : ''}${(tr.slope * 1000).toFixed(1)} µm/${tr.per === 'min' ? 'min' : '회'}${tr.remaining != null ? ` · 한계까지 약 ${f1(tr.remaining)}${tr.per === 'min' ? ' min' : '회'}` : ''}` : ' · 추세: 2건 이상 저장 필요');
    const xMax = Math.max(list.length, tr && tr.xAtLimit && tr.per !== 'min' ? Math.min(tr.xAtLimit, 3 * list.length) : 0) + .5, yMax = Math.max(L * 1.2, ...list.map(e => e.vbMax || 0)) * 1.05, pad = {l: 40, r: 10, t: 10, b: 22};
    const X = i => pad.l + i / xMax * (W - pad.l - pad.r), Y = v => H - pad.b - v / yMax * (H - pad.t - pad.b);
    x.strokeStyle = '#dde1e6'; x.fillStyle = '#556'; x.font = '10px system-ui'; x.textAlign = 'right';
    for (let v = 0; v <= yMax; v += yMax > .6 ? .2 : .1) { x.beginPath(); x.moveTo(pad.l, Y(v)); x.lineTo(W - pad.r, Y(v)); x.stroke(); x.fillText(v.toFixed(1), pad.l - 4, Y(v) + 3); }
    x.textAlign = 'center'; for (let i = 1; i <= Math.floor(xMax); i++) x.fillText(i, X(i), H - pad.b + 12); x.textAlign = 'left'; x.fillText('VBmax mm', 2, 9); x.fillText('#', W - 12, H - 2);
    x.setLineDash([6, 4]); x.strokeStyle = '#d0342c'; x.beginPath(); x.moveTo(pad.l, Y(L)); x.lineTo(W - pad.r, Y(L)); x.stroke();
    if (tr && tr.per !== 'min') { x.strokeStyle = '#1f5fbf'; x.beginPath(); x.moveTo(X(1), Y(tr.intercept + tr.slope)); const xe = Math.min(xMax, tr.xAtLimit || xMax); x.lineTo(X(xe), Y(tr.intercept + tr.slope * xe)); x.stroke(); }
    x.setLineDash([]); x.strokeStyle = '#345'; x.beginPath(); list.forEach((e, i) => { if (e.vbMax == null) return; i ? x.lineTo(X(i + 1), Y(e.vbMax)) : x.moveTo(X(i + 1), Y(e.vbMax)); }); x.stroke();
    list.forEach((e, i) => { if (e.vbMax == null) return; x.fillStyle = e.current ? '#ff7f0e' : e.vbMax >= L ? '#d0342c' : '#1e9e4a'; x.beginPath(); x.arc(X(i + 1), Y(e.vbMax), e.current ? 5 : 3.5, 0, 7); x.fill(); });
    // replay: VB(u) of the selected entry (inset)
    const an = $('#paAnim'); an.max = String(list.length - 1); if (S.anim < 0 || S.anim > list.length - 1) S.anim = list.length - 1; an.value = String(S.anim);
    const e = list[S.anim], pr = e && e.profile; $('#paAnimTag').textContent = e ? `#${S.anim + 1}${e.current ? ' (현재)' : e.date ? ' ' + e.date : ''} · VBmax ${f3(e.vbMax)} mm` : '';
    if (pr && pr.length > 1) {
      const iw = Math.min(170, W * .38), ih = 64, ix = W - pad.r - iw - 4, iy = pad.t + 4, vm = Math.max(L, ...list.flatMap(q => q.profile || []).map(v => v / 1000)) * 1.1;
      x.fillStyle = 'rgba(255,255,255,.92)'; x.fillRect(ix, iy, iw, ih); x.strokeStyle = '#b8c0c8'; x.strokeRect(ix, iy, iw, ih);
      list.forEach((q, j) => { if (!q.profile || j > S.anim) return; x.strokeStyle = j === S.anim ? '#d0342c' : 'rgba(80,100,130,.35)'; x.lineWidth = j === S.anim ? 1.6 : 1; x.beginPath(); q.profile.forEach((v, k) => { const px = ix + 3 + k / (q.profile.length - 1) * (iw - 6), py = iy + ih - 3 - v / 1000 / vm * (ih - 6); k ? x.lineTo(px, py) : x.moveTo(px, py); }); x.stroke(); });
      x.fillStyle = '#556'; x.fillText('VB(u) 재생', ix + 4, iy + 11);
    }
  }
  function play() {
    if (S.playing) { clearInterval(S.playing); S.playing = null; $('#paPlay').textContent = '▶ 마모 진행'; return; }
    S.anim = 0; drawTrend(); $('#paPlay').textContent = '■ 정지';
    S.playing = setInterval(() => { const n = S.R.hist.length + 1; S.anim = (S.anim + 1) % n; drawTrend(); if (S.anim === n - 1) { clearInterval(S.playing); S.playing = null; $('#paPlay').textContent = '▶ 마모 진행'; } }, 700);
  }
  const worstFlute = () => { const R = S.R; let w = null; R.flutes.forEach(f => { if (f && (!w || f.stats.maxUm > w.stats.maxUm)) w = f; }); return w; };
  function profileOf(f) { if (!f) return null; const p = f.prof, n = Math.min(60, p.length), out = []; for (let j = 0; j < n; j++) out.push(p[Math.floor(j * (p.length - 1) / Math.max(1, n - 1))].vbUm); return out; }
  function saveHistory() {
    const R = S.R; if (!R || R.vbMaxMm == null) return;
    const now = new Date(), pad = v => String(v).padStart(2, '0'), wf = worstFlute();
    C.historyAdd(store, (T.metro.state.prefs.toolId || 'unnamed'), {t: now.getTime(), date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
      vbMax: R.vbMaxMm, U: R.vbU, DminUm: R.wmm ? R.wmm.DminUm : null, VvMm3: R.wmm ? R.wmm.VvMm3 : null, Pd: wf ? wf.eq.Pd : null, Ddmax: wf ? wf.eq.Ddmax : null, pass: R.tol.pass, profile: profileOf(wf)});
    S.anim = -1; refresh();
  }

  // ---------- report sections (metro-report.js hooks) ----------
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
  function snapshot(sel, maxW = 900) {   // canvas (or the WebGL canvas inside a box) -> JPEG canvas with white background
    const c = typeof sel === 'string' ? $(sel) : sel; if (!c || !c.width) return null;
    const k = Math.min(1, maxW / c.width), o = Object.assign(document.createElement('canvas'), {width: Math.round(c.width * k), height: Math.round(c.height * k)}), x = o.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, o.width, o.height); try { x.drawImage(c, 0, 0, o.width, o.height); } catch (e) { return null; } return o;
  }
  function ensureDrawn() { const t = S.tab; if (!S.R) return; S.tab = 'keyence'; drawKeyence(); drawVbChart(); S.tab = 'alicona'; view3d(); drawProfile(); drawSection(); drawTrend(); S.tab = t; }
  function htmlSection() {
    const R = S.R; if (!R) return '';
    const vis = {k: $('#psBody [data-pane="keyence"]').hidden, a: $('#psBody [data-pane="alicona"]').hidden};
    root.querySelectorAll('[data-pane]').forEach(p => p.hidden = false); ensureDrawn();
    const img = s => { const c = snapshot(s); return c ? `<img src="${c.toDataURL('image/jpeg', .88)}">` : ''; };
    const kImg = img('#pkCanvas'), cImg = img('#pkChart'), dImg = img('#paView canvas'), pImg = img('#paProfile'), sImg = img('#paSection'), tImg = img('#paTrend');
    $('#psBody [data-pane="keyence"]').hidden = vis.k; $('#psBody [data-pane="alicona"]').hidden = vis.a; render();
    const fl = R.flutes.filter(Boolean), w = R.wmm;
    return `<section class="post"><h2>Post-processing — Keyence VHX style</h2>
<div class="imgs">${kImg ? `<figure><img style="height:260px" src="${snapshot('#pkCanvas').toDataURL('image/jpeg', .88)}"><figcaption>F${S.sel + 1} VB overlay (reference edge line, [n] VB, scale bar)</figcaption></figure>` : ''}${cImg ? `<figure>${cImg.replace('<img', '<img style="height:160px"')}<figcaption>VB along the edge</figcaption></figure>` : ''}</div>
<table><tr><th>Flute</th><th>VBmax µm</th><th>VBmean µm</th><th>VBmin µm</th><th>σ µm</th><th>worn mm</th><th>mag (VHX eq.)</th><th>px/mm</th><th>[n] VB µm</th></tr>
${fl.map(f => `<tr><td>F${f.i + 1}</td><td>${f2(f.stats.maxUm)}</td><td>${f2(f.stats.meanUm)}</td><td>${f2(f.stats.minUm)}</td><td>${f2(f.stats.sdUm)}</td><td>${f3(f.stats.wornMm)}</td><td>${f.mag.label}</td><td>${f2(f.pxPerMm)}</td><td>${f.lines.map(l => `[${l.n}]${f1(l.vbUm)}`).join(' ')}</td></tr>`).join('')}</table>
<h2>Post-processing — Alicona style (deviation vs nominal model, EdgeQuality)</h2>
<div class="imgs">${dImg ? `<figure>${dImg.replace('<img', '<img style="height:220px"')}<figcaption>3D deviation map (µm)</figcaption></figure>` : ''}${pImg ? `<figure>${pImg.replace('<img', '<img style="height:150px"')}<figcaption>Edge profile F${S.sel + 1}</figcaption></figure>` : ''}${sImg ? `<figure>${sImg.replace('<img', '<img style="height:150px"')}<figcaption>Cross section</figcaption></figure>` : ''}</div>
<table><tr><th>Flute</th>${C.EQ_ROWS.map(r => `<th>${r[0]}${r[1] ? ` <small>${r[1]}</small>` : ''}</th>`).join('')}</tr>${fl.map(f => `<tr><td>F${f.i + 1}</td>${C.EQ_ROWS.map(r => `<td>${/^(Nd|Vdmax|Vdmean)$/.test(r[0]) ? Math.round(f.eq[r[0]]) : f1(f.eq[r[0]])}</td>`).join('')}</tr>`).join('')}</table>
${w ? `<table><tr><th>Model</th>${C.WMM_ROWS.map(r => `<th>${r[0]} <small>${r[2]}</small></th>`).join('')}</tr><tr><td>all faces</td>${C.WMM_ROWS.map(r => `<td>${/Mm3/.test(r[1]) ? f4(w[r[1]]) : f1(w[r[1]])}</td>`).join('')}</tr>
${R.faces.map(p => `<tr><td>${esc(p.face)}</td>${C.WMM_ROWS.map(r => `<td>${/Mm3/.test(r[1]) ? f4(p[r[1]]) : f1(p[r[1]])}</td>`).join('')}</tr>`).join('')}</table>` : ''}
${R.chips.length ? `<table><tr><th>Chip</th><th>where</th><th>tooth</th><th>z mm</th><th>length mm</th><th>area mm²</th><th>max depth µm</th><th>volume mm³</th></tr>${R.chips.slice(0, 10).map(c => `<tr><td>${c.n}</td><td>${c.where}</td><td>${c.tooth == null ? '-' : c.tooth + 1}</td><td>${f2(c.z0Mm)}-${f2(c.z1Mm)}</td><td>${f3(c.lengthMm)}</td><td>${f4(c.areaMm2)}</td><td>${f1(c.maxDepthUm)}</td><td>${f4(c.volumeMm3)}</td></tr>`).join('')}</table>` : ''}
<table><tr><th>Tolerance</th><th>value</th><th>limit</th><th>result</th></tr>${R.tol.rows.map(r => `<tr><td>${esc(r.label)}</td><td>${r.value == null ? '-' : r.value} ${r.unit}</td><td>${r.limit} ${r.unit}</td><td>${r.pass == null ? '-' : r.pass ? 'PASS' : 'FAIL'}</td></tr>`).join('')}<tr><td>overall</td><td></td><td></td><td><b>${R.tol.pass == null ? '-' : R.tol.pass ? 'PASS' : 'FAIL'}</b></td></tr></table>
${tImg ? `<div class="imgs"><figure>${tImg.replace('<img', '<img style="height:150px"')}<figcaption>Tool life trend${R.trend ? ` (${(R.trend.slope * 1000).toFixed(1)} µm per ${R.trend.per}${R.trend.remaining != null ? `, ~${f1(R.trend.remaining)} to the limit` : ''})` : ''}</figcaption></figure></div>` : ''}
<p class="note">Depths and volumes are estimates from the wedge model (VB·tan α, clearance ${f1(R.o.clearanceDeg)}°, rake ${f1(R.o.rakeDeg)}°) and the map3d chip depth: photographs give no height. Magnification = Keyence VHX equivalent (297 mm / field of view).</p></section>`;
  }
  function pdfPage() {
    const R = S.R, M = T.metroCore; if (!R || !M) return null;
    ensureDrawn();
    const P = M.PdfPage(), W = P.W, L = 36, Rr = W - 36, jpeg = c => { const b = atob(c.toDataURL('image/jpeg', .88).split(',')[1]), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
    P.rect(0, 0, W, 50, '#1f2a36'); P.text(L, 24, 'Post-processing - Keyence VHX / Alicona style', 14, {bold: true, color: '#ffffff'});
    P.text(L, 40, 'Tool ' + ((T.metro.state.prefs.toolId) || '-') + ' - depths from the wedge model (VB tan a) and map3d chip depth; photos give no height', 8, {color: '#c8d2dc'});
    const ok = R.tol.pass; P.rect(Rr - 110, 12, 110, 26, ok == null ? '#889999' : ok ? '#1e9e4a' : '#d0342c'); P.text(Rr - 55, 29, 'TOLERANCE ' + (ok == null ? '-' : ok ? 'PASS' : 'FAIL'), 9, {bold: true, color: '#ffffff', align: 'center'});
    let y = 64; const put = (sel, x0, w0, maxH) => { const c = snapshot(sel, 800); if (!c) return 0; const h = Math.min(maxH, w0 * c.height / c.width), w = h * c.width / c.height; P.image(jpeg(c), c.width, c.height, x0, y, w, h); return h; };
    const h1 = Math.max(put('#pkCanvas', L, 250, 200), put('#paView canvas', L + 262, 260, 200)); y += h1 + 6;
    P.text(L, y + 4, 'Keyence overlay F' + (S.sel + 1) + ' (reference edge, [n] VB, scale bar)', 7, {color: '#667788'}); P.text(L + 262, y + 4, '3D deviation vs nominal (um, negative = material loss)', 7, {color: '#667788'}); y += 14;
    const h2 = Math.max(put('#paProfile', L, 300, 120), put('#paSection', L + 312, 210, 120)); y += h2 + 12;
    const fl = R.flutes.filter(Boolean), cols = [['Flute', 34], ['VBmax um', 50], ['VBmean', 44], ['sd', 34], ['Nd', 24], ['Pd %', 36], ['Ddmax um', 50], ['Ldmax um', 50], ['Ldcmax', 44], ['Ldrmax', 44], ['Vdrel um2', 50], ['mag', 40]];
    P.rect(L, y - 10, Rr - L, 14, '#e8edf2'); let x = L + 3; cols.forEach(([h, w]) => { P.text(x, y, h, 7.5, {bold: true}); x += w; }); y += 13;
    fl.forEach(f => { x = L + 3; ['F' + (f.i + 1), f2(f.stats.maxUm), f2(f.stats.meanUm), f2(f.stats.sdUm), f.eq.Nd, f1(f.eq.Pd), f1(f.eq.Ddmax), f1(f.eq.Ldmax), f1(f.eq.Ldcmax), f1(f.eq.Ldrmax), f1(f.eq.Vdrel), f.mag.label].forEach((c, j) => { P.text(x, y, String(c), 8); x += cols[j][1]; }); P.line(L, y + 4, Rr, y + 4, .3, '#d5d9e0'); y += 12; });
    y += 8;
    if (R.wmm) {
      P.text(L, y, 'Wear measurement (deviation vs nominal model)', 9, {bold: true}); y += 12; x = L;
      C.WMM_ROWS.forEach(r => { P.text(x, y, r[0] + ' ' + (/Mm3/.test(r[1]) ? f4(R.wmm[r[1]]) : f1(R.wmm[r[1]])) + ' ' + r[2].replace('µ', 'u').replace('³', '3'), 8); x += 74; }); y += 16;
    }
    P.text(L, y, 'Chipping', 9, {bold: true}); P.text(L + 290, y, 'Tolerances', 9, {bold: true}); y += 12; let yc = y, yt = y;
    (R.chips.length ? R.chips.slice(0, 6) : [null]).forEach(c => { P.text(L, yc, c ? `#${c.n} ${c.where}${c.tooth == null ? '' : ' T' + (c.tooth + 1)} z ${f2(c.z0Mm)}-${f2(c.z1Mm)} mm, A ${f4(c.areaMm2)} mm2, d ${f1(c.maxDepthUm)} um, V ${f4(c.volumeMm3)} mm3` : 'no chipping', 7.5); yc += 10; });
    R.tol.rows.forEach(r => { P.text(L + 290, yt, `${r.key}: ${r.value == null ? '-' : r.value} / ${r.limit} ${r.unit.replace('µ', 'u').replace('³', '3')}  ${r.pass == null ? '-' : r.pass ? 'PASS' : 'FAIL'}`, 7.5, {color: r.pass === false ? '#d0342c' : '#1d2330'}); yt += 10; });
    y = Math.max(yc, yt) + 8;
    if (y < P.H - 200) { const h = put('#paTrend', L, 330, 130); P.text(L, y + h + 10, 'Tool life trend: ' + (R.trend ? `${(R.trend.slope * 1000).toFixed(1)} um per ${R.trend.per}` + (R.trend.remaining != null ? `, about ${f1(R.trend.remaining)} to the limit` : '') : 'save 2+ results to fit a trend'), 7.5); }
    P.text(L, P.H - 24, 'Tool3D post-processing - reproduces Keyence VHX / Alicona evaluations from photographs; not a certified 3D measurement.', 7, {color: '#667788'});
    return P;
  }
  T.postReport = {csv: () => S.R ? C.csvRows(S.R) : '', html: htmlSection, pdfPage};
  T.post = {refresh, render, setTab, select, get result() { return S.R; }, set result(v) { S.R = v; }, get state() { return S; }, saveHistory};

  build();
  window.addEventListener('tool3d:metro', refresh);
  window.addEventListener('tool3d:map3d', refresh);
})();
