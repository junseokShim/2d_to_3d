/* Tool3D measurement panel ④: microscope-style flank wear VB on the calibrated (rectified) image (reference line on the
 * unworn edge, VB dimension lines with values, scale bar, equivalent magnification), VBmax / VBB / VBC / VBN per flute with
 * positions (ISO 8688-2), VB profile along the edge with statistics, end-face wear AREA per tooth (top photo), tolerance
 * verdict, uncertainty budget, calibration, tool-life trend; loupe, zoom/pan, 2-point distance, VB caliper and
 * drag-to-correct edge/band. Needs metro-core.js + metro-vb.js; report via metro-report.js.
 * Hook: Tool3D.metro.update({shots, flutes, diameterMm, engine}) after a wear run (reads Tool3D.wearResult/wearDebug).
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, M = T.metroCore, V = T.metroVb, MAXPX = 2400;
  const $ = (s, r = document) => r.querySelector(s), el = (tag, attrs = {}, html = '') => Object.assign(document.createElement(tag), attrs, html ? {innerHTML: html} : {});
  const COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf'];
  const LIGHT = {green: '#1e9e4a', amber: '#e0a100', red: '#d0342c'}, LBL = {green: 'OK', amber: 'WARN', red: 'LIMIT'};
  const f3 = v => (v == null || Number.isNaN(v)) ? '—' : (+v).toFixed(3), pm = x => `${f3(x.v)} <small>± ${f3(x.U)}</small>`;
  const PREF = 'tool3d.metro.prefs', store = (() => { try { return window.localStorage; } catch (e) { return null; } })() || {getItem: () => null, setItem: () => {}};
  const loadPrefs = () => { try { return JSON.parse(store.getItem(PREF) || '{}') || {}; } catch (e) { return {}; } };
  const S = {
    ready: false, sel: 0, tool: 'pan', src: 'strip', enh: false, dims: true, view: {s: 1, ox: 0, oy: 0}, pts: [], manual: [], ref: null, hover: null, drag: null, selNode: null,
    prefs: Object.assign({toolId: 'T-001', operator: '', limitMm: .3, warnPct: 80, cornerMm: '', apMm: '', diaTolMm: .01, refMm: 1, refTolMm: .002, nLines: 5, tolVbb: .5, tolVbc: .5, tolTop: .5}, loadPrefs())
  };
  const savePrefs = () => { try { store.setItem(PREF, JSON.stringify(S.prefs)); } catch (e) { /* private mode */ } };
  const opts = () => {
    const p = S.prefs, o = {helixDeg: S.helix, limitMm: +p.limitMm || .3, warnFrac: (+p.warnPct || 80) / 100, diaTolMm: +p.diaTolMm || 0};
    if (p.cornerMm !== '' && +p.cornerMm >= 0) o.cornerMm = +p.cornerMm;
    if (p.apMm !== '' && +p.apMm > 0) o.apMm = +p.apMm;
    const zo = S.zones;   // microscope (js/micro): zone C only where the corner is in view, no notch zone, unless typed in
    if (zo) for (const k of ['cornerMm', 'apMm', 'notchHalfMm']) if (zo[k] != null && (k === 'notchHalfMm' || p[k] === '')) o[k] = zo[k];
    return o;
  };

  // ---------- panel DOM ----------
  let root, cv, cx, loupe, lx, chart;
  function build() {
    root = $('#metro'); if (!root || root.dataset.built) return !!root;
    root.dataset.built = 1;
    const p = S.prefs, fld = (id, label, val, attrs = '') => `<label class="mt-f"><span>${label}</span><input id="${id}" value="${val}" ${attrs}></label>`;
    root.insertAdjacentHTML('beforeend', `
<div class="mt-head">
  <div class="mt-title"><h2>④ 측정 · 플랭크 마모 VB · 끝면 마모 면적 <small>ISO 8688-2 / ISO 3685</small></h2><div id="mtOverall" class="mt-badge">—</div></div>
  <div class="mt-fields">
    ${fld('mtTool', '공구 ID', p.toolId, 'autocomplete="off"')}${fld('mtOp', '측정자', p.operator, 'autocomplete="name"')}
    ${fld('mtLimit', '한계 VB (mm)', p.limitMm, 'type="number" step="0.01" min="0.01"')}${fld('mtWarn', '경고 (%)', p.warnPct, 'type="number" step="5" min="10" max="100"')}
    ${fld('mtCorner', 'C 구역 (mm)', p.cornerMm, 'type="number" step="0.1" min="0" placeholder="0.1·D"')}${fld('mtAp', 'ap 절입 (mm)', p.apMm, 'type="number" step="0.1" min="0" placeholder="0.5·D"')}
  </div>
</div>
<div class="mt-empty hint" id="mtEmpty">3D 생성 후 측정 결과가 여기에 표시됩니다.</div>
<div class="mt-grid" id="mtGrid" hidden>
  <div class="mt-work">
    <div class="mt-bar">
      <div class="mt-seg" id="mtFlutes"></div>
      <div class="mt-seg"><button data-src="strip" class="on" title="원통 보정·정렬된 교정 영상">Rectified</button><button data-src="photo" title="원본 사진 (분석 해상도)">Photo</button></div>
      <div class="mt-seg" id="mtEnh"><button data-enh="0" class="on" title="촬영 그대로">Photo</button><button data-enh="1" title="보정 영상 (화이트밸런스·반사 억제·노이즈 제거·CLAHE·샤픈). 기하는 동일 (px/mm 불변)">Enhanced</button></div>
      <div class="mt-seg" id="mtTools">
        <button data-tool="pan" class="on" title="이동 (드래그), 휠/핀치 확대">✥ Pan</button>
        <button data-tool="dist" title="두 점 거리">↔ 2-pt</button>
        <button data-tool="vb" title="절삭날 선에서의 수직 거리 (VB 캘리퍼)">⊥ VB</button>
        <button data-tool="edit" title="절삭날 선 / 마모 경계 드래그 보정">✎ Edge</button>
        <button data-tool="cal" title="기준 눈금자/체커보드 두 점 → 배율 교정">⌖ Cal</button>
      </div>
      <div class="mt-seg"><button id="mtZin" title="확대">＋</button><button id="mtZout" title="축소">−</button><button id="mtFit" title="맞춤">Fit</button></div>
      <div class="mt-seg"><button id="mtDims" class="on" title="기준선 · VB 치수선 · 스케일바 표시">치수</button></div>
      <label class="mt-nl" title="날마다 표시할 VB 치수선 수 (최대값 포함)">VB 선 <input id="mtNl" type="number" min="1" max="12" value="${p.nLines}"></label>
      <button id="mtReset" class="mt-ghost" title="이 날의 수동 보정 초기화">Reset edits</button>
    </div>
    <div class="mt-assist" id="mtAssist" hidden></div>
    <div class="mt-cwrap"><canvas id="mtCanvas"></canvas><canvas id="mtLoupe" width="160" height="160" hidden></canvas>
      <div class="mt-legend"><i class="mt-dash"></i>기준선 (미마모 날) <i style="background:#00d0ff"></i>절삭날 선 <i style="background:#ffd400"></i>마모 경계 <i style="background:rgba(255,40,40,.6)"></i>VB 밴드 <i style="background:#ff2a2a"></i>VB 치수</div></div>
    <div id="mtReadout" class="mt-readout">—</div>
    <table class="mt-man" id="mtManual"></table>
  </div>
  <div class="mt-side">
    <div class="mt-lights" id="mtLights"></div>
    <table class="mt-tab" id="mtTable"></table>
    <div class="mt-card"><div class="mt-h">VB 프로파일 · 절삭날 따라 <small id="mtZlbl">z = 팁에서 축방향 거리</small></div><canvas id="mtChart"></canvas></div>
    <div class="mt-card" id="mtDimList"></div>
    <div class="mt-card" id="mtTop"></div>
    <div class="mt-card" id="mtTol"></div>
    <div class="mt-card" id="mtCal"></div>
    <div class="mt-card" id="mtBudget"></div>
    <div class="mt-card" id="mtHist"></div>
    <div class="mt-exp">
      <button class="pri" id="mtPdf">Report PDF</button><button id="mtHtml">Report HTML</button><button id="mtPrint">Print</button><button id="mtCsv">CSV</button><button id="mtSave">이력 저장</button>
    </div>
  </div>
</div>`);
    cv = $('#mtCanvas'); cx = cv.getContext('2d'); loupe = $('#mtLoupe'); lx = loupe.getContext('2d'); chart = $('#mtChart');
    const bindPref = (id, key, num) => $('#' + id).addEventListener('input', e => { S.prefs[key] = num && e.target.value !== '' ? +e.target.value : e.target.value; savePrefs(); if (S.ready) { if (key !== 'toolId' && key !== 'operator') recompute(); else renderHist(); } });
    bindPref('mtTool', 'toolId'); bindPref('mtOp', 'operator'); bindPref('mtLimit', 'limitMm', 1); bindPref('mtWarn', 'warnPct', 1); bindPref('mtCorner', 'cornerMm', 1); bindPref('mtAp', 'apMm', 1);
    root.querySelectorAll('[data-src]').forEach(b => b.onclick = () => { S.src = b.dataset.src; mark('[data-src]', 'src', S.src); S.pts = []; fit(); });
    root.querySelectorAll('[data-enh]').forEach(b => b.onclick = () => { S.enh = b.dataset.enh === '1'; mark('[data-enh]', 'enh', S.enh ? '1' : '0'); draw(); });
    root.querySelectorAll('[data-tool]').forEach(b => b.onclick = () => setTool(b.dataset.tool));
    $('#mtZin').onclick = () => zoomAt(1.5); $('#mtZout').onclick = () => zoomAt(1 / 1.5); $('#mtFit').onclick = fit;
    $('#mtReset').onclick = () => { M.resetNodes(S.F[S.sel]); S.selNode = null; recompute(); };
    $('#mtDims').onclick = () => { S.dims = !S.dims; $('#mtDims').classList.toggle('on', S.dims); draw(); };
    $('#mtNl').onchange = e => { S.prefs.nLines = Math.max(1, Math.min(12, +e.target.value || 5)); savePrefs(); if (S.ready) recompute(); };
    $('#mtCsv').onclick = () => T.metroReport && T.metroReport.csv();
    $('#mtPdf').onclick = () => T.metroReport && T.metroReport.pdf();
    $('#mtHtml').onclick = () => T.metroReport && T.metroReport.html();
    $('#mtPrint').onclick = () => T.metroReport && T.metroReport.print();
    $('#mtSave').onclick = saveHistory;
    pointer();
    addEventListener('resize', () => S.ready && (sizeCanvas(), draw(), drawChart(), drawTop()));
    addEventListener('keydown', e => {
      if (!S.ready || !S.selNode || !/Arrow(Left|Right)/.test(e.key) || /INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) return;
      const F = S.F[S.sel], {i} = S.selNode, [pa, pb] = [nodePos(F, 'a', i), nodePos(F, 'b', i)];
      if (Math.abs(pa[0] - pb[0]) < .01) S.selNode.side = e.key === 'ArrowLeft' ? 'a' : 'b';   // coincident nodes: direction picks the boundary
      const {side} = S.selNode; M.setNode(F, side, i, F.nodes[side][i] + (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 2 : .25)); e.preventDefault(); recompute();
    });
    return true;
  }
  const mark = (sel, key, val) => root.querySelectorAll(sel).forEach(b => b.classList.toggle('on', b.dataset[key] === val));
  function setTool(t) {
    if (S.src === 'photo' && (t === 'vb' || t === 'edit')) { S.src = 'strip'; mark('[data-src]', 'src', 'strip'); fit(); }
    S.tool = t; S.pts = []; S.selNode = null; mark('[data-tool]', 'tool', t); cv.style.cursor = t === 'pan' ? 'grab' : 'crosshair'; draw();
    readout(t === 'cal' ? '기준 눈금자/체커보드의 두 점을 찍고 오른쪽 “교정” 칸에 실제 길이를 넣으세요.' : t === 'edit' ? '노드(■)를 좌우로 드래그해 절삭날 선/마모 경계를 보정합니다. 선택 후 ←/→ 로 0.25 px 미세 이동.' : t === 'vb' ? '마모 경계 위의 점을 찍으면 절삭날 선까지의 수직 거리를 잽니다.' : t === 'dist' ? '두 점을 찍어 거리를 잽니다.' : '드래그로 이동, 휠/핀치로 확대. 돋보기는 측정 도구에서 표시됩니다.');
  }

  // ---------- data ----------
  function update(ctx) {
    const wr = T.wearResult, dbg = T.wearDebug;
    if (!build()) return;
    if (!wr || !dbg || !dbg.strips) { $('#mtGrid').hidden = true; $('#mtEmpty').hidden = false; S.ready = false; return; }
    S.D = wr.diameterMm; S.k = wr.flutes; S.helix = wr.helixDeg; S.engine = ctx && ctx.engine || dbg.engine || ''; S.shots = ctx && ctx.shots || [];
    S.base = wr; S.sides = dbg.sides || []; S.quality = ctx && ctx.quality || [];
    S.inputMode = dbg.inputMode || 'camera'; S.mag = dbg.magnification || null; S.fixedCal = dbg.calib || null; S.zones = dbg.zones || null;   // microscope: js/micro
    S.F = dbg.strips.map((e, i) => e && fluteFor(e, i));
    S.top = endFace(ctx); S.topCv = null;
    S.img = []; S.photo = []; S.enhImg = {}; S.manual = []; S.pts = []; S.selNode = null;
    const firstAssist = S.F.findIndex(F => F && F.assist);
    S.sel = firstAssist >= 0 ? firstAssist : Math.max(0, S.F.findIndex(Boolean));
    $('#mtFlutes').innerHTML = S.F.map((f, i) => `<button data-fl="${i}" ${f ? '' : 'disabled'} style="--c:${COLORS[i % 6]}">F${i + 1}</button>`).join('');
    root.querySelectorAll('[data-fl]').forEach(b => b.onclick = () => select(+b.dataset.fl));
    $('#mtGrid').hidden = false; $('#mtEmpty').hidden = true; S.ready = true;
    $('#mtZlbl').textContent = S.inputMode === 'microscope' ? `z = 절삭날을 따라 거리 (현미경 ${S.mag}x, 영상 사이 간격 포함)` : 'z = 팁에서 축방향 거리';
    sizeCanvas(); select(S.sel); recompute(true); renderManual();
    if (firstAssist >= 0) setTool('edit');   // 보조 측정: 해당 날을 편집 모드로 열어 둠
  }
  // operator-assisted fallback: the auto band is empty (no-band) or the shot failed the quality check (low-quality).
  // no band -> cutting-edge line pre-placed from the helix geometry (metro-core edgeGuess), zero-width band to drag open;
  // band on a failed shot -> auto band kept, but the result stays 'awaiting-operator' until the operator edits/confirms it
  function fluteFor(e, i) {
    const o = opts(), F = M.flute(e.strip, e.band, S.D, o, e.rowVbMm), q = S.quality[i], lowQ = !!q && q.verdict === 'fail';
    if (!F.has.some(Boolean)) return Object.assign(M.assistFlute(e.strip, S.D, o, lowQ ? 'no-band, low-quality' : 'no-band'), {rowVbMm: F.rowVbMm});   // engine rows kept until the operator edits
    if (lowQ) F.assist = {reason: 'low-quality', guess: false, score: 0};
    // tip / corner damage (wear-core: chipping, broken end tooth) is already in VBC/VBmax but needs the operator's eye
    const sd = S.sides[i]; if (!F.assist && sd && sd.reasons && sd.reasons.includes('tip-damage')) F.assist = {reason: 'tip-damage', guess: false, score: 0, tipMm: sd.vbTipMm};
    return F;
  }
  // end face (top photo): worn area per tooth from the wear engine's end-face circle (wearResult.top) and, with the
  // network engine, its end-face class mask (Tool3D.faceSeg 'top'); otherwise the engine's brightness rule (metro-vb)
  function endFace(ctx) {
    const wr = T.wearResult, top = wr && wr.top, shot = ctx && ctx.top, W = T.wear;
    if (!V || !top || !(top.rPx > 0) || !shot || !W || !W.toImage) return null;
    try {
      const img = W.toImage(shot), n = img.width * img.height, d = img.data, g = new Float32Array(n);
      for (let i = 0; i < n; i++) g[i] = .299 * d[4 * i] + .587 * d[4 * i + 1] + .114 * d[4 * i + 2];
      let c = V.classesFromGray({w: img.width, h: img.height, g}, top);
      const f = (T.faceSeg || []).find(x => x && x.face === 'top' && x.mask);
      if (f) c = V.mergeNet(c, f, top);
      return Object.assign(V.endFaceArea(c, S.k), {source: f ? 'network' : 'brightness', img, cls: c.cls});
    } catch (e) { console.warn('end face:', e); return null; }
  }
  function confirmAssist() { const F = S.F[S.sel]; if (!F || !F.assist) return; F.edited = true; recompute(); }
  function select(i) { S.sel = i; S.pts = []; S.selNode = null; mark('[data-fl]', 'fl', String(i)); fit(); renderBudget(); renderAssist(); }
  const RSN = {'tip-damage': '끝날/코너 파손 감지 (VBC로 VBmax에 반영)', 'no-band': '자동 마모 밴드 없음', 'low-quality': '사진 품질 불량(신뢰도 낮음)', 'no-band, low-quality': '자동 마모 밴드 없음 · 사진 품질 불량'};
  function renderAssist() {
    const b = $('#mtAssist'), F = S.F && S.F[S.sel], e = S.ev && S.ev[S.sel]; if (!b) return;
    if (!F || !F.assist) { b.hidden = true; return; }
    b.hidden = false; b.dataset.mode = e ? e.mode : 'awaiting-operator';
    b.innerHTML = e && e.mode === 'operator-assisted'
      ? `<b>F${S.sel + 1} · operator-assisted</b> 작업자 보정 결과 (σ ${e.sigmaPx} px 수동 불확도 적용)`
      : F.assist.reason === 'tip-damage'
      ? `<b>F${S.sel + 1} · Tip / corner damage ${(+F.assist.tipMm || 0).toFixed(2)} mm (VBC)</b> <span>${RSN['tip-damage']}. 사진에서 끝날 파손을 확인하고 필요하면 측면 마모 경계를 보정하세요.</span> <button id="mtAssistOk" title="끝날 파손 값을 작업자가 확인 (operator-assisted)">파손 확인</button>`
      : `<b>F${S.sel + 1} · Drag the wear boundary to measure</b> <span>${RSN[F.assist.reason] || F.assist.reason}. 절삭날 선(청록)은 형상에서 미리 배치됨 — 노란 마모 경계 노드를 끌어 VB를 측정하세요.</span> <button id="mtAssistOk" title="마모가 없음을 작업자가 확인 (VB 0, operator-assisted)">마모 없음 확인</button>`;
    const ok = $('#mtAssistOk'); if (ok) ok.onclick = confirmAssist;
  }
  function calib() {
    const r = S.ref && S.ref.px > 0 ? {px: S.ref.px, mm: +S.prefs.refMm, tolMm: +S.prefs.refTolMm} : null;
    if (S.fixedCal && !r) return S.fixedCal;   // microscope: px/mm of the magnification's calibration, not the diameter
    return M.calibration(S.sides.map(s => s && s.align), S.D, opts(), r);
  }
  // evaluate every flute, refresh the panel and hand the corrected numbers to the 3D view (Tool3D.wearResult)
  function recompute(first) {
    if (!S.ready) return;
    const o = opts(); S.cal = calib();
    S.ev = S.F.map(F => {
      if (!F) return null;
      const e = M.evaluate(F, Object.assign({}, o, {scale: S.cal.scaleFor(F.strip.ppm), uScaleRel: S.cal.uRel}));
      e.status = M.status(e.q.vbMax.v, e.q.vbMax.U, o.limitMm, o.warnFrac);
      if (e.mode === 'awaiting-operator') e.status = Object.assign({}, e.status, {decision: 'indeterminate', light: e.status.light === 'red' ? 'red' : 'amber'});   // 미확인 값으로 적합 판정하지 않음
      return e;
    });
    S.vbx = S.ev.map((e, i) => {
      if (!e || !V) return null;
      const F = S.F[i], top = F.strip.top, ref = V.refLine(e.rows, e.edge, top), prof = V.profileU(e.rows, S.helix), ppmCal = F.strip.ppm / S.cal.scaleFor(F.strip.ppm);
      return {ref, lines: V.vbLines(e.rows, e.edge, top, {n: +S.prefs.nLines || 5, helixDeg: S.helix, ref}), prof, stats: V.stats(prof), pos: V.positions(e), ppmCal, mag: V.magnification(ppmCal, F.strip.w)};
    });
    if (!first) publish();
    renderTable(); renderLights(); drawChart(); renderDims(); renderTop(); renderTol(); renderCal(); renderBudget(); renderHist(); renderAssist(); draw();
    window.dispatchEvent(new CustomEvent('tool3d:metro', {detail: summary()}));
  }
  function publish() {
    const b = S.base, pf = b.perFlute.map((f, i) => { const e = S.ev[i]; return e ? {vbMaxMm: e.vbMaxMm, vbAvgMm: e.vbAvgMm, areaMm2: e.areaMm2, volumeMm3: e.volumeMm3, profile: e.profile} : f; });
    T.wearResult = Object.assign({}, b, {perFlute: pf, metro: {edited: S.ev.some(e => e && e.edited), scale: S.cal.method, modes: S.ev.map(e => e ? e.mode : null)},
      totals: {vbMaxMm: Math.max(0, ...pf.map(f => f.vbMaxMm)), areaMm2: M.r4(pf.reduce((s, f) => s + f.areaMm2, 0)), volumeMm3: M.r4(pf.reduce((s, f) => s + f.volumeMm3, 0))}});
  }
  function worst() { let w = null; S.ev.forEach((e, i) => { if (e && (!w || e.q.vbMax.v > S.ev[w].q.vbMax.v)) w = i; }); return w; }
  function summary() {
    const o = opts(), wi = worst(), e = wi == null ? null : S.ev[wi];
    return {toolId: S.prefs.toolId, operator: S.prefs.operator, D: S.D, k: S.k, helixDeg: S.helix, engine: S.engine, inputMode: S.inputMode || 'camera', magnification: S.mag, limitMm: o.limitMm, warnFrac: o.warnFrac,
      calib: S.cal, flutes: S.ev, worst: wi, overall: e && e.status, vbMax: e && e.q.vbMax, manual: S.manual.map(m => ({kind: m.kind, flute: m.flute + 1, mm: m.mm, U: m.U})),
      vb: (S.vbx || []).map(x => x && {pos: x.pos, lines: x.lines.map(l => ({n: l.n, zMm: l.zMm, uMm: l.uMm, vbUm: l.vbUm, isMax: l.isMax})), stats: x.stats, mag: x.mag.label, umPerPx: x.mag.umPerPx, ref: {angleDeg: x.ref.angleDeg, residualPx: x.ref.residualPx, from: x.ref.from}}),
      endFace: S.top ? {source: S.top.source, k: S.top.k, phaseDeg: S.top.phaseDeg, pxPerMm: S.top.pxPerMm, teeth: S.top.teeth, total: S.top.total} : null, tolerance: tolResult()};
  }

  // ---------- tables ----------
  const at = z => z == null ? '' : `<br><small class="mt-at">@ z ${(+z).toFixed(2)}</small>`;
  function renderTable() {
    const L = opts().limitMm, head = '<tr><th>Flute</th><th>VBmax</th><th>VBB (avg)</th><th>VBC corner</th><th>VBN notch</th><th title="이 날에서 한계 대비">%</th><th></th></tr>';
    const P = i => S.vbx && S.vbx[i] ? S.vbx[i].pos : null;
    $('#mtTable').innerHTML = head + S.ev.map((e, i) => e ? `<tr data-row="${i}" class="${i === S.sel ? 'sel' : ''}">
      <td><b style="color:${COLORS[i % 6]}">F${i + 1}</b>${e.edited ? ' <span class="mt-ed" title="수동 보정됨">✎</span>' : ''}${e.assist ? ` <span class="mt-mode ${e.mode}" title="${RSN[e.assist] || e.assist}">${e.mode}</span>` : ''}</td>
      <td>${pm(e.q.vbMax)}${at(P(i) && P(i).vbMax.zMm)}</td><td>${pm(e.q.vbb)}${P(i) && P(i).vbb.span ? `<br><small class="mt-at">z ${P(i).vbb.span[0].toFixed(2)}–${P(i).vbb.span[1].toFixed(2)}</small>` : ''}</td><td>${pm(e.q.vbc)}${at(P(i) && P(i).vbc.zMm)}</td><td>${pm(e.q.vbn)}${at(P(i) && P(i).vbn.zMm)}</td>
      <td>${Math.round(e.status.usedPct)}</td><td><i class="mt-dot" style="background:${LIGHT[e.status.light]}" title="${e.status.decision}"></i></td></tr>`
      : `<tr><td>F${i + 1}</td><td colspan="6" class="hint">측정 실패 (외곽 미검출)</td></tr>`).join('') +
      `<tr class="mt-foot"><td colspan="7">mm · 값 ± U (k=2, ≈95 %) · @ z = 팁에서 위치 (mm) · 한계 ${f3(L)} mm · 판정: ISO 14253-1 (VB+U &lt; 한계 → 적합)</td></tr>`;
    root.querySelectorAll('[data-row]').forEach(r => r.onclick = () => select(+r.dataset.row));
  }
  function renderLights() {
    const wi = worst(), ov = wi == null ? null : S.ev[wi].status, b = $('#mtOverall');
    b.textContent = ov ? `${LBL[ov.light]} · VBmax ${f3(S.ev[wi].q.vbMax.v)} ± ${f3(S.ev[wi].q.vbMax.U)} mm` : '—';
    b.style.background = ov ? LIGHT[ov.light] : '#889'; b.dataset.light = ov ? ov.light : '';
    $('#mtLights').innerHTML = S.ev.map((e, i) => e ? `<div class="mt-light ${e.status.light}"><i></i><b>F${i + 1}</b><span>${f3(e.q.vbMax.v)}</span><em>${e.status.decision}</em></div>` : '').join('');
  }
  // VB dimension list + statistics of the selected flute (values = rows of the measured VB)
  const f1 = v => (v == null || Number.isNaN(+v)) ? '—' : (+v).toFixed(1), f2 = v => (v == null || Number.isNaN(+v)) ? '—' : (+v).toFixed(2), f4 = v => (+v).toFixed(4);
  function renderDims() {
    const b = $('#mtDimList'), x = S.vbx && S.vbx[S.sel]; if (!b) return;
    if (!x) { b.innerHTML = ''; return; }
    const s = x.stats;
    b.innerHTML = `<div class="mt-h">VB 치수 · F${S.sel + 1} <small>기준선: ${x.ref.from === 'unworn' ? '미마모 구간' : '전 구간'} ${x.ref.fitRows}행 직선 맞춤, 잔차 ${f2(x.ref.residualPx)} px · 기울기 ${f1(x.ref.angleDeg)}°</small></div>
      <table class="mt-tab mt-dims"><tr><th>No.</th><th>z (mm)</th><th>u 날 따라 (mm)</th><th>VB (µm)</th></tr>${x.lines.length ? x.lines.map(l => `<tr${l.isMax ? ' class="mt-max"' : ''}><td>[${l.n}]${l.isMax ? ' max' : ''}</td><td>${l.zMm.toFixed(3)}</td><td>${l.uMm.toFixed(3)}</td><td><b>${f2(l.vbUm)}</b></td></tr>`).join('') : '<tr><td colspan="4" class="hint">마모 밴드 없음</td></tr>'}</table>
      <table class="mt-tab mt-stat"><tr><td>VB 최대 / 평균 / 최소</td><td>${f2(s.maxUm)} / ${f2(s.meanUm)} / ${f2(s.minUm)} µm</td></tr><tr><td>표준편차 σ · 중앙값 (Q1–Q3)</td><td>${f2(s.sdUm)} · ${f2(s.medianUm)} (${f1(s.p25Um)}–${f1(s.p75Um)}) µm</td></tr>
      <tr><td>마모 길이 / 평가 길이 (날 따라)</td><td>${s.wornMm.toFixed(3)} / ${s.lengthMm.toFixed(3)} mm (${f1(s.wornPct)} %)</td></tr><tr><td>배율 (환산) · 분해능</td><td>${x.mag.label} · ${x.mag.umPerPx.toFixed(2)} µm/px · 시야 ${x.mag.fovMm.toFixed(2)} mm</td></tr></table>`;
  }
  // end-face wear area per tooth
  const TCOL = {2: [255, 40, 40], 3: [255, 140, 0], 4: [40, 120, 255]};
  function renderTop() {
    const b = $('#mtTop'), a = S.top; if (!b) return;
    if (!a) { b.innerHTML = `<div class="mt-h">끝면 마모 면적 · End face</div><div class="hint">윗면(끝면) 사진이 없거나 끝면 원을 찾지 못했습니다.</div>`; return; }
    const t = a.total;
    b.innerHTML = `<div class="mt-h">끝면 마모 면적 · End face <small>${a.source === 'network' ? 'AI 분할 (마모/치핑/용착)' : '밝기 기준 (코팅 벗겨짐)'} · ${a.pxPerMm.toFixed(1)} px/mm</small></div>
      <div class="mt-topwrap"><canvas id="mtTopCv"></canvas></div>
      <table class="mt-tab mt-toptab"><tr><th>날</th><th>위치</th><th>끝면 랜드 mm²</th><th>마모 면적 mm²</th><th>마모</th><th>치핑</th><th>용착</th><th>%</th><th title="외곽에서 마모가 들어온 깊이">외곽 깊이 mm</th></tr>
      ${a.teeth.map(T => `<tr${T.tooth === a.maxTooth && T.wornMm2 > 0 ? ' class="mt-max"' : ''}><td><b>T${T.tooth}</b></td><td>${Math.round(T.centreDeg)}°</td><td>${f4(T.landMm2)}</td><td><b>${f4(T.wornMm2)}</b></td><td>${f4(T.flankMm2)}</td><td>${f4(T.chippingMm2)}</td><td>${f4(T.adhesionMm2)}</td><td>${T.wornPct.toFixed(1)}</td><td>${T.rimDepthMm.toFixed(3)}</td></tr>`).join('')}
      <tr class="mt-foot"><td colspan="2"><b>합계</b></td><td>${f4(t.landMm2)}</td><td><b>${f4(t.wornMm2)}</b></td><td>${f4(t.flankMm2)}</td><td>${f4(t.chippingMm2)}</td><td>${f4(t.adhesionMm2)}</td><td>${t.wornPct.toFixed(1)}</td><td></td></tr></table>
      <div class="hint">날 구분: 외곽 링의 날 위치(k차 조화 성분)로 끝면을 ${a.k}등분 · 랜드 = 홈(어두운 부분)을 뺀 끝면</div>`;
    drawTop();
  }
  // end-face image: crop around the end-face circle, worn pixels tinted, tooth sectors, labels, scale bar
  function topCanvas() {
    if (S.topCv) return S.topCv;
    const a = S.top, {img, cls} = a, R = a.rPx, half = 1.12 * R, k = Math.min(1, 560 / (2 * half)), N = Math.round(2 * half * k);
    const c = el('canvas', {width: N, height: N}), x = c.getContext('2d'), im = x.createImageData(N, N), d = img.data;
    for (let Y = 0; Y < N; Y++) for (let X = 0; X < N; X++) {
      const sx = Math.round(a.cx - half + (X + .5) / k), sy = Math.round(a.cy - half + (Y + .5) / k), o = 4 * (Y * N + X);
      im.data[o + 3] = 255; if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      const i = sy * img.width + sx, col = TCOL[cls[i]];
      for (let j = 0; j < 3; j++) im.data[o + j] = col ? .35 * d[4 * i + j] + .65 * col[j] : d[4 * i + j];
    }
    x.putImageData(im, 0, 0); return (S.topCv = {c, k});
  }
  function drawTop() {
    const cvs = $('#mtTopCv'), a = S.top; if (!cvs || !a) return;
    const {c, k} = topCanvas(), dpr = devicePixelRatio || 1, W = Math.min(cvs.clientWidth || 360, 420), H = W, s = W / c.width;
    cvs.width = W * dpr; cvs.height = H * dpr; cvs.style.height = H + 'px'; const x = cvs.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0);
    x.drawImage(c, 0, 0, W, H);
    const C = W / 2, Rr = a.rPx * k * s, sec = 2 * Math.PI / a.k, ph = a.phaseDeg * Math.PI / 180;
    x.strokeStyle = 'rgba(0,208,255,.9)'; x.lineWidth = 1.2; x.beginPath(); x.arc(C, C, Rr, 0, 7); x.stroke();
    x.setLineDash([4, 3]); x.strokeStyle = 'rgba(255,255,255,.75)';
    for (let j = 0; j < a.k; j++) { const t = ph + (j + .5) * sec; x.beginPath(); x.moveTo(C, C); x.lineTo(C + 1.05 * Rr * Math.cos(t), C - 1.05 * Rr * Math.sin(t)); x.stroke(); }
    x.setLineDash([]); x.font = '600 12px system-ui,sans-serif';
    for (const T of a.teeth) {
      const t = T.centreDeg * Math.PI / 180, px = C + .62 * Rr * Math.cos(t), py = C - .62 * Rr * Math.sin(t), lab = `T${T.tooth} ${T.wornMm2.toFixed(3)} mm²`, tw = x.measureText(lab).width;
      x.fillStyle = 'rgba(255,255,255,.92)'; x.fillRect(px - tw / 2 - 3, py - 9, tw + 6, 17); x.strokeStyle = '#000'; x.lineWidth = 1; x.strokeRect(px - tw / 2 - 2.5, py - 8.5, tw + 5, 16); x.fillStyle = '#000'; x.fillText(lab, px - tw / 2, py + 4);
    }
    scaleBarAt(x, a.pxPerMm * k * s, W, H);
  }
  // scale bar (bottom right) and an optional magnification tag (top left), CSS px; ppmScr = screen px per mm
  function scaleBarAt(x, ppmScr, W, H, mag) {
    if (!V) return;
    const bar = V.scaleBar(ppmScr, .22 * W), bx1 = W - 12, bx0 = bx1 - bar.px, by = H - 30;
    x.strokeStyle = '#2a3cff'; x.lineWidth = 2; x.beginPath(); x.moveTo(bx0, by); x.lineTo(bx1, by); x.moveTo(bx0, by - 4); x.lineTo(bx0, by + 4); x.moveTo(bx1, by - 4); x.lineTo(bx1, by + 4); x.stroke();
    x.font = '12px system-ui,sans-serif'; const tw = x.measureText(bar.label).width;
    x.fillStyle = '#fff'; x.fillRect(bx1 - tw - 6, by + 6, tw + 6, 17); x.strokeStyle = '#000'; x.lineWidth = 1; x.strokeRect(bx1 - tw - 5.5, by + 6.5, tw + 5, 16); x.fillStyle = '#000'; x.fillText(bar.label, bx1 - tw - 3, by + 19);
    if (mag) { const mw = x.measureText(mag).width; x.fillStyle = '#fff'; x.fillRect(6, 6, mw + 8, 18); x.strokeStyle = '#000'; x.strokeRect(6.5, 6.5, mw + 7, 17); x.fillStyle = '#000'; x.fillText(mag, 10, 19); }
  }
  // tolerance verdict (VBmax limit from the header; VBB max, VBC and end-face area limits editable)
  function tolResult() {
    if (!V || !S.ev) return null;
    const E = S.ev.filter(Boolean), mx = k => E.length ? Math.max(...E.map(e => e.q[k].v)) : null, p = S.prefs;
    return V.tolerance({vbMaxMm: mx('vbMax'), vbbMaxMm: mx('vbbMax'), vbcMm: mx('vbc'), topWornMm2: S.top ? S.top.total.wornMm2 : null},
      {vbMaxMm: opts().limitMm, vbbMaxMm: +p.tolVbb || .5, vbcMm: +p.tolVbc || .5, topWornMm2: +p.tolTop || .5});
  }
  function renderTol() {
    const b = $('#mtTol'), t = tolResult(); if (!b) return;
    if (!t) { b.innerHTML = ''; return; }
    const key = {vbbMaxMm: 'tolVbb', vbcMm: 'tolVbc', topWornMm2: 'tolTop'}, fv = (v, u) => v == null ? '—' : u === 'mm²' ? f4(v) : f3(v);
    b.innerHTML = `<div class="mt-h">공차 판정 · Tolerance <b id="mtVerdict" class="mt-verdict ${t.pass == null ? '' : t.pass ? 'ok' : 'ng'}">${t.pass == null ? '—' : t.pass ? 'PASS' : 'FAIL'}</b></div>
      <table class="mt-tab"><tr><th>항목</th><th>측정값</th><th>한계</th><th>판정</th></tr>${t.rows.map(r => `<tr><td>${r.label}</td><td>${fv(r.value, r.unit)} ${r.unit}</td>
      <td>${key[r.key] ? `<input data-tolk="${key[r.key]}" type="number" step="0.01" min="0" value="${r.limit}">` : `${f3(r.limit)} <small>(한계 VB)</small>`}</td>
      <td>${r.pass == null ? '<span class="hint">—</span>' : r.pass ? '<b class="mt-ok">PASS</b>' : '<b class="mt-ng">FAIL</b>'}</td></tr>`).join('')}</table>`;
    b.querySelectorAll('[data-tolk]').forEach(inp => inp.onchange = e => { S.prefs[e.target.dataset.tolk] = +e.target.value; savePrefs(); renderTol(); });
  }
  function renderCal() {
    const c = S.cal, P = c.parts, pct = v => (100 * v).toFixed(2) + ' %';
    const d = c.method === 'diameter' ? c : c.diameter;
    $('#mtCal').innerHTML = `<div class="mt-h">교정 · Scale</div>
      <div class="mt-kv"><span>배율</span><b>${c.pxPerMm.toFixed(2)} ± ${c.U_pxPerMm.toFixed(2)} px/mm</b><span>방식</span><b>${c.method === 'diameter' ? `공구경 Ø${S.D} (±${S.prefs.diaTolMm} mm)` : c.method === 'microscope' ? `현미경 ${c.magnification}x 교정 (${c.source === 'um/px' ? 'µm/px 입력' : '스테이지 마이크로미터'})` : '기준 타깃 (눈금자/체커보드)'}</b>
      <span>U<sub>rel</sub> (k=2)</span><b>${pct(2 * c.uRel)}</b><span>구성</span><b>${Object.entries(P).map(([k, v]) => `${k} ${pct(v)}`).join(' · ')}</b>
      ${c.method === 'reference' ? `<span>공구경 대비</span><b>${c.deviationPct > 0 ? '+' : ''}${c.deviationPct.toFixed(2)} % (Ø 배율 ${d.pxPerMm.toFixed(2)})</b>` : ''}</div>
      <div class="mt-row"><label>공구경 공차 ±<input id="mtDtol" type="number" step="0.001" min="0" value="${S.prefs.diaTolMm}"> mm</label></div>
      <div class="mt-row"><label>기준 길이 <input id="mtRefMm" type="number" step="0.01" min="0.01" value="${S.prefs.refMm}"> mm</label><label>공차 ±<input id="mtRefTol" type="number" step="0.001" min="0" value="${S.prefs.refTolMm}"></label>
      <span class="hint">${S.ref ? `선택 ${S.ref.px.toFixed(1)} px` : '⌖ Cal 도구로 두 점 선택'}</span>${S.ref ? '<button id="mtRefClr" class="mt-ghost">기준 해제</button>' : ''}</div>`;
    const num = (id, key) => $('#' + id).onchange = e => { S.prefs[key] = +e.target.value; savePrefs(); recompute(); };
    num('mtDtol', 'diaTolMm'); num('mtRefMm', 'refMm'); num('mtRefTol', 'refTolMm');
    if ($('#mtRefClr')) $('#mtRefClr').onclick = () => { S.ref = null; recompute(); };
  }
  function renderBudget() {
    const e = S.ev && S.ev[S.sel]; if (!e) { $('#mtBudget').innerHTML = ''; return; }
    const rows = [['VBmax', e.q.vbMax], ['VBB', e.q.vbb], ['VBC', e.q.vbc], ['VBN', e.q.vbn]];
    $('#mtBudget').innerHTML = `<div class="mt-h">불확도 · Uncertainty budget F${S.sel + 1} <small>표준불확도 u (mm), U = 2·u<sub>c</sub></small></div>
      <table class="mt-tab mt-bud"><tr><th></th><th>scale</th><th>edge</th><th>repeat.</th><th>helix</th><th>U (k=2)</th></tr>
      ${rows.map(([n, q]) => `<tr><td>${n}</td><td>${f3(q.parts.scale)}</td><td>${f3(q.parts.edge)}</td><td>${f3(q.parts.rep)}</td><td>${f3(q.parts.helix)}</td><td><b>${f3(q.U)}</b></td></tr>`).join('')}</table>
      <div class="hint">edge: √2·σ/(px/mm), σ = ${e.sigmaPx} px (${e.edited ? '수동 보정' : '자동 검출'}) · repeat.: VBmax 주변 7행 산포 / 평균의 표준오차 · helix ±${M.DEFAULTS.helixUDeg}°</div>`;
  }
  function renderHist() {
    const id = S.prefs.toolId, list = M.history(store, id), L = opts().limitMm, tr = V ? V.trend(list, L) : M.trend(list);
    $('#mtHist').innerHTML = `<div class="mt-h">이력 · 공구 수명 추세 <small>${id || '—'} · ${list.length}건${tr ? ` · 추세 ${tr.slope > 0 ? '+' : ''}${(tr.slope * 1000).toFixed(1)} µm/${tr.per === 'min' ? 'min' : '회'}${tr.remaining != null ? ` · 한계까지 약 ${tr.remaining.toFixed(1)}${tr.per === 'min' ? ' min' : '회'}` : ''}` : list.length ? ' · 추세: 2건 이상 필요' : ''}</small></div>
      ${list.length ? `<canvas id="mtSpark" height="60"></canvas><table class="mt-tab"><tr><th>날짜</th><th>측정자</th><th>VBmax ± U</th><th></th></tr>${list.slice(-6).reverse().map(h =>
        `<tr><td>${h.date}</td><td>${h.op || ''}</td><td>${f3(h.vbMax)} ± ${f3(h.U)}</td><td><i class="mt-dot" style="background:${LIGHT[h.light] || '#889'}"></i></td></tr>`).join('')}</table>` : '<div class="hint">저장된 측정이 없습니다. “이력 저장”으로 추가합니다.</div>'}`;
    const sp = $('#mtSpark'); if (!sp) return;
    const w = sp.width = sp.clientWidth || 300, h = 60, x = sp.getContext('2d'), mx = Math.max(L * 1.2, ...list.map(e => e.vbMax + (e.U || 0)));
    const X = i => 8 + i * (w - 16) / Math.max(1, list.length - 1), Y = v => h - 6 - v / mx * (h - 12);
    x.strokeStyle = LIGHT.red; x.setLineDash([4, 3]); x.beginPath(); x.moveTo(0, Y(L)); x.lineTo(w, Y(L)); x.stroke(); x.setLineDash([]);
    x.strokeStyle = '#345'; x.beginPath(); list.forEach((e, i) => i ? x.lineTo(X(i), Y(e.vbMax)) : x.moveTo(X(i), Y(e.vbMax))); x.stroke();
    list.forEach((e, i) => { x.fillStyle = LIGHT[e.light] || '#345'; x.beginPath(); x.arc(X(i), Y(e.vbMax), 3, 0, 7); x.fill(); });
    if (tr && tr.per !== 'min' && list.length > 1) { x.strokeStyle = '#1f5fbf'; x.setLineDash([3, 3]); x.beginPath(); x.moveTo(X(0), Y(tr.intercept + tr.slope)); x.lineTo(X(list.length - 1), Y(tr.intercept + tr.slope * list.length)); x.stroke(); x.setLineDash([]); }
  }
  function saveHistory() {
    if (!S.ready) return; const s = summary(); if (!s.vbMax) return;
    const now = new Date(), pad = n => String(n).padStart(2, '0');
    M.historyAdd(store, S.prefs.toolId || 'unnamed', {t: now.getTime(), date: `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`,
      op: S.prefs.operator, D: S.D, k: S.k, vbMax: s.vbMax.v, U: s.vbMax.U, light: s.overall.light, decision: s.overall.decision, limit: s.limitMm,
      perFlute: S.ev.map(e => e && {vbMax: e.q.vbMax.v, U: e.q.vbMax.U, vbb: e.q.vbb.v, vbc: e.q.vbc.v, vbn: e.q.vbn.v, edited: e.edited, mode: e.mode})});
    renderHist();
  }

  // ---------- VB(z) chart (shared layout with the report) ----------
  function chartModel(w, h) {
    const o = opts(), E = S.ev.filter(Boolean); if (!E.length) return null;
    const zMax = Math.max(...E.map(e => e.zones.zoneMm)), vMax = Math.max(o.limitMm * 1.25, ...E.map(e => e.vbMaxMm * 1.1 + e.q.vbMax.U)) || .4;
    const pad = {l: 40, r: 8, t: 8, b: 24}, X = z => pad.l + z / zMax * (w - pad.l - pad.r), Y = v => h - pad.b - v / vMax * (h - pad.t - pad.b);
    const z0 = E[0].zones, lines = S.ev.map((e, i) => e && {i, color: COLORS[i % 6], pts: e.profile.map(p => [X(p.zMm), Y(p.vbMm)]),
      band: e.profile.map(p => { const u = Math.hypot(e.q.vbMax.parts.edge, p.vbMm * (S.cal.uRel || 0)); return [X(p.zMm), Y(p.vbMm + 2 * u), Y(Math.max(0, p.vbMm - 2 * u))]; })}).filter(Boolean);
    const step = vMax > .6 ? .2 : .1, yt = []; for (let v = 0; v <= vMax + 1e-9; v += step) yt.push(v);
    const zs = zMax > 6 ? 2 : 1, xt = []; for (let z = 0; z <= zMax + 1e-9; z += zs) xt.push(z);
    return {w, h, pad, X, Y, zMax, vMax, lines, limit: o.limitMm, warn: o.limitMm * o.warnFrac, yt, xt,
      zoneC: [X(0), X(Math.min(zMax, z0.cornerMm))], zoneN: [X(Math.max(0, z0.apMm - z0.notchHalfMm)), X(Math.min(zMax, z0.apMm + z0.notchHalfMm))]};
  }
  function drawChart() {
    if (!chart || !S.ready) return;
    const dpr = devicePixelRatio || 1, w = chart.clientWidth || 360, h = 200; chart.width = w * dpr; chart.height = h * dpr; chart.style.height = h + 'px';
    const m = chartModel(w, h), x = chart.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, w, h); if (!m) return;
    x.font = '10px system-ui,sans-serif'; x.fillStyle = 'rgba(80,120,200,.09)'; x.fillRect(m.zoneC[0], m.pad.t, m.zoneC[1] - m.zoneC[0], h - m.pad.t - m.pad.b);
    x.fillStyle = 'rgba(200,120,40,.10)'; if (m.zoneN[1] > m.zoneN[0]) x.fillRect(m.zoneN[0], m.pad.t, m.zoneN[1] - m.zoneN[0], h - m.pad.t - m.pad.b);
    x.fillStyle = '#667'; x.fillText('C', m.zoneC[0] + 3, m.pad.t + 10); x.fillText('N', m.zoneN[0] + 3, m.pad.t + 10); x.fillText('B', (m.zoneC[1] + m.zoneN[0]) / 2, m.pad.t + 10);
    x.strokeStyle = '#dde1e6'; x.lineWidth = 1; x.textAlign = 'right';
    for (const v of m.yt) { x.beginPath(); x.moveTo(m.pad.l, m.Y(v)); x.lineTo(w - m.pad.r, m.Y(v)); x.stroke(); x.fillText(v.toFixed(1), m.pad.l - 4, m.Y(v) + 3); }
    x.textAlign = 'center'; for (const z of m.xt) x.fillText(z.toFixed(0), m.X(z), h - m.pad.b + 12);
    x.fillText('z (mm)', w - 24, h - 2); x.save(); x.translate(10, h / 2); x.rotate(-Math.PI / 2); x.fillText('VB (mm)', 0, 0); x.restore();
    const hl = (v, c, d) => { x.strokeStyle = c; x.setLineDash(d); x.lineWidth = 1.2; x.beginPath(); x.moveTo(m.pad.l, m.Y(v)); x.lineTo(w - m.pad.r, m.Y(v)); x.stroke(); x.setLineDash([]); };
    hl(m.limit, LIGHT.red, [6, 4]); hl(m.warn, LIGHT.amber, [2, 3]);
    for (const L of m.lines) {
      if (L.i === S.sel && L.band.length > 1) { x.fillStyle = L.color + '26'; x.beginPath(); L.band.forEach(p => x.lineTo(p[0], p[1])); L.band.slice().reverse().forEach(p => x.lineTo(p[0], p[2])); x.fill(); }
      x.strokeStyle = L.color; x.lineWidth = L.i === S.sel ? 2.2 : 1.2; x.beginPath(); L.pts.forEach((p, j) => j ? x.lineTo(p[0], p[1]) : x.moveTo(p[0], p[1])); x.stroke();
    }
  }

  // ---------- workspace canvas ----------
  function sizeCanvas() { const dpr = devicePixelRatio || 1, w = cv.clientWidth || 400, h = cv.clientHeight || 480; cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); S.dpr = dpr; }
  function stripImage(i) {
    if (S.img[i]) return S.img[i];
    const {w, h, g, rgb} = S.F[i].strip, c = el('canvas', {width: w, height: h}), x = c.getContext('2d'), im = x.createImageData(w, h);
    for (let p = 0; p < w * h; p++) { const nan = Number.isNaN(g[p]); for (let k = 0; k < 3; k++) im.data[4 * p + k] = nan ? 30 : rgb ? rgb[3 * p + k] : g[p]; im.data[4 * p + 3] = 255; }
    x.putImageData(im, 0, 0); return (S.img[i] = c);
  }
  function photoImage(i) {   // photo at the analysis resolution (wear.js downscales to MAXPX), so px/mm matches
    if (S.photo[i] !== undefined) return S.photo[i];
    const s = S.shots[i]; if (!s) return (S.photo[i] = null);
    const w0 = s.naturalWidth || s.width, h0 = s.naturalHeight || s.height, k = Math.min(1, MAXPX / Math.max(w0, h0));
    const c = el('canvas', {width: Math.round(w0 * k), height: Math.round(h0 * k)}); c.getContext('2d').drawImage(s, 0, 0, c.width, c.height); return (S.photo[i] = c);
  }
  const baseImg = () => S.src === 'photo' ? photoImage(S.sel) || stripImage(S.sel) : stripImage(S.sel);
  function enhImage(c) {   // Tool3D.enhance on the displayed image; same pixel grid, so overlays and px/mm are unchanged
    const E = T.enhance; if (!E || !E.enhance || !c) return c;
    const key = (c === S.photo[S.sel] ? 'p' : 's') + S.sel; if (S.enhImg[key]) return S.enhImg[key];
    const x = c.getContext('2d', {willReadFrequently: true}), r = E.enhance(x.getImageData(0, 0, c.width, c.height)), o = el('canvas', {width: c.width, height: c.height}), ox = o.getContext('2d'), im = ox.createImageData(c.width, c.height);
    im.data.set(r.data); ox.putImageData(im, 0, 0); o.enhanceInfo = r.info; return (S.enhImg[key] = o);
  }
  const srcImg = () => S.enh ? enhImage(baseImg()) : baseImg();
  const ppmNow = () => S.F[S.sel].strip.ppm, scaleNow = () => S.cal ? S.cal.scaleFor(ppmNow()) : 1;
  function fit() {
    if (!S.ready || !S.F[S.sel]) return;
    const W = cv.width / S.dpr, H = cv.height / S.dpr, im = srcImg();
    let x0 = 0, y0 = 0, w = im.width, h = im.height;
    if (S.src === 'strip') { const F = S.F[S.sel]; y0 = Math.max(0, F.strip.top - 10); h = Math.min(im.height, F.strip.top + F.n + 20) - y0; }
    const s = Math.min(W / w, H / h) * .96; S.view = {s, ox: x0 + w / 2 - W / 2 / s, oy: y0 + h / 2 - H / 2 / s}; draw();
  }
  function zoomAt(k, sx, sy) {
    const W = cv.width / S.dpr, H = cv.height / S.dpr; if (sx == null) { sx = W / 2; sy = H / 2; }
    const v = S.view, ix = v.ox + sx / v.s, iy = v.oy + sy / v.s; v.s = Math.max(.05, Math.min(60, v.s * k)); v.ox = ix - sx / v.s; v.oy = iy - sy / v.s; draw();
  }
  const toImg = (sx, sy) => [S.view.ox + sx / S.view.s, S.view.oy + sy / S.view.s];
  const toScr = (ix, iy) => [(ix - S.view.ox) * S.view.s, (iy - S.view.oy) * S.view.s];
  function nodePos(F, side, i) { const r = F.nodeRows[i], rr = Math.round(r), [A, B] = M.bounds(F, rr); return [side === 'a' ? A - .5 : B + .5, F.strip.top + r + .5]; }

  function draw() {
    if (!S.ready || !cx) return;
    const F = S.F[S.sel], e = S.ev && S.ev[S.sel], v = S.view, dpr = S.dpr, W = cv.width, H = cv.height;
    cx.setTransform(1, 0, 0, 1, 0, 0); cx.fillStyle = '#15181d'; cx.fillRect(0, 0, W, H); if (!F) return;
    cx.setTransform(v.s * dpr, 0, 0, v.s * dpr, -v.ox * v.s * dpr, -v.oy * v.s * dpr); cx.imageSmoothingEnabled = v.s < 3;
    cx.drawImage(srcImg(), 0, 0);
    const lw = 1 / v.s;
    if (S.src === 'strip' && e) {
      const top = F.strip.top, {A, B, vb} = e.rows;
      cx.fillStyle = 'rgba(255,40,40,.38)'; for (let r = 0; r < F.n; r++) if (vb[r] > 0) cx.fillRect(A[r] - .5, top + r, B[r] - A[r] + 1, 1);
      const line = (side, color) => { cx.strokeStyle = color; cx.lineWidth = 1.6 * lw; cx.beginPath(); for (let r = 0; r < F.n; r++) { const x = side === 'a' ? A[r] - .5 : B[r] + .5; r ? cx.lineTo(x, top + r + .5) : cx.moveTo(x, top + r + .5); } cx.stroke(); };
      line(F.edge === 'a' ? 'b' : 'a', '#ffd400'); line(F.edge, '#00d0ff');   // edge on top: visible where the band is zero-width (assisted)
      // ISO zones: C from the tip, notch window around ap
      const z = e.zones, ppm = F.strip.ppm / scaleNow(), yz = mm => top + mm * ppm, xl = F.strip.cx - F.strip.R, xr = F.strip.cx + F.strip.R;
      cx.setLineDash([6 * lw, 4 * lw]); cx.lineWidth = lw; cx.font = `${11 * lw}px system-ui`;
      for (const [mm, lab, c] of [[z.cornerMm, 'C', '#7aa7ff'], [z.apMm - z.notchHalfMm, 'N', '#ffb266'], [z.apMm + z.notchHalfMm, '', '#ffb266'], [z.apMm, 'ap', '#ffb266']]) {
        if (mm <= 0 || mm > z.zoneMm) continue; cx.strokeStyle = c; cx.beginPath(); cx.moveTo(xl, yz(mm)); cx.lineTo(xr, yz(mm)); cx.stroke(); if (lab) { cx.fillStyle = c; cx.fillText(lab, xr + 3 * lw, yz(mm) + 4 * lw); }
      }
      cx.setLineDash([]);
      const X = S.vbx && S.vbx[S.sel];
      if (S.dims && X) dimsOverlay(X, F, lw);
      else if (e.zAtMaxMm != null) { const r = Math.round(e.zAtMaxMm * ppm - .5), y = top + r + .5; cx.strokeStyle = '#ff3b30'; cx.lineWidth = 2 * lw; cx.beginPath(); cx.moveTo(A[r] - .5, y); cx.lineTo(B[r] + .5, y); cx.stroke(); cx.fillStyle = '#ff3b30'; cx.fillText('VBmax', B[r] + 4 * lw, y - 3 * lw); }
      if (S.tool === 'edit') for (const side of ['a', 'b']) for (let i = 0; i < F.nodeRows.length; i++) {
        const [x, y] = nodePos(F, side, i), s = 5 * lw, on = S.selNode && S.selNode.side === side && S.selNode.i === i;
        cx.fillStyle = on ? '#fff' : side === F.edge ? '#00d0ff' : '#ffd400'; cx.strokeStyle = '#000'; cx.lineWidth = lw; cx.fillRect(x - s, y - s, 2 * s, 2 * s); cx.strokeRect(x - s, y - s, 2 * s, 2 * s);
      }
    }
    // manual measurements of this flute / source
    cx.font = `${12 * lw}px system-ui`; cx.lineWidth = 1.5 * lw;
    for (const m of S.manual) if (m.flute === S.sel && m.src === S.src) {
      cx.strokeStyle = m.kind === 'caliper' ? '#7CFC00' : '#ff5cf4'; cx.beginPath(); cx.moveTo(...m.p[0]); cx.lineTo(...m.p[1]); cx.stroke();
      for (const p of m.p) { cx.beginPath(); cx.arc(p[0], p[1], 3 * lw, 0, 7); cx.stroke(); }
      cx.fillStyle = cx.strokeStyle; cx.fillText(`${m.mm.toFixed(3)} ± ${m.U.toFixed(3)}`, m.p[1][0] + 6 * lw, m.p[1][1] - 6 * lw);
    }
    if (S.pts.length) { cx.fillStyle = '#ff5cf4'; for (const p of S.pts) { cx.beginPath(); cx.arc(p[0], p[1], 3 * lw, 0, 7); cx.fill(); } if (S.hover) { cx.strokeStyle = '#ff5cf4'; cx.setLineDash([4 * lw, 3 * lw]); cx.beginPath(); cx.moveTo(...S.pts[0]); cx.lineTo(...S.hover); cx.stroke(); cx.setLineDash([]); } }
    if (S.ref && S.ref.src === S.src && S.ref.flute === S.sel) { cx.strokeStyle = '#00ffa0'; cx.lineWidth = 2 * lw; cx.beginPath(); cx.moveTo(...S.ref.p[0]); cx.lineTo(...S.ref.p[1]); cx.stroke(); }
    if (S.dims && S.src === 'strip' && S.vbx && S.vbx[S.sel]) {
      const X = S.vbx[S.sel]; cx.setTransform(dpr, 0, 0, dpr, 0, 0);
      scaleBarAt(cx, X.ppmCal * v.s, W / dpr, H / dpr, `배율 ${V.magnification(X.ppmCal, W / dpr / v.s).label} · F${S.sel + 1}${S.inputMode === 'microscope' && S.mag ? ` · 현미경 ${S.mag}x` : ''}`);
    }
    drawLoupe();
  }
  // microscope-style annotation: dashed reference line on the unworn edge, VB dimension lines (edge -> wear front) with
  // arrowheads, extension tick to the reference line and a boxed [n] value label; the maximum in bright red
  function dimsOverlay(X, F, lw) {
    const L = X.ref, y0 = L.y0 - 6, y1 = L.y1 + 6;
    cx.save(); cx.setLineDash([7 * lw, 4 * lw]); cx.strokeStyle = 'rgba(255,255,255,.95)'; cx.lineWidth = 1.4 * lw;
    cx.beginPath(); cx.moveTo(L.x(y0), y0); cx.lineTo(L.x(y1), y1); cx.stroke(); cx.setLineDash([]);
    cx.font = `600 ${11 * lw}px system-ui,sans-serif`; cx.fillStyle = '#fff'; cx.fillText('기준선', L.x(y0) + 4 * lw, y0 + 10 * lw);
    const hd = 6 * lw, arrow = (ax, bx, y) => {
      cx.beginPath(); cx.moveTo(ax, y); cx.lineTo(bx, y); cx.stroke();
      for (const [p, d] of [[ax, Math.sign(ax - bx) || 1], [bx, Math.sign(bx - ax) || -1]]) { cx.beginPath(); cx.moveTo(p, y); cx.lineTo(p - d * hd, y - .45 * hd); cx.lineTo(p - d * hd, y + .45 * hd); cx.closePath(); cx.fill(); }
    };
    let lastY = -1e9;
    for (const l of X.lines) {
      const out = l.xFront > l.xEdge ? 1 : -1, grow = Math.max(0, 14 * lw - Math.abs(l.xFront - l.xEdge)) / 2;   // tiny lands: arrows stay readable
      cx.strokeStyle = cx.fillStyle = l.isMax ? '#ff1f1f' : '#ff5a5a'; cx.lineWidth = (l.isMax ? 2.2 : 1.6) * lw;
      arrow(l.xEdge - out * grow, l.xFront + out * grow, l.y);
      cx.lineWidth = lw; cx.setLineDash([2 * lw, 2 * lw]); cx.beginPath(); cx.moveTo(l.xRef, l.y - 4 * lw); cx.lineTo(l.xRef, l.y + 4 * lw); cx.moveTo(l.xEdge, l.y); cx.lineTo(l.xRef, l.y); cx.stroke(); cx.setLineDash([]);
      const t = `[${l.n}] ${l.vbUm.toFixed(1)} µm`, tw = cx.measureText(t).width, ly = Math.max(lastY + 16 * lw, l.y - 7 * lw), lx = out > 0 ? l.xFront + grow + 8 * lw : l.xFront - grow - tw - 14 * lw; lastY = ly;
      cx.strokeStyle = l.isMax ? '#ff1f1f' : '#ff5a5a'; cx.beginPath(); cx.moveTo(l.xFront + out * grow, l.y); cx.lineTo(out > 0 ? lx : lx + tw + 6 * lw, ly + 7 * lw); cx.stroke();
      cx.fillStyle = 'rgba(255,255,255,.94)'; cx.fillRect(lx, ly - 1 * lw, tw + 6 * lw, 15 * lw); cx.strokeStyle = l.isMax ? '#ff1f1f' : '#000'; cx.strokeRect(lx, ly - 1 * lw, tw + 6 * lw, 15 * lw);
      cx.fillStyle = l.isMax ? '#c00000' : '#000'; cx.fillText(t, lx + 3 * lw, ly + 10 * lw);
    }
    cx.restore();
  }
  function drawLoupe() {
    const on = S.hoverScr && S.tool !== 'pan'; loupe.hidden = !on; if (!on) return;
    const [sx, sy] = S.hoverScr, d = S.dpr, z = 4, L = 160, src = L / z;
    lx.imageSmoothingEnabled = false; lx.fillStyle = '#000'; lx.fillRect(0, 0, L, L);
    lx.drawImage(cv, sx * d - src * d / 2, sy * d - src * d / 2, src * d, src * d, 0, 0, L, L);
    lx.strokeStyle = 'rgba(255,255,255,.8)'; lx.lineWidth = 1; lx.beginPath(); lx.moveTo(L / 2, 0); lx.lineTo(L / 2, L); lx.moveTo(0, L / 2); lx.lineTo(L, L / 2); lx.stroke();
    const W = cv.clientWidth; loupe.style.left = (sx + 24 + L > W ? sx - 24 - L : sx + 24) + 'px'; loupe.style.top = Math.max(0, sy - L - 24) + 'px';
  }
  function readout(t) { const r = $('#mtReadout'); if (r) r.innerHTML = t; }
  function renderManual() {
    $('#mtManual').innerHTML = S.manual.map((m, j) => `<tr><td>${m.kind === 'caliper' ? '⊥ VB' : '↔ 2-pt'}</td><td>F${m.flute + 1}${m.src === 'photo' ? ' photo' : ''}</td><td>${m.mm.toFixed(3)} ± ${m.U.toFixed(3)} mm${m.extra ? ` <small>${m.extra}</small>` : ''}</td><td><button data-del="${j}" class="mt-ghost">×</button></td></tr>`).join('');
    root.querySelectorAll('[data-del]').forEach(b => b.onclick = () => { S.manual.splice(+b.dataset.del, 1); renderManual(); draw(); });
  }
  function click(ip) {
    const F = S.F[S.sel], ppm = ppmNow(), f = scaleNow(), uRel = S.cal.uRel;
    if (S.tool === 'vb') {
      const c = M.caliper(F, ip, {helixDeg: S.helix, scale: f}), U = M.manualU(c.vbMm, ppm / f, uRel);
      S.manual.push({kind: 'caliper', flute: S.sel, src: 'strip', p: [c.foot, ip], mm: c.vbMm, U, extra: `⊥ ${c.perpMm.toFixed(3)} · z ${c.zMm.toFixed(2)}`});
      readout(`<b>VB caliper</b> F${S.sel + 1} @ z = ${c.zMm.toFixed(2)} mm: VB = <b>${c.vbMm.toFixed(3)} ± ${U.toFixed(3)} mm</b> (k=2) · 화면 수직거리 ${c.perpMm.toFixed(3)} mm`);
      renderManual(); draw(); return;
    }
    S.pts.push(ip); if (S.pts.length < 2) { draw(); return; }
    const [p, q] = S.pts; S.pts = [];
    if (S.tool === 'cal') { S.ref = {p: [p, q], px: Math.hypot(q[0] - p[0], q[1] - p[1]), src: S.src, flute: S.sel}; recompute(); readout(`<b>기준 교정</b>: ${S.ref.px.toFixed(1)} px = ${S.prefs.refMm} mm → ${S.cal.pxPerMm.toFixed(2)} ± ${S.cal.U_pxPerMm.toFixed(2)} px/mm`); return; }
    const mm = M.dist(p, q, ppm, f), U = M.manualU(mm, ppm / f, uRel);
    S.manual.push({kind: 'distance', flute: S.sel, src: S.src, p: [p, q], mm, U}); renderManual();
    readout(`<b>2-point</b>: <b>${mm.toFixed(3)} ± ${U.toFixed(3)} mm</b> (k=2) · Δ ${Math.hypot(q[0] - p[0], q[1] - p[1]).toFixed(1)} px @ ${(ppm / f).toFixed(2)} px/mm`); draw();
  }
  function hitNode(sx, sy, touch) {
    const F = S.F[S.sel], R = touch ? 22 : 12; let best = null;
    for (const side of ['a', 'b']) for (let i = 0; i < F.nodeRows.length; i++) { const [x, y] = toScr(...nodePos(F, side, i)), d = Math.hypot(x - sx, y - sy); if (d < R && (!best || d < best.d)) best = {side, i, d}; }
    // unworn rows: edge and wear-front nodes coincide -> let the drag direction pick (left = a, right = b)
    if (best) { const o = best.side === 'a' ? 'b' : 'a', [x, y] = toScr(...nodePos(F, o, best.i)); best.tie = Math.hypot(x - sx, y - sy) - best.d < 1; }
    return best;
  }
  function pointer() {
    const P = new Map(); let pinch = null;
    const loc = e => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
    cv.addEventListener('pointerdown', e => {
      if (!S.ready) return; cv.setPointerCapture(e.pointerId); const s = loc(e); P.set(e.pointerId, s);
      if (P.size === 2) { const [a, b] = [...P.values()]; pinch = {d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: S.view.s, c: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]}; S.drag = null; return; }
      if (S.tool === 'edit' && S.src === 'strip') {
        const h = hitNode(s[0], s[1], e.pointerType === 'touch');
        if (h) { const F = S.F[S.sel]; S.selNode = {side: h.side, i: h.i}; S.drag = {node: h, x0: toImg(...s)[0], d0: F.nodes[h.side][h.i]}; draw(); return; }
      }
      S.drag = {pan: true, s0: s, v0: Object.assign({}, S.view), moved: 0};
    });
    cv.addEventListener('pointermove', e => {
      if (!S.ready) return; const s = loc(e);
      if (P.has(e.pointerId)) P.set(e.pointerId, s);
      if (pinch && P.size === 2) { const [a, b] = [...P.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]); S.view.s = pinch.s; zoomAt(d / pinch.d, pinch.c[0], pinch.c[1]); return; }
      S.hoverScr = e.pointerType === 'touch' ? [s[0], s[1] - 40] : s; S.hover = toImg(...s);
      const [ix, iy] = S.hover, F = S.F[S.sel];
      if (S.drag && S.drag.node && S.drag.node.tie) { if (Math.abs(ix - S.drag.x0) < .05) { draw(); return; } const nd = S.drag.node; nd.side = ix > S.drag.x0 ? 'b' : 'a'; nd.tie = false; S.drag.d0 = F.nodes[nd.side][nd.i]; S.selNode = {side: nd.side, i: nd.i}; }
      if (S.drag && S.drag.node) { M.setNode(F, S.drag.node.side, S.drag.node.i, S.drag.d0 + ix - S.drag.x0); recompute(); return; }
      if (S.drag && S.drag.pan) { const dx = s[0] - S.drag.s0[0], dy = s[1] - S.drag.s0[1]; S.drag.moved = Math.max(S.drag.moved, Math.hypot(dx, dy)); if (S.tool === 'pan' || S.drag.moved > 6) { S.view.ox = S.drag.v0.ox - dx / S.view.s; S.view.oy = S.drag.v0.oy - dy / S.view.s; } }
      if (S.src === 'strip' && F) { const z = (iy - F.strip.top) / F.strip.ppm * scaleNow(); if (!S.drag) readoutHover(z, ix); }
      draw();
    });
    const up = e => {
      if (!P.has(e.pointerId)) return; P.delete(e.pointerId);
      if (pinch) { if (P.size < 2) pinch = null; return; }
      const d = S.drag; S.drag = null;
      if (d && d.pan && d.moved <= 6 && S.tool !== 'pan' && S.tool !== 'edit') click(toImg(...loc(e)));
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('pointerleave', () => { S.hoverScr = null; S.hover = null; draw(); });
    cv.addEventListener('wheel', e => { if (!S.ready) return; e.preventDefault(); const s = loc(e); zoomAt(e.deltaY < 0 ? 1.25 : 1 / 1.25, s[0], s[1]); }, {passive: false});
  }
  function readoutHover(z, ix) {
    const e = S.ev[S.sel]; if (!e || S.pts.length) return;
    const r = Math.round(z / e.rows.dz - .5); if (r < 0 || r >= e.rows.vb.length) return;
    readout(`z = ${z.toFixed(2)} mm · VB(z) = ${e.rows.vb[r].toFixed(3)} mm · x = ${((ix - S.F[S.sel].strip.cx) / S.F[S.sel].strip.ppm * scaleNow()).toFixed(3)} mm from axis`);
  }

  build();

  // ---------- API ----------
  T.metro = {
    update, recompute, summary, chartModel, COLORS, LIGHT, LBL,
    get state() { return S; },
    select, setTool, fit, confirmAssist,
    stripImage, topCanvas: () => S.top ? topCanvas().c : null, // for the report
    // test hooks: image px of the active view -> viewport client coords
    imgToClient(ix, iy) { const r = cv.getBoundingClientRect(), [x, y] = toScr(ix, iy); return [r.left + x, r.top + y]; },
    nodeClient(side, i) { return this.imgToClient(...nodePos(S.F[S.sel], side, i)); },
    edgePoint(r) { const F = S.F[S.sel]; return [M.edgeX(F, r), F.strip.top + r + .5]; }
  };
})();
