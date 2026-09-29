/* Tool3D metrology panel: VB table per flute (ISO 8688-2), VB(z) chart, measurement workspace on the calibrated
 * (rectified) image with loupe, zoom/pan, 2-point distance, VB caliper, drag-to-correct edge/band, reference
 * calibration, uncertainty budget, traffic light and per-tool history. Needs metro-core.js; report via metro-report.js.
 * Hook: Tool3D.metro.update({shots, flutes, diameterMm, engine}) after a wear run (reads Tool3D.wearResult/wearDebug).
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, M = T.metroCore, MAXPX = 2400;
  const $ = (s, r = document) => r.querySelector(s), el = (tag, attrs = {}, html = '') => Object.assign(document.createElement(tag), attrs, html ? {innerHTML: html} : {});
  const COLORS = ['#1f77b4', '#d62728', '#2ca02c', '#9467bd', '#ff7f0e', '#17becf'];
  const LIGHT = {green: '#1e9e4a', amber: '#e0a100', red: '#d0342c'}, LBL = {green: 'OK', amber: 'WARN', red: 'LIMIT'};
  const f3 = v => (v == null || Number.isNaN(v)) ? '—' : (+v).toFixed(3), pm = x => `${f3(x.v)} <small>± ${f3(x.U)}</small>`;
  const PREF = 'tool3d.metro.prefs', store = (() => { try { return window.localStorage; } catch (e) { return null; } })() || {getItem: () => null, setItem: () => {}};
  const loadPrefs = () => { try { return JSON.parse(store.getItem(PREF) || '{}') || {}; } catch (e) { return {}; } };
  const S = {
    ready: false, sel: 0, tool: 'pan', src: 'strip', enh: false, view: {s: 1, ox: 0, oy: 0}, pts: [], manual: [], ref: null, hover: null, drag: null, selNode: null,
    prefs: Object.assign({toolId: 'T-001', operator: '', limitMm: .3, warnPct: 80, cornerMm: '', apMm: '', diaTolMm: .01, refMm: 1, refTolMm: .002}, loadPrefs())
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
  <div class="mt-title"><h2>④ 측정 · Flank wear VB <small>ISO 8688-2 / ISO 3685</small></h2><div id="mtOverall" class="mt-badge">—</div></div>
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
      <button id="mtReset" class="mt-ghost" title="이 날의 수동 보정 초기화">Reset edits</button>
    </div>
    <div class="mt-assist" id="mtAssist" hidden></div>
    <div class="mt-cwrap"><canvas id="mtCanvas"></canvas><canvas id="mtLoupe" width="160" height="160" hidden></canvas>
      <div class="mt-legend"><i style="background:#00d0ff"></i>절삭날 선 <i style="background:#ffd400"></i>마모 경계 <i style="background:rgba(255,40,40,.6)"></i>VB 밴드</div></div>
    <div id="mtReadout" class="mt-readout">—</div>
    <table class="mt-man" id="mtManual"></table>
  </div>
  <div class="mt-side">
    <div class="mt-lights" id="mtLights"></div>
    <table class="mt-tab" id="mtTable"></table>
    <div class="mt-card"><div class="mt-h">VB(z) profile <small id="mtZlbl">z = 팁에서 축방향 거리</small></div><canvas id="mtChart"></canvas></div>
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
    $('#mtCsv').onclick = () => T.metroReport && T.metroReport.csv();
    $('#mtPdf').onclick = () => T.metroReport && T.metroReport.pdf();
    $('#mtHtml').onclick = () => T.metroReport && T.metroReport.html();
    $('#mtPrint').onclick = () => T.metroReport && T.metroReport.print();
    $('#mtSave').onclick = saveHistory;
    pointer();
    addEventListener('resize', () => S.ready && (sizeCanvas(), draw(), drawChart()));
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
    if (!first) publish();
    renderTable(); renderLights(); drawChart(); renderCal(); renderBudget(); renderHist(); renderAssist(); draw();
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
      calib: S.cal, flutes: S.ev, worst: wi, overall: e && e.status, vbMax: e && e.q.vbMax, manual: S.manual.map(m => ({kind: m.kind, flute: m.flute + 1, mm: m.mm, U: m.U}))};
  }

  // ---------- tables ----------
  // Keyence / Alicona style post-processing of the AI land (wearResult.post, wear-post.js) is shown in panel ⑤ (js/post/post-ui.js)
  function renderTable() {
    const L = opts().limitMm, head = '<tr><th>Flute</th><th>VBmax</th><th>VBB (avg)</th><th>VBC corner</th><th>VBN notch</th><th title="이 날에서 한계 대비">%</th><th></th></tr>';
    $('#mtTable').innerHTML = head + S.ev.map((e, i) => e ? `<tr data-row="${i}" class="${i === S.sel ? 'sel' : ''}">
      <td><b style="color:${COLORS[i % 6]}">F${i + 1}</b>${e.edited ? ' <span class="mt-ed" title="수동 보정됨">✎</span>' : ''}${e.assist ? ` <span class="mt-mode ${e.mode}" title="${RSN[e.assist] || e.assist}">${e.mode}</span>` : ''}</td>
      <td>${pm(e.q.vbMax)}</td><td>${pm(e.q.vbb)}</td><td>${pm(e.q.vbc)}</td><td>${pm(e.q.vbn)}</td>
      <td>${Math.round(e.status.usedPct)}</td><td><i class="mt-dot" style="background:${LIGHT[e.status.light]}" title="${e.status.decision}"></i></td></tr>`
      : `<tr><td>F${i + 1}</td><td colspan="6" class="hint">측정 실패 (외곽 미검출)</td></tr>`).join('') +
      `<tr class="mt-foot"><td colspan="7">mm · 값 ± U (k=2, ≈95 %) · 한계 ${f3(L)} mm · 판정: ISO 14253-1 (VB+U &lt; 한계 → 적합)</td></tr>`;
    root.querySelectorAll('[data-row]').forEach(r => r.onclick = () => select(+r.dataset.row));
  }
  function renderLights() {
    const wi = worst(), ov = wi == null ? null : S.ev[wi].status, b = $('#mtOverall');
    b.textContent = ov ? `${LBL[ov.light]} · VBmax ${f3(S.ev[wi].q.vbMax.v)} ± ${f3(S.ev[wi].q.vbMax.U)} mm` : '—';
    b.style.background = ov ? LIGHT[ov.light] : '#889'; b.dataset.light = ov ? ov.light : '';
    $('#mtLights').innerHTML = S.ev.map((e, i) => e ? `<div class="mt-light ${e.status.light}"><i></i><b>F${i + 1}</b><span>${f3(e.q.vbMax.v)}</span><em>${e.status.decision}</em></div>` : '').join('');
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
    const id = S.prefs.toolId, list = M.history(store, id), tr = M.trend(list), L = opts().limitMm;
    $('#mtHist').innerHTML = `<div class="mt-h">이력 · History <small>${id || '—'} · ${list.length}건${tr ? ` · 추세 ${tr.slope > 0 ? '+' : ''}${tr.slope.toFixed(3)} mm/${tr.per === 'min' ? 'min' : '회'}` : ''}</small></div>
      ${list.length ? `<canvas id="mtSpark" height="60"></canvas><table class="mt-tab"><tr><th>날짜</th><th>측정자</th><th>VBmax ± U</th><th></th></tr>${list.slice(-6).reverse().map(h =>
        `<tr><td>${h.date}</td><td>${h.op || ''}</td><td>${f3(h.vbMax)} ± ${f3(h.U)}</td><td><i class="mt-dot" style="background:${LIGHT[h.light] || '#889'}"></i></td></tr>`).join('')}</table>` : '<div class="hint">저장된 측정이 없습니다. “이력 저장”으로 추가합니다.</div>'}`;
    const sp = $('#mtSpark'); if (!sp) return;
    const w = sp.width = sp.clientWidth || 300, h = 60, x = sp.getContext('2d'), mx = Math.max(L * 1.2, ...list.map(e => e.vbMax + (e.U || 0)));
    const X = i => 8 + i * (w - 16) / Math.max(1, list.length - 1), Y = v => h - 6 - v / mx * (h - 12);
    x.strokeStyle = LIGHT.red; x.setLineDash([4, 3]); x.beginPath(); x.moveTo(0, Y(L)); x.lineTo(w, Y(L)); x.stroke(); x.setLineDash([]);
    x.strokeStyle = '#345'; x.beginPath(); list.forEach((e, i) => i ? x.lineTo(X(i), Y(e.vbMax)) : x.moveTo(X(i), Y(e.vbMax))); x.stroke();
    list.forEach((e, i) => { x.fillStyle = LIGHT[e.light] || '#345'; x.beginPath(); x.arc(X(i), Y(e.vbMax), 3, 0, 7); x.fill(); });
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
      if (e.zAtMaxMm != null) { const r = Math.round(e.zAtMaxMm * ppm - .5), y = top + r + .5; cx.strokeStyle = '#ff3b30'; cx.lineWidth = 2 * lw; cx.beginPath(); cx.moveTo(A[r] - .5, y); cx.lineTo(B[r] + .5, y); cx.stroke(); cx.fillStyle = '#ff3b30'; cx.fillText('VBmax', B[r] + 4 * lw, y - 3 * lw); }
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
    drawLoupe();
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
    stripImage, // for the report
    // test hooks: image px of the active view -> viewport client coords
    imgToClient(ix, iy) { const r = cv.getBoundingClientRect(), [x, y] = toScr(ix, iy); return [r.left + x, r.top + y]; },
    nodeClient(side, i) { return this.imgToClient(...nodePos(S.F[S.sel], side, i)); },
    edgePoint(r) { const F = S.F[S.sel]; return [M.edgeX(F, r), F.strip.top + r + .5]; }
  };
})();
