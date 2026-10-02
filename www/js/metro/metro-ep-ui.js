/* Tool3D section ④ extra cards (needs metro-endprofile.js; uses metro-vb.js scale bar):
 * (1) end-face segmentation: top photo upload slot (or the top photo of the last 3D run), fitted outer circle, each tooth's
 *     face filled as a coloured mask, per-tooth area in mm², scale bar;
 * (2) profile graph: height / edge profile (µm vs µm) from the section ③ section line, the selected flute's cutting edge, or a
 *     two-column file; drag a segment to fit the straight reference (red), extended dashed, click a point for the
 *     perpendicular deviation arrow and value; the maximum deviation is marked too.
 * Registers Tool3D.endProfileReport {csv, html, pdfPage} (metro-report.js adds them to the report) and Tool3D.metroEPui (test hooks).
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, E = T.metroEP, V = T.metroVb, MAXPX = 1600;
  const $ = (s, r = document) => r.querySelector(s);
  const f1 = v => v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(1), f2 = v => v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(2), f3 = v => v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(3);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
  const TOOTH = [[230, 40, 60], [255, 120, 30], [40, 170, 90], [60, 110, 240], [190, 60, 200], [20, 180, 200]];
  const S = {img: null, imgSrc: null, seg: null, opt: {diameterMm: '', k: '', barUm: 2000, scale: 'auto'}, prof: null, source: null, segX: null, pickX: null, drag: null};
  let root, built = false;

  // ---------- DOM ----------
  function build() {
    const host = $('#metro'); if (!host || !E) return false;
    if (built) return true;
    built = true;
    root = document.createElement('div'); root.id = 'mtEP'; root.className = 'mt-ep';
    root.innerHTML = `
<div class="mt-card" id="mtSeg"><div class="mt-h">끝면 분할 · End-face segmentation <small>외곽 원 맞춤 · 날별 면 마스크 · 면적 mm² · 스케일바</small></div>
  <div class="mt-row mt-epbar">
    <label class="mt-up">윗면(끝면) 사진 <input type="file" id="mtSegFile" accept="image/*"></label>
    <label>Ø mm <input id="mtSegD" type="number" step="0.01" min="0" placeholder="3D 입력값"></label>
    <label>날 수 <input id="mtSegK" type="number" step="1" min="0" max="12" placeholder="자동"></label>
    <label title="사진 속 스케일바의 길이. 비우면 지름으로 배율">스케일바 µm <input id="mtSegBar" type="number" step="1" min="0" value="2000"></label>
    <label>배율 <select id="mtSegScale"><option value="auto">자동 (스케일바 → 지름)</option><option value="bar">스케일바</option><option value="diameter">지름</option></select></label>
  </div>
  <div class="mt-epimg"><canvas id="mtSegCv" width="10" height="10"></canvas></div>
  <div id="mtSegOut" class="hint">윗면 사진을 올리거나 3D 생성을 실행하면 표시됩니다.</div>
</div>
<div class="mt-card" id="mtProf"><div class="mt-h">프로파일 · 기준선 편차 <small>µm vs µm · 구간 드래그 = 기준 직선 · 클릭 = 수직 편차</small></div>
  <div class="mt-row mt-epbar">
    <div class="mt-seg" id="mtProfSrc"><button data-psrc="surface" title="③ 3D 단면 프로파일 (측정 높이)">3D 단면</button><button data-psrc="edge" title="④ 선택한 날의 절삭날 선 (날 따라 z vs 날 위치)">절삭날</button><button data-psrc="file" title="두 열 파일 (x µm, 높이 µm)">파일</button></div>
    <label class="mt-up">파일 <input type="file" id="mtProfFile" accept=".csv,.txt,.tsv,text/plain,text/csv"></label>
    <div class="mt-seg" id="mtProfMode"><button data-pmode="seg" class="on" title="드래그로 기준 구간 선택">기준 구간</button><button data-pmode="pick" title="클릭으로 측정점 선택">측정점</button></div>
    <label>구간 µm <input id="mtProfX0" type="number" step="1"> – <input id="mtProfX1" type="number" step="1"></label>
    <label>점 µm <input id="mtProfPx" type="number" step="1"></label>
  </div>
  <div class="mt-epgraph"><canvas id="mtProfCv" width="10" height="10"></canvas></div>
  <div id="mtProfOut" class="hint">프로파일 원본을 고르세요: ③ 단면 선, ④ 절삭날, 또는 두 열 파일 (x µm, 높이 µm).</div>
</div>`;
    host.appendChild(root);   // below the measurement grid; visible without a 3D run (upload slot)
    const num = id => { const v = $('#' + id).value; return v === '' ? '' : +v; };
    $('#mtSegFile').onchange = e => { const f = e.target.files && e.target.files[0]; if (f) loadFile(f); };
    const re = () => { S.opt = {diameterMm: num('mtSegD'), k: num('mtSegK'), barUm: num('mtSegBar'), scale: $('#mtSegScale').value}; runSeg(); };
    ['mtSegD', 'mtSegK', 'mtSegBar'].forEach(id => $('#' + id).addEventListener('change', re)); $('#mtSegScale').onchange = re;
    $('#mtProfFile').onchange = e => { const f = e.target.files && e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => setProfile(E.parseProfile(r.result), 'file:' + f.name); r.readAsText(f); };
    root.querySelectorAll('[data-psrc]').forEach(b => b.onclick = () => useSource(b.dataset.psrc));
    root.querySelectorAll('[data-pmode]').forEach(b => b.onclick = () => { S.mode = b.dataset.pmode; root.querySelectorAll('[data-pmode]').forEach(x => x.classList.toggle('on', x === b)); });
    S.mode = 'seg';
    const segIn = () => { const a = num('mtProfX0'), b = num('mtProfX1'); if (a !== '' && b !== '' && a !== b) { S.segX = [Math.min(a, b), Math.max(a, b)]; evalProfile(); } };
    $('#mtProfX0').onchange = segIn; $('#mtProfX1').onchange = segIn;
    $('#mtProfPx').onchange = () => { const v = num('mtProfPx'); S.pickX = v === '' ? null : v; evalProfile(); };
    graphPointer();
    addEventListener('resize', () => { drawSeg(); drawProf(); });
    addEventListener('tool3d:metro', () => { if (!S.imgSrc || S.imgSrc === 'run') fromRun(); if (S.source === 'edge') useSource('edge'); });
    addEventListener('tool3d:surface-profile', () => { if (!S.prof || S.source === 'surface') useSource('surface'); });
    return true;
  }

  // ---------- (1) end face ----------
  function loadFile(f) {
    const url = URL.createObjectURL(f), im = new Image();
    im.onload = () => { const k = Math.min(1, MAXPX / Math.max(im.width, im.height)), w = Math.round(im.width * k), h = Math.round(im.height * k);
      const c = document.createElement('canvas'); c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(im, 0, 0, w, h);
      URL.revokeObjectURL(url); setImage(x.getImageData(0, 0, w, h), 'upload:' + f.name); };
    im.src = url;
  }
  // image data of the last 3D run's top photo (metro-ui end-face state), unless the operator uploaded one
  function fromRun() {
    const m = T.metro && T.metro.state, top = m && m.top; if (!top || !top.img) return;
    if (!S.opt.diameterMm && m.D) $('#mtSegD').placeholder = String(m.D);
    if (!S.opt.k && m.k) $('#mtSegK').placeholder = String(m.k);
    setImage(top.img, 'run');
  }
  function setImage(img, src) { S.img = img; S.imgSrc = src; runSeg(); }
  function runSeg() {
    if (!S.img) return;
    const m = T.metro && T.metro.state, o = S.opt;
    const D = o.diameterMm !== '' && +o.diameterMm > 0 ? +o.diameterMm : (m && m.D) || null, k = o.k !== '' && +o.k > 0 ? +o.k : (m && m.k) || 0;
    const r = E.analyzeEndFace(S.img, {diameterMm: D, k, barUm: o.barUm !== '' && +o.barUm > 0 ? +o.barUm : null, scale: o.scale});
    S.seg = r.error ? null : Object.assign(r, {src: S.imgSrc}); S.segCv = null;
    renderSeg(r.error ? '외곽 원을 찾지 못했습니다 (배경과 공구가 구분되는 윗면 사진 필요).' : null);
  }
  function renderSeg(err) {
    const out = $('#mtSegOut'), a = S.seg; if (!out) return;
    if (!a) { out.innerHTML = `<span class="hint">${err || '윗면 사진을 올리거나 3D 생성을 실행하면 표시됩니다.'}</span>`; drawSeg(); return; }
    const sc = a.scale, t = a.total;
    out.innerHTML = `<table class="mt-tab mt-segtab"><tr><th>날</th><th>위치</th><th>면적 mm²</th><th>면적 px</th><th>원 대비 %</th><th>외곽 r mm</th></tr>
      ${a.teeth.map(T => `<tr${T.tooth === a.maxTooth ? ' class="mt-max"' : ''}><td><i class="mt-sw" style="background:rgb(${TOOTH[(T.tooth - 1) % 6]})"></i><b>T${T.tooth}</b></td><td>${Math.round(T.angleDeg)}°</td><td><b>${f3(T.areaMm2)}</b></td><td>${T.areaPx}</td><td>${f2(T.pctOfDisc)}</td><td>${f3(T.rMaxMm)}</td></tr>`).join('')}
      <tr class="mt-foot"><td colspan="2"><b>합계</b></td><td><b>${f3(t.areaMm2)}</b></td><td>${t.areaPx}</td><td>${f2(t.pctOfDisc)}</td><td></td></tr></table>
      <div class="mt-kv"><span>외곽 원</span><b>중심 (${f1(a.circle.cx)}, ${f1(a.circle.cy)}) px · r ${f1(a.circle.rPx)} px · 맞춤 잔차 ${f2(a.circle.rmsPx)} px (${a.circle.inliers}/${a.circle.points})</b>
      <span>배율</span><b>${sc.pxPerMm ? f2(sc.pxPerMm) + ' px/mm' : '—'} · ${sc.method === 'bar' ? `스케일바 ${sc.barUm} µm = ${f1(a.bar.px)} px` : sc.method === 'diameter' ? `지름 Ø${sc.diameterInputMm} mm` : '배율 없음 (Ø 또는 스케일바 입력)'}</b>
      <span>지름</span><b>${sc.diameterMm ? 'Ø ' + f3(sc.diameterMm) + ' mm' : '—'}${sc.diameterFromBarMm && sc.diameterInputMm && Math.abs(sc.diameterFromBarMm / sc.diameterInputMm - 1) > .03 ? ` <span class="mt-ng">⚠ 스케일바 기준 Ø${f2(sc.diameterFromBarMm)} mm ≠ 입력 Ø${sc.diameterInputMm} mm</span>` : ''}</b>
      <span>원본</span><b>${esc(a.src === 'run' ? '3D 실행의 윗면 사진' : String(a.src).replace(/^upload:/, '업로드: '))} · 임계 ${a.threshold} (Otsu) · 날 ${a.k}${a.kWanted && a.kWanted !== a.k ? ` / ${a.kWanted} 기대` : ''}</b></div>`;
    drawSeg();
  }
  // crop around the circle (1.12 R), each tooth's face tinted, the fitted circle, labels, scale bar
  function segCanvas() {
    if (S.segCv) return S.segCv;
    const a = S.seg, img = S.img, R = a.circle.rPx, half = 1.12 * R, k = Math.min(1, 640 / (2 * half)), N = Math.max(10, Math.round(2 * half * k));
    const c = document.createElement('canvas'); c.width = N; c.height = N; const x = c.getContext('2d'), im = x.createImageData(N, N), d = img.data;
    for (let Y = 0; Y < N; Y++) for (let X = 0; X < N; X++) {
      const sx = Math.floor(a.circle.cx - half + (X + .5) / k), sy = Math.floor(a.circle.cy - half + (Y + .5) / k), o = 4 * (Y * N + X);
      im.data[o + 3] = 255; if (sx < 0 || sy < 0 || sx >= img.width || sy >= img.height) continue;
      const i = sy * img.width + sx, t = a.label[i], col = t ? TOOTH[(t - 1) % 6] : null;
      for (let j = 0; j < 3; j++) im.data[o + j] = col ? .35 * d[4 * i + j] + .65 * col[j] : d[4 * i + j];
    }
    x.putImageData(im, 0, 0); return (S.segCv = {c, k, half});
  }
  function segInto(x, W) {
    const a = S.seg, {c, k, half} = segCanvas(), s = W / c.width, C = W / 2, Rr = a.circle.rPx * k * s;
    x.drawImage(c, 0, 0, W, W);
    x.strokeStyle = '#19d3c5'; x.lineWidth = 1.5; x.beginPath(); x.arc(C, C, Rr, 0, 7); x.stroke();
    x.font = '600 12px system-ui,sans-serif';
    for (const t of a.teeth) {
      const px = (t.cx - a.circle.cx + half) * k * s, py = (t.cy - a.circle.cy + half) * k * s, lab = `T${t.tooth} ${t.areaMm2 == null ? t.areaPx + ' px' : f3(t.areaMm2) + ' mm²'}`, tw = x.measureText(lab).width;
      x.fillStyle = 'rgba(255,255,255,.92)'; x.fillRect(px - tw / 2 - 3, py - 9, tw + 6, 17); x.strokeStyle = '#000'; x.lineWidth = 1; x.strokeRect(px - tw / 2 - 2.5, py - 8.5, tw + 5, 16); x.fillStyle = '#000'; x.fillText(lab, px - tw / 2, py + 4);
    }
    if (a.scale.pxPerMm && V) {
      const bar = V.scaleBar(a.scale.pxPerMm * k * s, .3 * W), bx1 = W - 12, bx0 = bx1 - bar.px, by = W - 30, lab = bar.um >= 1000 ? Math.round(bar.um) + 'µm' : bar.label;
      x.strokeStyle = '#2a3cff'; x.lineWidth = 2; x.beginPath(); x.moveTo(bx0, by); x.lineTo(bx1, by); x.moveTo(bx0, by - 4); x.lineTo(bx0, by + 4); x.moveTo(bx1, by - 4); x.lineTo(bx1, by + 4); x.stroke();
      x.font = '12px system-ui,sans-serif'; const tw = x.measureText(lab).width; x.fillStyle = '#fff'; x.fillRect(bx1 - tw - 6, by + 6, tw + 6, 17); x.strokeStyle = '#000'; x.lineWidth = 1; x.strokeRect(bx1 - tw - 5.5, by + 6.5, tw + 5, 16); x.fillStyle = '#000'; x.fillText(lab, bx1 - tw - 3, by + 19);
    }
  }
  function drawSeg() {
    const cvs = $('#mtSegCv'); if (!cvs) return;
    if (!S.seg) { cvs.width = 10; cvs.height = 10; cvs.style.height = '0px'; return; }
    const dpr = devicePixelRatio || 1, W = Math.min(cvs.parentNode.clientWidth || 420, 520);
    cvs.width = W * dpr; cvs.height = W * dpr; cvs.style.width = W + 'px'; cvs.style.height = W + 'px'; const x = cvs.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); segInto(x, W);
  }
  function segAnnotated(W = 480) { if (!S.seg) return null; const c = document.createElement('canvas'); c.width = W; c.height = W; segInto(c.getContext('2d'), W); return c; }

  // ---------- (2) profile ----------
  function edgeProfile() {
    const m = T.metro && T.metro.state; if (!m || !m.ready || !m.ev) return null;
    const i = m.sel, e = m.ev[i], X = m.vbx && m.vbx[i]; if (!e || !X) return null;
    const {A, B, dz} = e.rows, ppm = X.ppmCal, pts = [];
    for (let r = 0; r < A.length; r++) { const xe = e.edge === 'a' ? A[r] - .5 : B[r] + .5; if (Number.isFinite(xe)) pts.push({x: (r + .5) * dz * 1000, y: xe / ppm * 1000}); }
    const y0 = pts.length ? Math.min(...pts.map(p => p.y)) : 0; pts.forEach(p => { p.y -= y0; });
    return pts.length >= 3 ? {pts, label: `F${i + 1} 절삭날 선 (z µm vs 날 위치 µm)`} : null;
  }
  function surfaceProfile() {
    const p = T.surface && T.surface.profile; if (!p || !p.points || p.points.length < 3) return null;
    return {pts: p.points.map(q => ({x: q.sMm * 1000, y: q.measuredMm * 1000})), label: `③ 3D 단면 (${p.part === 'end' ? '끝면' : '측면'}, 측정 높이)`};
  }
  function useSource(src) {
    root.querySelectorAll('[data-psrc]').forEach(b => b.classList.toggle('on', b.dataset.psrc === src));
    if (src === 'file') { $('#mtProfFile').click(); return; }
    const p = src === 'edge' ? edgeProfile() : surfaceProfile();
    if (!p) { S.source = src; S.prof = null; $('#mtProfOut').innerHTML = `<span class="hint">${src === 'edge' ? '3D 생성 후 ④ 측정 결과가 있어야 합니다.' : '③ 3D 화면에서 [Profile] 로 단면 선을 지정하세요.'}</span>`; drawProf(); return; }
    setProfile(p.pts, src, p.label);
  }
  function setProfile(pts, src, label) {
    pts = (pts || []).filter(p => Number.isFinite(p.x) && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
    if (pts.length < 3) { $('#mtProfOut').innerHTML = '<span class="hint">점이 3개 이상인 두 열 데이터 (x µm, 높이 µm) 가 필요합니다.</span>'; return; }
    S.prof = {pts, label: label || (String(src).startsWith('file:') ? '파일: ' + String(src).slice(5) : src)}; S.source = String(src).startsWith('file') ? 'file' : src;
    const span = pts[pts.length - 1].x - pts[0].x, keep = S.segX && S.segX[0] >= pts[0].x - 1e-9 && S.segX[1] <= pts[pts.length - 1].x + 1e-9 && S.segX[1] - S.segX[0] > .01 * span;
    if (!keep) S.segX = E.defaultSegment(pts);
    if (S.pickX != null && (S.pickX < pts[0].x || S.pickX > pts[pts.length - 1].x)) S.pickX = null;
    evalProfile();
  }
  function evalProfile() {
    if (!S.prof) { drawProf(); return; }
    S.res = E.analyzeProfile(S.prof.pts, S.segX, S.pickX);
    $('#mtProfX0').value = f2(S.segX[0]); $('#mtProfX1').value = f2(S.segX[1]); $('#mtProfPx').value = S.pickX == null ? '' : f2(S.pickX);
    const R = S.res, out = $('#mtProfOut');
    out.innerHTML = !R ? '<span class="hint">기준 구간에 점이 2개 이상 있어야 합니다.</span>' : `<div class="mt-kv"><span>원본</span><b>${esc(S.prof.label)} · ${R.n} 점 · x ${f2(R.xRange[0])}–${f2(R.xRange[1])} µm</b>
      <span>기준 직선</span><b>구간 ${f2(R.line.x0)}–${f2(R.line.x1)} µm (${R.line.n} 점, 직교 최소제곱) · 기울기 ${R.line.slope} (${f2(R.line.angleDeg)}°) · 잔차 rms ${f2(R.line.rmsUm)} µm</b>
      <span>[1] 측정점</span><b id="mtProfPick">${R.pick ? `x ${f2(R.pick.x)} µm → 수직 편차 <span class="mt-big">${f2(R.pick.absUm)} µm</span> (${R.pick.devUm < 0 ? '기준선 아래' : '기준선 위'})` : '그래프를 클릭 (측정점 모드) 하거나 “점 µm” 입력'}</b>
      <span>최대 편차</span><b id="mtProfMax">${R.max ? `${f2(R.max.absUm)} µm @ x ${f2(R.max.x)} µm (기준 구간 밖)` : '—'}</b></div>`;
    drawProf();
  }
  // graph model: data -> canvas px. Axes keep µm on both, scaled independently (as the reference instrument plots)
  function model(W, H) {
    const P = S.prof.pts, pad = {l: 58, r: 16, t: 18, b: 30}, xr = [P[0].x, P[P.length - 1].x];
    let ylo = Math.min(...P.map(p => p.y)), yhi = Math.max(...P.map(p => p.y));
    const R = S.res; if (R) { const L = R.L; for (const x of xr) { const y = L.at(x); ylo = Math.min(ylo, y); yhi = Math.max(yhi, y); } }
    const m = .06 * (yhi - ylo || 1); ylo -= m; yhi += m;
    const X = x => pad.l + (x - xr[0]) / (xr[1] - xr[0] || 1) * (W - pad.l - pad.r), Y = y => H - pad.b - (y - ylo) / (yhi - ylo) * (H - pad.t - pad.b);
    const Xi = px => xr[0] + (px - pad.l) / (W - pad.l - pad.r) * (xr[1] - xr[0]);
    return {pad, xr, yr: [ylo, yhi], X, Y, Xi, W, H};
  }
  // draw on a 2D context: dark plot like the reference instrument
  function profInto(x, W, H, light) {
    const g = model(W, H), {X, Y, pad} = g, R = S.res, P = S.prof.pts;
    const bg = light ? '#ffffff' : '#000000', fg = light ? '#1d2330' : '#d8d8d8', grid = light ? '#e3e6ea' : '#2a2a2a', line = light ? '#008c8c' : '#19c3c3';
    x.fillStyle = bg; x.fillRect(0, 0, W, H); x.font = '11px system-ui,sans-serif'; x.lineWidth = 1;
    for (const v of E.ticks(g.yr[0], g.yr[1], 7)) { x.strokeStyle = grid; x.beginPath(); x.moveTo(pad.l, Y(v)); x.lineTo(W - pad.r, Y(v)); x.stroke(); x.fillStyle = fg; x.textAlign = 'right'; x.fillText(v.toFixed(2), pad.l - 5, Y(v) + 4); }
    for (const v of E.ticks(g.xr[0], g.xr[1], 10)) { x.fillStyle = fg; x.textAlign = 'center'; x.fillText(v.toFixed(2), X(v), H - pad.b + 14); x.strokeStyle = fg; x.beginPath(); x.moveTo(X(v), H - pad.b); x.lineTo(X(v), H - pad.b + 3); x.stroke(); }
    x.textAlign = 'left'; x.fillStyle = fg; x.fillText('µm', 4, 12); x.fillText('µm', W - pad.r - 14, H - 4);
    x.strokeStyle = fg; x.strokeRect(pad.l + .5, pad.t + .5, W - pad.l - pad.r, H - pad.t - pad.b);
    x.save(); x.beginPath(); x.rect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b); x.clip();
    x.strokeStyle = line; x.lineWidth = 1.4; x.beginPath(); P.forEach((p, i) => i ? x.lineTo(X(p.x), Y(p.y)) : x.moveTo(X(p.x), Y(p.y))); x.stroke();
    if (R) {
      const L = R.L;
      x.strokeStyle = light ? '#8a8f96' : '#9a9a9a'; x.lineWidth = 1; x.setLineDash([4, 3]); x.beginPath(); x.moveTo(X(g.xr[0]), Y(L.at(g.xr[0]))); x.lineTo(X(g.xr[1]), Y(L.at(g.xr[1]))); x.stroke(); x.setLineDash([]);
      x.strokeStyle = '#ff2020'; x.lineWidth = 3; x.beginPath(); x.moveTo(X(L.x0), Y(L.at(L.x0))); x.lineTo(X(L.x1), Y(L.at(L.x1))); x.stroke();
      const arrow = (d, col, tag) => {
        const ax = X(d.foot[0]), ay = Y(d.foot[1]), bx = X(d.x), by = Y(d.y), ang = Math.atan2(by - ay, bx - ax), head = (px, py, a) => { x.beginPath(); x.moveTo(px, py); x.lineTo(px - 9 * Math.cos(a - .4), py - 9 * Math.sin(a - .4)); x.lineTo(px - 9 * Math.cos(a + .4), py - 9 * Math.sin(a + .4)); x.closePath(); x.fill(); };
        x.strokeStyle = col; x.fillStyle = col; x.lineWidth = 2; x.beginPath(); x.moveTo(ax, ay); x.lineTo(bx, by); x.stroke(); head(bx, by, ang); head(ax, ay, ang + Math.PI);
        x.lineWidth = 1.6; x.beginPath(); x.moveTo(bx - 4, by - 4); x.lineTo(bx + 4, by + 4); x.moveTo(bx + 4, by - 4); x.lineTo(bx - 4, by + 4); x.stroke();
        x.font = '14px system-ui,sans-serif'; x.fillStyle = light ? '#b08800' : '#ffff00'; const lab = `${tag}${f2(d.absUm)}µm`, mx = (ax + bx) / 2 + 8, my = (ay + by) / 2;
        x.fillText(lab, Math.min(mx, W - pad.r - x.measureText(lab).width - 2), my);
      };
      if (R.max && (!R.pick || Math.abs(R.max.x - R.pick.x) > 1e-6)) arrow(R.max, '#ff9a20', '[max]');
      if (R.pick) arrow(R.pick, '#ff2020', '[1]');
    }
    x.restore();
  }
  function drawProf() {
    const cvs = $('#mtProfCv'); if (!cvs) return;
    if (!S.prof) { cvs.width = 10; cvs.height = 10; cvs.style.height = '0px'; return; }
    const dpr = devicePixelRatio || 1, W = Math.max(320, cvs.parentNode.clientWidth || 640), H = Math.round(Math.min(360, Math.max(220, W * .36)));
    cvs.width = W * dpr; cvs.height = H * dpr; cvs.style.width = W + 'px'; cvs.style.height = H + 'px'; S.gW = W; S.gH = H;
    const x = cvs.getContext('2d'); x.setTransform(dpr, 0, 0, dpr, 0, 0); profInto(x, W, H, false);
    if (S.drag) { const g = model(W, H); x.fillStyle = 'rgba(255,40,40,.18)'; x.fillRect(g.X(Math.min(S.drag[0], S.drag[1])), g.pad.t, Math.abs(g.X(S.drag[1]) - g.X(S.drag[0])), H - g.pad.t - g.pad.b); }
  }
  function graphPointer() {
    const cvs = $('#mtProfCv'), xAt = e => { const r = cvs.getBoundingClientRect(), g = model(S.gW, S.gH); return Math.max(g.xr[0], Math.min(g.xr[1], g.Xi(e.clientX - r.left))); };
    cvs.addEventListener('pointerdown', e => { if (!S.prof) return; cvs.setPointerCapture(e.pointerId); if (S.mode === 'seg') { const v = xAt(e); S.drag = [v, v]; drawProf(); } else { S.pickX = xAt(e); evalProfile(); } });
    cvs.addEventListener('pointermove', e => { if (!S.drag) return; S.drag[1] = xAt(e); drawProf(); });
    cvs.addEventListener('pointerup', () => { if (!S.drag) return; const [a, b] = S.drag; S.drag = null; if (Math.abs(b - a) > 1e-6) S.segX = [Math.min(a, b), Math.max(a, b)]; evalProfile(); });
  }
  function profAnnotated(W = 760, H = 270, light = true) { if (!S.prof) return null; const c = document.createElement('canvas'); c.width = W; c.height = H; profInto(c.getContext('2d'), W, H, light); return c; }

  // ---------- report hooks ----------
  const summary = () => ({endSeg: S.seg ? {teeth: S.seg.teeth, total: S.seg.total, circle: S.seg.circle, scale: S.seg.scale, bar: S.seg.bar, k: S.seg.k, src: S.seg.src} : null,
    profile: S.prof && S.res ? {label: S.prof.label, pts: S.prof.pts, res: {line: S.res.line, pick: S.res.pick, max: S.res.max, n: S.res.n}} : null});
  function csv() { return E.csvSections(summary()); }
  function html() {
    const s = summary(), url = c => c ? c.toDataURL('image/jpeg', .9) : '';
    if (!s.endSeg && !s.profile) return '';
    let h = '';
    if (s.endSeg) {
      const a = s.endSeg, c = segAnnotated(440);
      h += `<h2 class="pb">End-face segmentation (top view)</h2><div class="row"><div style="flex:0 0 240px"><figure><img src="${url(c)}"><figcaption>Fitted outer circle, tooth faces, scale bar</figcaption></figure></div><div>
<table><tr><th>Tooth</th><th>at</th><th>area mm²</th><th>area px</th><th>% of disc</th><th>r max mm</th></tr>${a.teeth.map(t => `<tr><td>T${t.tooth}</td><td>${Math.round(t.angleDeg)}°</td><td><b>${f3(t.areaMm2)}</b></td><td>${t.areaPx}</td><td>${f2(t.pctOfDisc)}</td><td>${f3(t.rMaxMm)}</td></tr>`).join('')}
<tr><td><b>Total</b></td><td></td><td><b>${f3(a.total.areaMm2)}</b></td><td>${a.total.areaPx}</td><td>${f2(a.total.pctOfDisc)}</td><td></td></tr></table>
<p class="note">Circle r ${f1(a.circle.rPx)} px (rms ${f2(a.circle.rmsPx)} px) · scale ${a.scale.pxPerMm ? f2(a.scale.pxPerMm) + ' px/mm' : '-'} from ${a.scale.method === 'bar' ? `scale bar ${a.scale.barUm} µm` : a.scale.method === 'diameter' ? `diameter Ø${a.scale.diameterInputMm} mm` : 'none'} · Ø ${f3(a.scale.diameterMm)} mm.</p></div></div>`;
    }
    if (s.profile) {
      const R = s.profile.res, c = profAnnotated(760, 270, true);
      h += `<h2>Profile and reference-line deviation</h2><figure><img src="${url(c)}" style="width:100%"><figcaption>${esc(s.profile.label)} · red = fitted reference, dashed = extension, arrow = perpendicular deviation</figcaption></figure>
<table><tr><th>Item</th><th>x µm</th><th>deviation µm</th></tr><tr><td>Reference segment (${R.line.n} pts, rms ${f2(R.line.rmsUm)} µm, slope ${R.line.slope})</td><td>${f2(R.line.x0)}–${f2(R.line.x1)}</td><td></td></tr>
${R.pick ? `<tr><td><b>[1] picked point</b></td><td>${f2(R.pick.x)}</td><td><b>${f2(R.pick.absUm)}</b></td></tr>` : ''}${R.max ? `<tr><td>maximum (outside the segment)</td><td>${f2(R.max.x)}</td><td>${f2(R.max.absUm)}</td></tr>` : ''}</table>`;
    }
    return h;
  }
  // PDF page (metro-core PdfPage): ASCII text only (um, mm2)
  function pdfPage() {
    const s = summary(), M = T.metroCore; if (!M || (!s.endSeg && !s.profile)) return null;
    const jpeg = c => { const b = atob(c.toDataURL('image/jpeg', .9).split(',')[1]), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
    const P = M.PdfPage(), L = 36, R = P.W - 36; let y = 40;
    P.rect(L, y - 14, R - L, 22, '#1f2a36'); P.text(L + 8, y + 1, 'End-face segmentation and profile deviation', 12, {bold: true, color: '#ffffff'}); y += 26;
    if (s.endSeg) {
      const a = s.endSeg, c = segAnnotated(480), sz = 220;
      P.text(L, y, 'End-face segmentation (top view)', 10, {bold: true}); y += 8;
      P.image(jpeg(c), c.width, c.height, L, y, sz, sz);
      let ty = y + 10; const tx = L + sz + 14, col = [tx, tx + 50, tx + 100, tx + 170, tx + 240];
      ['Tooth', 'at deg', 'area mm2', 'area px', '% disc'].forEach((h, i) => P.text(col[i], ty, h, 8, {bold: true})); ty += 12;
      for (const t of a.teeth) { [`T${t.tooth}`, String(Math.round(t.angleDeg)), f3(t.areaMm2), String(t.areaPx), f2(t.pctOfDisc)].forEach((v, i) => P.text(col[i], ty, v, 8.5, {bold: i === 2})); ty += 11; }
      ['Total', '', f3(a.total.areaMm2), String(a.total.areaPx), f2(a.total.pctOfDisc)].forEach((v, i) => P.text(col[i], ty, v, 8.5, {bold: true})); ty += 16;
      P.text(tx, ty, `Circle r ${f1(a.circle.rPx)} px, rms ${f2(a.circle.rmsPx)} px`, 8); ty += 11;
      P.text(tx, ty, `Scale ${a.scale.pxPerMm ? f2(a.scale.pxPerMm) + ' px/mm' : '-'} (${a.scale.method === 'bar' ? 'scale bar ' + a.scale.barUm + ' um' : a.scale.method === 'diameter' ? 'diameter ' + a.scale.diameterInputMm + ' mm' : 'none'})`, 8); ty += 11;
      P.text(tx, ty, `Diameter ${f3(a.scale.diameterMm)} mm`, 8);
      y += sz + 18;
    }
    if (s.profile) {
      const Rz = s.profile.res, c = profAnnotated(760, 270, true), w = R - L, h = w * 270 / 760;
      P.text(L, y, 'Profile and reference-line deviation (um vs um)', 10, {bold: true}); y += 8;
      P.image(jpeg(c), c.width, c.height, L, y, w, h); y += h + 14;
      P.text(L, y, `Reference: ${f2(Rz.line.x0)} - ${f2(Rz.line.x1)} um, ${Rz.line.n} points, orthogonal least squares, slope ${Rz.line.slope}, rms ${f2(Rz.line.rmsUm)} um`, 8.5); y += 12;
      if (Rz.pick) { P.text(L, y, `[1] picked point x ${f2(Rz.pick.x)} um: perpendicular deviation ${f2(Rz.pick.absUm)} um`, 9.5, {bold: true}); y += 12; }
      if (Rz.max) { P.text(L, y, `Maximum outside the segment: ${f2(Rz.max.absUm)} um at x ${f2(Rz.max.x)} um`, 8.5); y += 12; }
      P.text(L, y, `Source: ${String(s.profile.label).replace(/[^\x20-\x7e]/g, '')}`, 7.5, {color: '#445566'});
    }
    return P;
  }

  T.endProfileReport = {csv, html, pdfPage, summary};
  T.metroEPui = {
    get state() { return S; }, build, setImage, setProfile, useSource, summary, segAnnotated, profAnnotated,
    setOptions(o) { Object.assign(S.opt, o); if (o.diameterMm != null) $('#mtSegD').value = o.diameterMm; if (o.k != null) $('#mtSegK').value = o.k; if (o.barUm != null) $('#mtSegBar').value = o.barUm; if (o.scale) $('#mtSegScale').value = o.scale; runSeg(); },
    setSegment(x0, x1) { S.segX = [Math.min(x0, x1), Math.max(x0, x1)]; evalProfile(); },
    pick(x) { S.pickX = x; evalProfile(); },
    graphClient(x, y) { const c = $('#mtProfCv'), r = c.getBoundingClientRect(), g = model(S.gW, S.gH); return [r.left + g.X(x), r.top + (y == null ? (g.pad.t + S.gH - g.pad.b) / 2 : g.Y(y))]; }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
