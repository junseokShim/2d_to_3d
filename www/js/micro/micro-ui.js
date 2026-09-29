/* Tool3D microscope input mode (step ① choice, magnification + calibration, per-flute image slots, measurement run).
 * Needs micro-core.js, seg-wear.js (Tool3D.wear.seg), metro (Tool3D.metro) and the page's #inmode / #slots / #run.
 * Hooks from index.html: Tool3D.microUI.active(), .renderSlots(box), .run(). Everything else stays in this file.
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, MC = () => T.micro.core;
  const $ = s => document.querySelector(s), el = (tag, attrs = {}, html = '') => Object.assign(document.createElement(tag), attrs, html ? {innerHTML: html} : {});
  const store = (() => { try { return window.localStorage; } catch (e) { return null; } })() || {getItem: () => null, setItem: () => {}};
  const PREF = 'tool3d.micro.prefs', MAXPX = 2400;
  const S = Object.assign({mode: 'camera', mag: 50, corner: 'none', cornerMm: .2, vbRef: 'reference'}, (() => { try { return JSON.parse(store.getItem(PREF) || '{}') || {}; } catch (e) { return {}; } })(), {imgs: [], last: null});
  const savePrefs = () => { try { store.setItem(PREF, JSON.stringify({mode: S.mode, mag: S.mag, corner: S.corner, cornerMm: S.cornerMm, vbRef: S.vbRef})); } catch (e) { /* private mode */ } };
  const cal = () => MC().calStore(store);
  const msg = t => { const m = $('#msg'); if (m) m.textContent = t || ''; };
  const f3 = v => v == null ? '—' : (+v).toFixed(3);
  const CORNER = {none: '영상에 없음', start: '왼쪽 끝', end: '오른쪽 끝'};
  const VBREF = {reference: '미마모 날 기준선 (Keyence)', edge: '절삭날 직선'};
  const FLAG = {'vb-uncertain': 'VB 경계 불확실', 'edge-ragged': '절삭날 선 불규칙', 'edge-short': '절삭날이 영상 일부에만 보임', 'no-wear': '마모 밴드 없음', review: '작업자 검토 필요'};

  // ---------- step ①: input mode, magnification, calibration ----------
  function build() {
    const box = $('#inmode'); if (!box || box.dataset.built) return; box.dataset.built = 1;
    const mags = MC().MAGS, custom = !mags.includes(+S.mag);
    box.innerHTML = `
<div class="mi-mode" role="radiogroup" aria-label="입력 방식"><span>입력 방식</span>
  <label><input type="radio" name="inmode" value="camera"> 스마트폰 카메라</label>
  <label><input type="radio" name="inmode" value="microscope"> 현미경</label></div>
<div id="miPanel" class="mi-panel" hidden>
  <label class="row"><span>배율</span><select id="miMag">${mags.map(m => `<option value="${m}">${m}x</option>`).join('')}<option value="custom">직접 입력</option></select>
    <input id="miMagC" type="number" min="1" step="1" style="width:5.5em" placeholder="배율" ${custom ? '' : 'hidden'}></label>
  <div class="mi-cal"><div id="miCalState" class="mi-state"></div>
    <label class="row"><span>µm/px</span><input id="miUm" type="number" step="0.0001" min="0" style="width:7em" placeholder="현미경 값"><button id="miUmSave">저장</button></label>
    <div class="ctl"><label class="btn">기준 영상으로 교정<input id="miRef" type="file" accept="image/*" hidden></label><button id="miCalDel" class="mi-ghost">교정 삭제</button></div>
    <p class="hint">배율마다 교정이 기기에 저장됩니다. px/mm 는 공구경이 아니라 이 교정에서 옵니다.</p></div>
  <label class="row"><span>코너 위치</span><select id="miCorner">${Object.entries(CORNER).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
  <label class="row"><span>C 구역 (mm)</span><input id="miCornerMm" type="number" step="0.05" min="0" style="width:6em"></label>
  <label class="row"><span>VB 기준선</span><select id="miVbRef">${Object.entries(VBREF).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></label>
  <p class="hint">코너 위치는 공구가 위, 배경이 아래로 오게 본 방향 기준입니다. VB 기준선: 미마모 절삭날에 맞춘 기준선(Keyence VHX 방식, 기본) 또는 전체 절삭날 직선.</p>
</div>
<div id="miCalDlg" class="mi-dlg" hidden><div class="mi-box">
  <h3 id="miCalTitle">배율 교정</h3>
  <p class="hint">스테이지 마이크로미터(또는 길이를 아는 물체) 영상에서 알려진 길이의 양 끝을 드래그해 선을 그으세요. 끝점은 다시 끌어 옮길 수 있습니다.</p>
  <div class="mi-cwrap"><canvas id="miCalCv"></canvas></div>
  <div class="ctl"><span id="miCalPx" class="mi-state">선: —</span>
    <label>실제 길이 <input id="miCalLen" type="number" step="0.001" min="0" value="1" style="width:6em"> mm</label>
    <label>공차 ± <input id="miCalTol" type="number" step="0.001" min="0" value="0.001" style="width:6em"> mm</label>
    <button class="pri" id="miCalOk">저장</button><button id="miCalNo">취소</button></div>
</div></div>`;
    box.querySelectorAll('[name=inmode]').forEach(r => { r.checked = r.value === S.mode; r.onchange = () => setMode(r.value); });
    const sel = $('#miMag'); sel.value = custom ? 'custom' : String(S.mag); if (custom) $('#miMagC').value = S.mag;
    sel.onchange = () => { const c = sel.value === 'custom'; $('#miMagC').hidden = !c; if (!c) setMag(+sel.value); else $('#miMagC').focus(); };
    $('#miMagC').onchange = e => +e.target.value > 0 && setMag(+e.target.value);
    $('#miUmSave').onclick = () => { const c = MC().calibUm(+$('#miUm').value); if (!c) return msg('µm/px 값을 입력하세요.'); cal().set(S.mag, c); msg(); renderCal(); };
    $('#miCalDel').onclick = () => { cal().remove(S.mag); renderCal(); };
    $('#miRef').onchange = e => { const f = e.target.files[0]; e.target.value = ''; if (f) openCalDlg(f); };
    $('#miCorner').value = S.corner; $('#miCorner').onchange = e => { S.corner = e.target.value; savePrefs(); };
    $('#miVbRef').value = S.vbRef; $('#miVbRef').onchange = e => { S.vbRef = e.target.value; savePrefs(); };
    $('#miCornerMm').value = S.cornerMm; $('#miCornerMm').onchange = e => { S.cornerMm = Math.max(0, +e.target.value || 0); savePrefs(); };
    calDlg();
    setMode(S.mode, true);
  }
  function setMag(m) { S.mag = m; savePrefs(); renderCal(); }
  function renderCal() {
    const c = cal().get(S.mag), b = $('#miCalState'); if (!b) return;
    b.dataset.ok = c ? 1 : 0;
    b.innerHTML = c ? `<b>${S.mag}x 교정</b> ${c.umPerPx} µm/px = ${c.pxPerMm.toFixed(1)} px/mm <small>(${c.method === 'um/px' ? 'µm/px 입력' : `마이크로미터 ${c.lineMm} mm = ${c.linePx} px`}, U<sub>rel</sub> ${(200 * c.uRel).toFixed(2)} % k=2, ${c.date || ''})</small>`
      : `<b>${S.mag}x 교정 없음</b> <small>µm/px 를 입력하거나 기준 영상으로 교정하세요.</small>`;
    if (c) $('#miUm').value = c.umPerPx;
  }
  function setMode(m, first) {
    S.mode = m === 'microscope' ? 'microscope' : 'camera'; savePrefs();
    $('#miPanel').hidden = S.mode !== 'microscope';
    const hint = $('#slotHint'), multi = $('#multiRow');
    if (hint) { if (!hint.dataset.cam) hint.dataset.cam = hint.innerHTML; hint.innerHTML = S.mode === 'microscope' ? '날마다 현미경 영상(여공면 · 절삭날 근접)을 1장 이상 불러옵니다. 한 날에 여러 장이면 절삭날을 따라 순서대로 불러오세요.' : hint.dataset.cam; }
    if (multi) multi.hidden = S.mode === 'microscope';
    document.body.dataset.inmode = S.mode;
    renderCal();
    if (!first || S.mode === 'microscope') typeof window.renderSlots === 'function' && window.renderSlots();
  }

  // stage micrometer dialog: draw a line over the known length, type the length
  const D = {img: null, k: 1, p: null, drag: -1};
  function calDlg() {
    const cv = $('#miCalCv'), x = cv.getContext('2d');
    const loc = e => { const r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * cv.width / r.width / D.k, (e.clientY - r.top) * cv.height / r.height / D.k]; };
    cv.onpointerdown = e => {
      if (!D.img) return; cv.setPointerCapture(e.pointerId); const p = loc(e), tol = 12 / D.k;
      D.drag = D.p ? D.p.findIndex(q => Math.hypot(q[0] - p[0], q[1] - p[1]) < tol) : -1;
      if (D.drag < 0) { D.p = [p, p.slice()]; D.drag = 1; }
      drawCal();
    };
    cv.onpointermove = e => { if (D.drag < 0) return; D.p[D.drag] = loc(e); drawCal(); };
    cv.onpointerup = cv.onpointercancel = () => { D.drag = -1; };
    $('#miCalNo').onclick = () => { $('#miCalDlg').hidden = true; };
    $('#miCalOk').onclick = () => {
      if (!D.p) return;
      const px = Math.hypot(D.p[1][0] - D.p[0][0], D.p[1][1] - D.p[0][1]), c = MC().calibLine(px, +$('#miCalLen').value, +$('#miCalTol').value || 0, Math.max(1, 1 / D.k));
      if (!c) return; cal().set(S.mag, c); $('#miCalDlg').hidden = true; renderCal();
    };
    function drawCal() {
      x.setTransform(1, 0, 0, 1, 0, 0); x.clearRect(0, 0, cv.width, cv.height); if (!D.img) return;
      x.drawImage(D.img, 0, 0, cv.width, cv.height);
      if (!D.p) { $('#miCalPx').textContent = '선: —'; return; }
      const [a, b] = D.p.map(p => [p[0] * D.k, p[1] * D.k]);
      x.strokeStyle = '#00ffa0'; x.lineWidth = 2; x.beginPath(); x.moveTo(...a); x.lineTo(...b); x.stroke();
      for (const p of [a, b]) { x.beginPath(); x.arc(p[0], p[1], 6, 0, 7); x.stroke(); }
      $('#miCalPx').textContent = `선: ${Math.hypot(D.p[1][0] - D.p[0][0], D.p[1][1] - D.p[0][1]).toFixed(1)} px`;
    }
    D.draw = drawCal;
  }
  async function openCalDlg(file) {
    const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
    const w = img.naturalWidth, h = img.naturalHeight, k = Math.min(1, 1100 / w, 700 / h), cv = $('#miCalCv');
    cv.width = Math.round(w * k); cv.height = Math.round(h * k);
    Object.assign(D, {img, k, p: null, drag: -1});
    $('#miCalTitle').textContent = `배율 교정 · ${S.mag}x`; $('#miCalDlg').hidden = false; D.draw();
  }

  // ---------- step ②: images per flute ----------
  function thumb(src, H = 64) { const W = src.naturalWidth || src.width, Hs = src.naturalHeight || src.height, c = el('canvas', {width: Math.round(H * W / Hs), height: H}); c.getContext('2d').drawImage(src, 0, 0, c.width, c.height); return c; }
  function renderSlots(box) {
    const k = +$('#flutes').value; S.imgs.length = Math.max(S.imgs.length, k);
    box.innerHTML = '';
    for (let i = 0; i < k; i++) {
      const imgs = S.imgs[i] || (S.imgs[i] = []), d = el('div', {className: 'slot mi-slot'});
      d.dataset.flute = i;
      d.innerHTML = `<b>F${i + 1} 절삭날 <small>${imgs.length}장</small></b><div class="th mi-th">${imgs.length ? '' : '없음'}</div>
        <label class="btn">영상 추가<input type="file" accept="image/*" multiple hidden></label>${imgs.length ? '<button class="mi-ghost">비우기</button>' : ''}`;
      const th = d.querySelector('.th'); imgs.forEach(im => th.append(thumb(im)));
      d.querySelector('input').onchange = e => addImages(i, [...e.target.files]);
      const clr = d.querySelector('button'); if (clr) clr.onclick = () => { S.imgs[i] = []; renderSlots(box); };
      box.append(d);
    }
  }
  async function addImages(i, files) {
    files.sort((a, b) => a.name.localeCompare(b.name, undefined, {numeric: true}));
    for (const f of files) { const img = new Image(); img.src = URL.createObjectURL(f); await img.decode(); img.dataset.name = f.name; (S.imgs[i] = S.imgs[i] || []).push(img); }
    renderSlots($('#slots'));
  }
  // test / automation hook: images (HTMLImageElement | canvas) for flute i
  function setImages(i, list) { S.imgs[i] = list.slice(); renderSlots($('#slots')); }

  // ---------- step ③: measure ----------
  function toImage(src, s) {
    const W = src.naturalWidth || src.width, H = src.naturalHeight || src.height, w = Math.round(W * s), h = Math.round(H * s);
    const x = el('canvas', {width: w, height: h}).getContext('2d', {willReadFrequently: true}); x.drawImage(src, 0, 0, w, h);
    return x.getImageData(0, 0, w, h);
  }
  async function run() {
    msg(); const k = +$('#flutes').value, Dmm = +$('#dia').value, btn = $('#run'), c = cal().get(S.mag);
    if (btn.disabled) return;
    if (!c) return msg(`현미경 ${S.mag}x 교정이 없습니다. ① 에서 µm/px 를 입력하거나 기준 영상으로 교정하세요.`);
    const flutes = [...Array(k).keys()].filter(i => S.imgs[i] && S.imgs[i].length);
    if (!flutes.length) return msg('현미경 영상을 날마다 1장 이상 불러오세요.');
    btn.disabled = true; $('#busy').hidden = false; $('#engine').textContent = '';
    await new Promise(ok => requestAnimationFrame(() => setTimeout(ok, 0)));
    try {
      const all = flutes.flatMap(i => S.imgs[i]), long = Math.max(...all.map(s => Math.max(s.naturalWidth || s.width, s.naturalHeight || s.height)));
      const sc = Math.min(1, MAXPX / long), ppm = c.pxPerMm * sc, runProbs = await T.wear.seg.runner(), core = MC();
      const per = [], strips = [], sides = [], images = [], posts = [];
      for (let i = 0; i < k; i++) {
        const list = S.imgs[i] || [];
        if (!list.length) { per.push({vbMaxMm: 0, vbAvgMm: 0, areaMm2: 0, volumeMm3: 0, profile: [], missing: true}); strips.push(null); sides.push(null); continue; }
        const res = [];
        for (let j = 0; j < list.length; j++) {
          const corner = S.corner === 'start' && j === 0 ? 'start' : S.corner === 'end' && j === list.length - 1 ? 'end' : 'none';
          try { res.push(await core.analyzeImage(toImage(list[j], sc), {runProbs, seg: T.wear.seg, pxPerMm: ppm, uRel: c.uRel, corner, cornerMm: S.cornerMm, vbRef: S.vbRef})); }
          catch (e) { images.push({flute: i + 1, image: j + 1, error: String(e.message || e)}); }
        }
        if (!res.length) { per.push({vbMaxMm: 0, vbAvgMm: 0, areaMm2: 0, volumeMm3: 0, profile: [], failed: true}); strips.push(null); sides.push(null); continue; }
        res.forEach((r, j) => images.push({flute: i + 1, image: j + 1, name: list[j] && list[j].dataset ? list[j].dataset.name : null, q: r.q, edge: {sigmaPx: r.line.sigmaPx, cover: r.line.cover, receded: r.line.receded},
          stats: r.stats, vbRef: r.vbRef, methods: {reference: r.methods.reference, edge: r.methods.edge}, vbMax: r.q2.vbMax, vbb: r.q2.vbb, vbc: r.q2.vbc, flags: r.flags, netScale: r.netScale, result: r}));
        const worst = res.reduce((a, b) => b.stats.vbMax > a.stats.vbMax ? b : a), worn = res.reduce((s, r) => s + r.stats.wornMm, 0);
        const vbb = worn ? res.reduce((s, r) => s + r.stats.vbb * r.stats.wornMm, 0) / worn : 0, vbc = res.map(r => r.stats.vbc).filter(v => v != null);
        per.push({vbMaxMm: worst.stats.vbMax, vbAvgMm: core.r4(vbb), vbbMm: core.r4(vbb), vbcMm: vbc.length ? Math.max(...vbc) : null, U: worst.q2.vbMax.U, vbRef: worst.vbRef, refSource: worst.ref.source, vbMaxRefMm: worst.methods.reference.vbMax, vbMaxEdgeMm: worst.methods.edge.vbMax, edgeOutsideMm: worst.ref.outsideMm, areaMm2: 0, volumeMm3: 0, profile: [], images: res.length,
          flags: [...new Set(res.flatMap(r => r.flags))]});
        // Keyence / Alicona style post-processing of the worst image's land (js/wear/wear-post.js; edge = tool / background boundary)
        const PO = T.wear.post, sg = worst.seg;
        try { posts[i] = PO && sg && sg.mask ? PO.analyze({mask: sg.mask, w: sg.w, h: sg.h, pxPerMm: ppm / sg.scale[0], toMm: (X, Y) => [X * sg.scale[0] / ppm, Y * sg.scale[1] / ppm], edge: 'background'}) : null; } catch (e) { posts[i] = null; }
        strips.push(core.fluteStrip(res, ppm, S.corner));
        sides.push({align: {pxPerMm: ppm}, reasons: per[i].flags});
      }
      const engine = `AI (Seg) · 현미경 ${S.mag}x`;
      const wr = {engine: 'micro', inputMode: 'microscope', magnification: S.mag, diameterMm: Dmm, flutes: k, helixDeg: 0, perFlute: per,
        post: per.map((_, i) => posts[i] ? {keyence: posts[i].keyence, alicona: posts[i].alicona, lengthMm: posts[i].lengthMm, edgeSide: posts[i].edgeSide} : null),
        totals: {vbMaxMm: Math.max(0, ...per.map(f => f.vbMaxMm)), areaMm2: 0, volumeMm3: 0}, calib: {pxPerMm: ppm, umPerPx: core.r4(1000 / ppm), uRel: c.uRel, method: c.method}};
      T.wearResult = wr; T.faceSeg = null;
      T.wearDebug = {engine: 'micro', inputMode: 'microscope', magnification: S.mag, calib: core.metroCalib(Object.assign({}, c, {pxPerMm: ppm}), S.mag),
        zones: {cornerMm: S.corner === 'none' ? 0 : S.cornerMm, apMm: 1e6, notchHalfMm: 0, zoneMm: 1e6}, strips, sides, images, scale: sc};
      S.last = {k, images, per};
      window.dispatchEvent(new CustomEvent('tool3d:wear', {detail: wr}));
      $('#engine').textContent = 'Engine: ' + engine;
      renderResults(k, per, images, c, ppm);
      T.metro && T.metro.update({shots: [...Array(k).keys()].map(i => (S.imgs[i] || [])[0] || null), flutes: k, diameterMm: Dmm, engine, quality: []});   // ④ 측정 패널: VB 경계 드래그 보정
      T.render && T.render.update && T.render.update({flutes: k, diameterMm: Dmm, helixDeg: +$('#helix').value || 30});
    } catch (e) { console.warn('micro:', e); msg('현미경 측정 실패: ' + (e.message || e)); }
    finally { btn.disabled = false; $('#busy').hidden = true; }
  }
  function renderResults(k, per, images, c, ppm) {
    const rows = [['입력 방식', `현미경 ${S.mag}x`], ['교정', `${(1000 / ppm).toFixed(4)} µm/px · ${ppm.toFixed(1)} px/mm (${c.method === 'um/px' ? 'µm/px 입력' : '스테이지 마이크로미터'}, U<sub>rel</sub> ${(200 * c.uRel).toFixed(2)} %)`],
      ['코너 (VBC 구역)', S.corner === 'none' ? '영상에 없음' : `${CORNER[S.corner]} · ${S.cornerMm} mm`], ['VB 기준선', VBREF[S.vbRef] || S.vbRef]];
    per.forEach((f, i) => rows.push([`F${i + 1} VBmax / VBB${f.vbcMm != null ? ' / VBC' : ''}`, f.missing ? '영상 없음' : f.failed ? '절삭날 미검출' :
      `${f3(f.vbMaxMm)} ± ${f3(f.U)} / ${f3(f.vbbMm)}${f.vbcMm != null ? ' / ' + f3(f.vbcMm) : ''} mm${f.flags.length ? ` <small>(${f.flags.map(x => FLAG[x] || x).join(', ')})</small>` : ''}`]));
    per.forEach((f, i) => { if (f.vbMaxRefMm != null) rows.push([`F${i + 1} VBmax 기준선 / 절삭날`, `${f3(f.vbMaxRefMm)} / ${f3(f.vbMaxEdgeMm)} mm <small>(${f.refSource === 'unworn' ? `미마모 구간 기준선, 실제 날이 기준선 밖 ${f3(f.edgeOutsideMm)} mm` : '기준선 = 절삭날 직선'})</small>`]); });
    const err = images.filter(m => m.error); if (err.length) rows.push(['실패한 영상', err.map(m => `F${m.flute}-${m.image}: ${m.error}`).join('<br>')]);
    $('#res').innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
    $('#strips').replaceChildren(...images.filter(m => m.result).map(m => overlay(m)));
  }
  // image with the wear land (red), the fitted cutting edge (cyan) and the land boundary (yellow)
  function overlay(m) {
    const r = m.result, src = S.imgs[m.flute - 1][m.image - 1], W = src.naturalWidth || src.width, H = src.naturalHeight || src.height, k = 180 / H;
    const c = el('canvas', {width: Math.round(W * k), height: 180}), x = c.getContext('2d'), sc = T.wearDebug.scale * 1;
    x.drawImage(src, 0, 0, c.width, c.height); const f = k / sc, P = (u, v) => r.toImg(u, v).map(t => t * f);
    x.lineWidth = 1.5; x.strokeStyle = '#ffd400'; x.beginPath();
    for (let u = 0; u < r.frame.L; u += 2) { const p = P(u, r.vbPx[u]); u ? x.lineTo(...p) : x.moveTo(...p); } x.stroke();
    x.strokeStyle = '#00d0ff'; x.beginPath(); x.moveTo(...P(0, 0)); x.lineTo(...P(r.frame.L - 1, 0)); x.stroke();
    c.title = `F${m.flute}-${m.image}: VBmax ${f3(m.vbMax.v)} ± ${f3(m.vbMax.U)} mm`;
    return c;
  }

  T.microUI = {active: () => S.mode === 'microscope', renderSlots, run, setMode, setMag, setImages, get state() { return S; }};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
