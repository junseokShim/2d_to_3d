/* Tool3D section ④ card: close-up flank wear VB (needs js/wear/edge-vb.js).
 * For a high-magnification photo of one cutting edge with a scale bar burned in (the tool diameter is not in the frame):
 * the scale comes from the bar (its length in µm is typed, 100 µm by default) or a typed µm/px; the reference line is fitted
 * on the unworn edge (dotted), VB dimension lines run from it to the wear front with their values, VBmax is marked, and the
 * edge deviation (real edge outside / inside the reference line) is reported. Low confidence shows 'not detected, operator
 * needed', never a number. Whole-tool photos keep the existing path (metro-ui.js); a run photo that carries a scale bar is
 * also measured here (wear flow).
 * Registers Tool3D.closeupReport {csv, html, pdfPage, summary} (metro-report.js adds them) and Tool3D.metroCU (test hooks).
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, MAXPX = 2400, VIEW = 960;
  const $ = (s, r = document) => r.querySelector(s);
  const f1 = v => v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(1), f2 = v => v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(2), f4 = v => v == null || Number.isNaN(+v) ? '—' : (+v).toFixed(4);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
  const S = {img: null, src: null, res: null, lines: [], opt: {barUm: 100, umPerPx: ''}, nLines: 5};
  const MSG = {'no-scale': '배율 없음: 사진에 스케일바가 없습니다. µm/px 를 입력하세요.', 'not-detected': '검출 안 됨 · 작업자 확인 필요', 'no-wear': '마모 없음 (20 µm 이상인 마모대 없음)'};
  let root, built = false;

  function build() {
    const host = $('#metro'); if (!host || !(T.wear && T.wear.edgeVb)) return false;
    if (built) return true;
    built = true;
    root = document.createElement('div'); root.id = 'mtCU'; root.className = 'mt-ep';
    root.innerHTML = `
<div class="mt-card" id="mtCuCard"><div class="mt-h">근접 사진 VB · Close-up flank wear <small>스케일바 배율 · 기준선(점선) · VB 치수선 · 최대값</small></div>
  <div class="mt-row mt-epbar">
    <label class="mt-up">근접(고배율) 사진 <input type="file" id="mtCuFile" accept="image/*"></label>
    <label title="사진 속 스케일바의 길이">스케일바 µm <input id="mtCuBar" type="number" step="1" min="0" value="100"></label>
    <label title="비우면 스케일바에서 자동">µm/px <input id="mtCuUmpx" type="number" step="0.0001" min="0" placeholder="자동"></label>
    <label>치수선 <input id="mtCuN" type="number" step="1" min="1" max="12" value="5"></label>
  </div>
  <div class="mt-epimg mt-cuimg"><canvas id="mtCuCv" width="10" height="10"></canvas></div>
  <div id="mtCuOut" class="hint">절삭날 근접 사진(스케일바 포함)을 올리면 VB 를 측정합니다. 전체 공구 사진은 위 측정 패널을 사용합니다.</div>
</div>`;
    const ep = $('#mtEP'); if (ep) host.insertBefore(root, ep); else host.appendChild(root);
    $('#mtCuFile').onchange = e => { const f = e.target.files && e.target.files[0]; if (f) loadFile(f); };
    const re = () => { const b = $('#mtCuBar').value, u = $('#mtCuUmpx').value; S.opt = {barUm: b === '' ? 100 : +b, umPerPx: u === '' ? '' : +u}; S.nLines = Math.max(1, Math.min(12, +$('#mtCuN').value || 5)); run(); };
    ['mtCuBar', 'mtCuUmpx', 'mtCuN'].forEach(id => $('#' + id).addEventListener('change', re));
    addEventListener('tool3d:metro', fromRun);
    return true;
  }
  const toData = (src, w0, h0) => {
    const k = Math.min(1, MAXPX / Math.max(w0, h0)), w = Math.round(w0 * k), h = Math.round(h0 * k), c = document.createElement('canvas');
    c.width = w; c.height = h; const x = c.getContext('2d'); x.drawImage(src, 0, 0, w, h); return {data: x.getImageData(0, 0, w, h), k};
  };
  function loadFile(f) {
    const url = URL.createObjectURL(f), im = new Image();
    im.onload = () => { const d = toData(im, im.width, im.height); URL.revokeObjectURL(url); setImage(d.data, 'upload:' + f.name, d.k); };
    im.src = url;
  }
  // wear flow: the run's side photos that carry a scale bar are close-ups; the first one is measured here (an upload wins)
  function fromRun() {
    const m = T.metro && T.metro.state, shots = m && m.shots || [];
    if ((S.src && !/^run/.test(S.src)) || shots === S.runShots) return;   // an upload wins; each run is checked once
    S.runShots = shots;
    for (let i = 0; i < shots.length; i++) {
      const s = shots[i]; if (!s) continue;
      const d = toData(s, s.naturalWidth || s.width, s.naturalHeight || s.height);
      if (T.wear.edgeVb.detectScaleBar(d.data)) { setImage(d.data, 'run:F' + (i + 1), d.k); return; }
    }
  }
  function setImage(img, src, k) { S.img = img; S.src = src; S.k = k || 1; run(); }
  function run() {
    if (!S.img) return;
    const o = {scaleBarUm: S.opt.barUm > 0 ? S.opt.barUm : 100};
    if (S.opt.umPerPx > 0) o.umPerPx = S.opt.umPerPx / S.k;   // typed for the original photo; the working copy may be reduced
    const r = T.wear.edgeVb.measure(S.img, o);
    S.res = r; S.lines = r.status === 'ok' ? dimLines(r, S.nLines) : []; S.cv = null;
    render(); window.dispatchEvent(new CustomEvent('tool3d:closeup', {detail: summary()}));
  }
  // VB dimension lines: the maximum plus n evenly spaced positions over the worn stretch; image px of reference + front
  function dimLines(r, n) {
    const [x0, y0] = r.edge.p0, [x1, y1] = r.edge.p1, L = Math.hypot(x1 - x0, y1 - y0), tx = (x1 - x0) / L, ty = (y1 - y0) / L, [nx, ny] = r.edge.normal, u = r.umPerPx;
    const at = (q, tag) => { const s = q.uUm / u, ax = x0 + tx * s, ay = y0 + ty * s, d = q.vbUm / u; return {tag, uUm: q.uUm, vbUm: q.vbUm, a: [ax, ay], b: [ax + nx * d, ay + ny * d]}; };
    const worn = r.profile.filter(q => q.vbUm > 0), out = [];
    if (worn.length) {
      const u0 = worn[0].uUm, u1 = worn[worn.length - 1].uUm;
      for (let i = 0; i < n; i++) {
        const uu = u0 + (u1 - u0) * (i + .5) / n; let best = null;
        for (const q of worn) if (!best || Math.abs(q.uUm - uu) < Math.abs(best.uUm - uu)) best = q;
        if (best && !out.some(l => l.uUm === best.uUm)) out.push(at(best, String(out.length + 1)));
      }
    }
    const mq = r.profile.find(q => Math.abs(q.uUm - r.max.uUm) < 1e-6) || {uUm: r.max.uUm, vbUm: r.vbMaxUm};
    out.push(at(mq, 'max'));
    return out;
  }
  function render() {
    const out = $('#mtCuOut'), r = S.res; if (!out || !r) return;
    const src = esc(/^run/.test(S.src) ? '3D 실행의 측면 사진 ' + S.src.slice(4) : String(S.src).replace(/^upload:/, '업로드: '));
    const scale = r.umPerPx ? `${f4(r.umPerPx * S.k)} µm/px (원본) · ${r.scaleFrom === 'scale-bar' ? `스케일바 ${S.opt.barUm} µm = ${r.scaleBar.px} px` : '입력값'}` : '—';
    if (r.status !== 'ok' && r.status !== 'no-wear') {
      out.innerHTML = `<div class="mt-cumsg mt-ng" id="mtCuStatus" data-status="${r.status}"><b>${MSG[r.status] || r.status}</b><br><small>${esc(r.reason || '')}</small></div><div class="mt-kv"><span>배율</span><b>${scale}</b><span>원본</span><b>${src}</b></div>`;
      draw(); return;
    }
    const rows = S.lines.map(l => `<tr${l.tag === 'max' ? ' class="mt-max"' : ''}><td><b>${l.tag === 'max' ? 'VBmax' : '[' + l.tag + ']'}</b></td><td>${f1(l.uUm)}</td><td><b>${f2(l.vbUm)}</b></td></tr>`).join('');
    out.innerHTML = `<div class="mt-cumsg" id="mtCuStatus" data-status="${r.status}"><b id="mtCuVb">VBmax ${f2(r.vbMaxUm)} µm</b> · VB 평균 ${f2(r.vbMeanUm)} µm · 마모 길이 ${f1(r.wornLengthUm)} µm (${f1(r.wornPct)} %)</div>
      ${rows ? `<table class="mt-tab"><tr><th>치수</th><th>날 따라 µm</th><th>VB µm</th></tr>${rows}</table>` : ''}
      <div class="mt-kv"><span>배율</span><b>${scale}</b>
      <span>기준선</span><b>미마모 절삭날 직선 맞춤 · 잔차 ${f2(r.edge.rmsUm)} µm · 맞춤 비율 ${Math.round(100 * r.edge.fitShare)} %</b>
      <span>날 편차</span><b>바깥 최대 ${f1(r.edgeDevOutUm)} µm · 안쪽 최대 ${f1(r.edgeDevInUm)} µm (기준선 대비 실제 날)</b>
      <span>원본</span><b>${src}</b></div>`;
    draw();
  }
  // annotated image: photo, reference line (dotted), wear front, VB dimension lines with values, VBmax, scale bar
  function annotate(x, W) {
    const img = S.img, r = S.res, s = W / img.width, H = Math.round(img.height * s);
    const c0 = document.createElement('canvas'); c0.width = img.width; c0.height = img.height; c0.getContext('2d').putImageData(img, 0, 0);
    x.drawImage(c0, 0, 0, W, H);
    if (!r || !r.edge) return H;
    const P = p => [p[0] * s, p[1] * s], lw = Math.max(1.2, W / 600);
    const [a, b] = [P(r.edge.p0), P(r.edge.p1)];
    x.save(); x.strokeStyle = '#7dff7d'; x.lineWidth = lw * 1.3; x.setLineDash([lw * 1.5, lw * 3]);
    x.beginPath(); x.moveTo(a[0], a[1]); x.lineTo(b[0], b[1]); x.stroke(); x.restore();
    if (r.status === 'ok') {
      const [x0, y0] = r.edge.p0, [x1, y1] = r.edge.p1, L = Math.hypot(x1 - x0, y1 - y0), tx = (x1 - x0) / L, ty = (y1 - y0) / L, [nx, ny] = r.edge.normal;
      x.strokeStyle = '#ffd400'; x.lineWidth = lw; x.beginPath(); let pen = false;
      for (const q of r.profile) {
        if (!(q.vbUm > 0)) { pen = false; continue; }
        const t = q.uUm / r.umPerPx, d = q.vbUm / r.umPerPx, p = P([x0 + tx * t + nx * d, y0 + ty * t + ny * d]);
        if (pen) x.lineTo(p[0], p[1]); else x.moveTo(p[0], p[1]); pen = true;
      }
      x.stroke();
      const fs = Math.max(11, Math.round(W / 70));
      x.font = `bold ${fs}px sans-serif`;
      for (const l of S.lines) {
        const A = P(l.a), B = P(l.b), mx = l.tag === 'max';
        x.strokeStyle = x.fillStyle = mx ? '#ff2a2a' : '#ff6a3d'; x.lineWidth = lw * (mx ? 2 : 1.4);
        x.beginPath(); x.moveTo(A[0], A[1]); x.lineTo(B[0], B[1]); x.stroke();
        for (const [p, q] of [[A, B], [B, A]]) { const ang = Math.atan2(q[1] - p[1], q[0] - p[0]), h = lw * 5; x.beginPath(); x.moveTo(p[0], p[1]); x.lineTo(p[0] + h * Math.cos(ang - .45), p[1] + h * Math.sin(ang - .45)); x.lineTo(p[0] + h * Math.cos(ang + .45), p[1] + h * Math.sin(ang + .45)); x.closePath(); x.fill(); }
        const t = `${mx ? 'VBmax' : '[' + l.tag + ']'} ${f2(l.vbUm)} µm`, tw = x.measureText(t).width, lx = Math.min(W - tw - 6, Math.max(4, B[0] + 6)), ly = Math.max(fs + 2, B[1] - 6);
        x.fillStyle = 'rgba(255,255,255,.9)'; x.fillRect(lx - 3, ly - fs, tw + 6, fs + 5); x.fillStyle = '#111'; x.fillText(t, lx, ly);
      }
    }
    if (!r.umPerPx) return H;
    // our scale bar (bottom-left) in the units of the typed / detected scale
    const umPx = r.umPerPx * (img.width / W), steps = [10, 20, 25, 50, 100, 200, 250, 500, 1000];
    let um = steps[0]; for (const v of steps) if (v / umPx <= W * .2) um = v;
    const bw = um / umPx, fs2 = Math.max(10, Math.round(W / 80));
    x.fillStyle = 'rgba(0,0,0,.55)'; x.fillRect(8, H - 14 - fs2 - 10, bw + 16, fs2 + 20);
    x.fillStyle = '#fff'; x.fillRect(16, H - 18, bw, Math.max(3, lw * 2)); x.font = `${fs2}px sans-serif`; x.fillText(`${um} µm`, 16, H - 22);
    return H;
  }
  function draw() {
    const c = $('#mtCuCv'); if (!c || !S.img) return;
    const W = Math.min(VIEW, S.img.width); c.width = W; c.height = Math.round(S.img.height * W / S.img.width); annotate(c.getContext('2d'), W);
  }
  function annotated(W = 760) { if (!S.img) return null; const c = document.createElement('canvas'); c.width = W; c.height = Math.round(S.img.height * W / S.img.width); annotate(c.getContext('2d'), W); return c; }

  // ---------- report ----------
  function summary() {
    const r = S.res; if (!r) return null;
    return {src: S.src, status: r.status, reason: r.reason || '', vbMaxUm: r.vbMaxUm, vbMeanUm: r.vbMeanUm, wornLengthUm: r.wornLengthUm, umPerPx: r.umPerPx && r.umPerPx * S.k, scaleFrom: r.scaleFrom,
      barUm: S.opt.barUm, edgeRmsUm: r.edge && r.edge.rmsUm, edgeDevOutUm: r.edgeDevOutUm, edgeDevInUm: r.edgeDevInUm, lines: S.lines.map(l => ({tag: l.tag, uUm: l.uUm, vbUm: l.vbUm}))};
  }
  function csv() {
    const s = summary(); if (!s) return '';
    const N = String.fromCharCode(13, 10), q = v => v == null ? '' : v;
    let t = N + '[close-up VB]' + N + 'status,VBmax_um,VB_mean_um,worn_length_um,um_per_px,scale_from,edge_rms_um,edge_dev_out_um,edge_dev_in_um' + N +
      [s.status, q(s.vbMaxUm), q(s.vbMeanUm), q(s.wornLengthUm), s.umPerPx ? s.umPerPx.toFixed(5) : '', q(s.scaleFrom), q(s.edgeRmsUm), q(s.edgeDevOutUm), q(s.edgeDevInUm)].join(',') + N;
    if (s.lines.length) t += 'line,along_edge_um,VB_um' + N + s.lines.map(l => [l.tag, l.uUm, l.vbUm].join(',')).join(N) + N;
    return t;
  }
  function html() {
    const s = summary(); if (!s) return '';
    const c = annotated(760), ok = s.status === 'ok' || s.status === 'no-wear';
    return `<h2 class="pb">Close-up flank wear VB</h2><figure><img src="${c ? c.toDataURL('image/jpeg', .9) : ''}" style="width:100%"><figcaption>Dotted = reference line on the unworn edge, yellow = wear front, red = VB dimension lines</figcaption></figure>
${ok ? `<table><tr><th>Item</th><th>along edge µm</th><th>VB µm</th></tr>${s.lines.map(l => `<tr><td>${l.tag === 'max' ? '<b>VBmax</b>' : '[' + l.tag + ']'}</td><td>${f1(l.uUm)}</td><td><b>${f2(l.vbUm)}</b></td></tr>`).join('')}</table>
<p class="note">VBmax ${f2(s.vbMaxUm)} µm · VB mean ${f2(s.vbMeanUm)} µm · scale ${f4(s.umPerPx)} µm/px (${s.scaleFrom === 'scale-bar' ? 'scale bar ' + s.barUm + ' µm' : 'typed'}) · edge deviation out ${f1(s.edgeDevOutUm)} / in ${f1(s.edgeDevInUm)} µm</p>`
    : `<p class="note"><b>Not detected: operator needed</b> (${esc(s.reason)})</p>`}`;
  }
  function pdfPage() {
    const s = summary(), M = T.metroCore; if (!s || !M) return null;
    const c = annotated(760), b = atob(c.toDataURL('image/jpeg', .9).split(',')[1]), u8 = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u8[i] = b.charCodeAt(i);
    const P = M.PdfPage(), L = 36, R = P.W - 36, w = R - L, h = w * c.height / c.width; let y = 40;
    P.rect(L, y - 14, w, 22, '#1f2a36'); P.text(L + 8, y + 1, 'Close-up flank wear VB', 12, {bold: true, color: '#ffffff'}); y += 26;
    P.image(u8, c.width, c.height, L, y, w, h); y += h + 16;
    if (s.status === 'ok' || s.status === 'no-wear') {
      P.text(L, y, `VBmax ${f2(s.vbMaxUm)} um   VB mean ${f2(s.vbMeanUm)} um   worn length ${f1(s.wornLengthUm)} um`, 10, {bold: true}); y += 14;
      for (const l of s.lines) { P.text(L, y, `${l.tag === 'max' ? 'VBmax' : '[' + l.tag + ']'}  at ${f1(l.uUm)} um along the edge: ${f2(l.vbUm)} um`, 8.5); y += 11; }
      P.text(L, y + 4, `Scale ${f4(s.umPerPx)} um/px (${s.scaleFrom === 'scale-bar' ? 'scale bar ' + s.barUm + ' um' : 'typed'}), reference line rms ${f2(s.edgeRmsUm)} um, edge deviation out ${f1(s.edgeDevOutUm)} / in ${f1(s.edgeDevInUm)} um`, 8);
    } else P.text(L, y, `Not detected: operator needed (${String(s.reason).replace(/[^\x20-\x7e]/g, '')})`, 10, {bold: true, color: '#c0392b'});
    return P;
  }

  T.closeupReport = {csv, html, pdfPage, summary};
  T.metroCU = {get state() { return S; }, build, setImage, run, summary, annotated,
    setOptions(o) { if (o.barUm != null) $('#mtCuBar').value = o.barUm; if (o.umPerPx != null) $('#mtCuUmpx').value = o.umPerPx; $('#mtCuBar').dispatchEvent(new Event('change')); }};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build); else build();
})();
