/* Tool3D metrology report: one-page PDF (own writer, metro-core PdfPage), printable HTML and CSV.
 * Content: tool info, operator/date, overall decision, VB table (value ± U, k=2), strip images with overlays,
 * VB(z) profile chart, 3D snapshot, uncertainty budget, calibration, manual measurements.
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, M = T.metroCore;
  const f3 = v => v == null ? '-' : (+v).toFixed(3), pad = n => String(n).padStart(2, '0');
  const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fileStamp = () => stamp().replace(/[: ]/g, '').replace(/-/g, '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
  function save(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); }
  const ready = () => T.metro && T.metro.state.ready;
  const safeId = () => (T.metro.state.prefs.toolId || 'tool').replace(/[^\w.-]+/g, '_');

  // strip of one flute with the corrected band + edge lines, cropped to the evaluated zone
  function overlay(i, maxH = 900) {
    const S = T.metro.state, F = S.F[i], e = S.ev[i]; if (!F || !e) return null;
    const src = T.metro.stripImage(i), y0 = Math.max(0, F.strip.top - 6), y1 = Math.min(src.height, F.strip.top + F.n + 6), k = Math.min(1, maxH / (y1 - y0));
    const c = Object.assign(document.createElement('canvas'), {width: Math.round(src.width * k), height: Math.round((y1 - y0) * k)}), x = c.getContext('2d');
    x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height); x.scale(k, k); x.translate(0, -y0); x.drawImage(src, 0, 0);
    const {A, B, vb} = e.rows, top = F.strip.top;
    x.fillStyle = 'rgba(255,40,40,.45)'; for (let r = 0; r < F.n; r++) if (vb[r] > 0) x.fillRect(A[r] - .5, top + r, B[r] - A[r] + 1, 1);
    const line = (side, col) => { x.strokeStyle = col; x.lineWidth = 1.5 / k; x.beginPath(); for (let r = 0; r < F.n; r++) { const px = side === 'a' ? A[r] - .5 : B[r] + .5; r ? x.lineTo(px, top + r + .5) : x.moveTo(px, top + r + .5); } x.stroke(); };
    line(F.edge, '#00b8e6'); line(F.edge === 'a' ? 'b' : 'a', '#e6c000');
    return c;
  }
  function snapshot3d() {
    const g = document.querySelector('#tool3d-view canvas') || document.querySelector('#gl'); if (!g || !g.width) return null;
    const s = Math.min(1, 900 / g.width), c = Object.assign(document.createElement('canvas'), {width: Math.round(g.width * s), height: Math.round(g.height * s)}), x = c.getContext('2d');
    x.fillStyle = '#20242c'; x.fillRect(0, 0, c.width, c.height); try { x.drawImage(g, 0, 0, c.width, c.height); } catch (e) { return null; }
    return c;
  }
  const jpeg = c => { const b = atob(c.toDataURL('image/jpeg', .88).split(',')[1]), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  function data() {
    const s = T.metro.summary(); s.date = stamp();
    s.flutes = s.flutes.map(e => e || {q: {vbMax: {v: 0, U: 0}, vbAvg: {v: 0, U: 0}, vbb: {v: 0, U: 0}, vbbMax: {v: 0, U: 0}, vbc: {v: 0, U: 0}, vbn: {v: 0, U: 0}}, profile: [], status: {decision: 'n/a', light: 'amber'}, failed: true});
    return s;
  }
  const DEC = {conform: 'CONFORM', nonconform: 'NONCONFORM', indeterminate: 'INDETERMINATE', 'n/a': 'N/A'};
  const METHOD = 'U = k*u_c, k = 2 (~95 %). u_c = RSS of: scale (diameter tolerance / reference target, silhouette edge localisation, side-to-side spread), ' +
    'edge localisation sqrt(2)*sigma/(px/mm) (sigma 0.5 px auto, 1 px manual), repeatability (local scatter at VBmax; std. error for averages), helix angle +-2 deg. ' +
    'Decision rule ISO 14253-1: conform if VB+U < limit, nonconform if VB-U > limit, otherwise indeterminate.';

  // ---------- PDF ----------
  function pdf() {
    if (!ready()) return null;
    const d = data(), P = M.PdfPage(), W = P.W, L = 36, R = W - 36, S = T.metro.state, light = {green: '#1e9e4a', amber: '#e0a100', red: '#d0342c'};
    // header
    P.rect(0, 0, W, 62, '#1f2a36'); P.text(L, 26, 'Tool wear inspection report', 16, {bold: true, color: '#ffffff'});
    P.text(L, 44, 'Peripheral flank wear VB - ISO 8688-2 / ISO 3685 - photo-based measurement', 9, {color: '#c8d2dc'});
    const ov = d.overall || {light: 'amber', decision: 'n/a'};
    P.rect(R - 150, 14, 150, 34, light[ov.light]); P.text(R - 75, 30, (T.metro.LBL[ov.light] || '-') + ' - ' + DEC[ov.decision], 10, {bold: true, color: '#ffffff', align: 'center'});
    P.text(R - 75, 42, 'VBmax ' + f3(d.vbMax && d.vbMax.v) + ' +- ' + f3(d.vbMax && d.vbMax.U) + ' mm', 8, {color: '#ffffff', align: 'center'});
    // info grid
    let y = 80; const info = [['Tool ID', d.toolId], ['Operator', d.operator || '-'], ['Date', d.date], ['Diameter', 'D ' + d.D + ' mm'], ['Flutes', d.k], ['Helix', (+d.helixDeg).toFixed(1) + ' deg'],
      ['Engine', d.engine || '-'], ['Scale', d.calib.pxPerMm.toFixed(2) + ' +- ' + d.calib.U_pxPerMm.toFixed(2) + ' px/mm (' + d.calib.method + ')'], ['Limit VB', f3(d.limitMm) + ' mm (warn ' + Math.round(d.warnFrac * 100) + ' %)']];
    info.forEach(([k, v], i) => { const cx = L + (i % 3) * 176, cy = y + Math.floor(i / 3) * 14; P.text(cx, cy, k, 7.5, {color: '#667788'}); P.text(cx + 50, cy, String(v), 8.5, {bold: i === 0}); });
    y += 48;
    // VB table
    const cols = [['Flute', 34], ['VBmax', 70], ['VBB avg', 70], ['VBC corner', 70], ['VBN notch', 70], ['Area mm2', 50], ['Vol. mm3', 52], ['Decision', 107]];
    P.rect(L, y - 10, R - L, 14, '#e8edf2'); let x = L + 4; cols.forEach(([h, w]) => { P.text(x, y, h, 8, {bold: true}); x += w; }); y += 14;
    d.flutes.forEach((e, i) => {
      const q = e.q, cells = ['F' + (i + 1) + (e.edited ? '*' : '') + ({'operator-assisted': ' (OA)', 'awaiting-operator': ' (unconfirmed)'}[e.mode] || ''), f3(q.vbMax.v) + ' +- ' + f3(q.vbMax.U), f3(q.vbb.v) + ' +- ' + f3(q.vbb.U), f3(q.vbc.v) + ' +- ' + f3(q.vbc.U), f3(q.vbn.v) + ' +- ' + f3(q.vbn.U),
        e.failed ? '-' : e.areaMm2.toFixed(3), e.failed ? '-' : e.volumeMm3.toFixed(4), e.failed ? 'not measured' : DEC[e.status.decision]];
      x = L + 4; cells.forEach((c, j) => { P.text(x, y, c, 8.5, {bold: j === 1}); x += cols[j][1]; });
      P.rect(R - 12, y - 7, 8, 8, light[e.status.light]); P.line(L, y + 4, R, y + 4, .3, '#d5d9e0'); y += 14;
    });
    P.text(L, y + 2, 'mm, value +- U (k=2). * = edge/band corrected by the operator. Zones: C = 0..' + f3(d.flutes[0].zones && d.flutes[0].zones.cornerMm) + ' mm from tip, N = ap ' + f3(d.flutes[0].zones && d.flutes[0].zones.apMm) + ' +- ' + f3(d.flutes[0].zones && d.flutes[0].zones.notchHalfMm) + ' mm, B = rest.', 7, {color: '#667788'});
    y += 16;
    // images: strips + 3D snapshot
    const imgH = 190, strips = d.flutes.map((_, i) => overlay(i)).filter(Boolean), snap = snapshot3d();
    let ix = L;
    strips.forEach((c, i) => { const w = Math.min(70, c.width / c.height * imgH); P.image(jpeg(c), c.width, c.height, ix, y, w, imgH); P.text(ix + w / 2, y + imgH + 10, 'F' + (i + 1), 8, {align: 'center'}); ix += w + 6; });
    if (snap) { const w = Math.min(R - ix, snap.width / snap.height * imgH), h = w * snap.height / snap.width; P.image(jpeg(snap), snap.width, snap.height, R - w, y, w, h); P.text(R - w / 2, y + h + 10, '3D model with mapped wear', 8, {align: 'center'}); }
    y += imgH + 24;
    // chart
    const cw = R - L, ch = 170, m = T.metro.chartModel(cw, ch);
    P.text(L, y, 'VB(z) profile along the cutting edge', 9, {bold: true}); y += 6;
    if (m) {
      const X = v => L + v, Y = v => y + v;
      P.rect(X(m.zoneC[0]), Y(m.pad.t), m.zoneC[1] - m.zoneC[0], ch - m.pad.t - m.pad.b, '#e6eefc');
      if (m.zoneN[1] > m.zoneN[0]) P.rect(X(m.zoneN[0]), Y(m.pad.t), m.zoneN[1] - m.zoneN[0], ch - m.pad.t - m.pad.b, '#fcefe2');
      m.yt.forEach(v => { P.line(X(m.pad.l), Y(m.Y(v)), X(cw - m.pad.r), Y(m.Y(v)), .3, '#cfd5dc'); P.text(X(m.pad.l - 4), Y(m.Y(v)) + 3, v.toFixed(1), 7, {align: 'right'}); });
      m.xt.forEach(z => P.text(X(m.X(z)), Y(ch - m.pad.b + 11), z.toFixed(0), 7, {align: 'center'}));
      P.text(X(cw - 30), Y(ch - 1), 'z (mm)', 7); P.text(X(0), Y(m.pad.t + 4), 'VB mm', 7);
      P.line(X(m.pad.l), Y(m.Y(m.limit)), X(cw - m.pad.r), Y(m.Y(m.limit)), 1, '#d0342c', [5, 3]); P.text(X(cw - m.pad.r), Y(m.Y(m.limit)) - 3, 'limit ' + f3(m.limit), 7, {align: 'right', color: '#d0342c'});
      P.line(X(m.pad.l), Y(m.Y(m.warn)), X(cw - m.pad.r), Y(m.Y(m.warn)), .8, '#e0a100', [2, 2]);
      m.lines.forEach(Ln => P.poly(Ln.pts.map(p => [X(p[0]), Y(p[1])]), 1.1, Ln.color));
      m.lines.forEach((Ln, j) => { P.rect(X(m.pad.l + 8 + j * 40), Y(m.pad.t + 4), 10, 3, Ln.color); P.text(X(m.pad.l + 21 + j * 40), Y(m.pad.t + 8), 'F' + (Ln.i + 1), 7); });
      P.rect(L, y, cw, ch, null, '#b8c0c8');
    }
    y += ch + 16;
    // uncertainty + calibration + manual
    const wi = d.worst == null ? 0 : d.worst, q = d.flutes[wi].q;
    P.text(L, y, 'Uncertainty budget (worst flute F' + (wi + 1) + '), standard uncertainties in mm', 9, {bold: true}); y += 12;
    const bc = [['', 50], ['scale', 60], ['edge', 60], ['repeat.', 60], ['helix', 60], ['U (k=2)', 60]]; x = L; bc.forEach(([h, w]) => { P.text(x, y, h, 7.5, {bold: true}); x += w; }); y += 10;
    [['VBmax', q.vbMax], ['VBB', q.vbb], ['VBC', q.vbc], ['VBN', q.vbn]].forEach(([n, b]) => { x = L; [n, f3(b.parts.scale), f3(b.parts.edge), f3(b.parts.rep), f3(b.parts.helix), f3(b.U)].forEach((c, j) => { P.text(x, y, c, 7.5, {bold: j === 5}); x += bc[j][1]; }); y += 10; });
    const cal = d.calib, cp = Object.entries(cal.parts).map(([k, v]) => k + ' ' + (100 * v).toFixed(2) + '%').join(', ');
    const rx = L + 360; let ry = y - 50;
    P.text(rx, ry, 'Calibration', 9, {bold: true}); ry += 12;
    P.text(rx, ry, cal.pxPerMm.toFixed(2) + ' px/mm, U_rel(k=2) ' + (200 * cal.uRel).toFixed(2) + ' %', 7.5); ry += 10;
    P.text(rx, ry, cal.method === 'diameter' ? 'from tool diameter D' + d.D + ' +-' + S.prefs.diaTolMm + ' mm' : 'reference target ' + S.prefs.refMm + ' mm, dev. vs D ' + cal.deviationPct.toFixed(2) + ' %', 7.5); ry += 10;
    P.text(rx, ry, cp, 7); ry += 10;
    if (d.manual.length) { P.text(rx, ry, 'Manual: ' + d.manual.slice(0, 4).map(m => (m.kind === 'caliper' ? 'VB' : 'dist') + ' F' + m.flute + ' ' + f3(m.mm) + '+-' + f3(m.U)).join('; '), 7); }
    y += 6;
    // method text (wrapped)
    const words = METHOD.split(' '); let line = '';
    for (const w of words) { if (P.width(line + ' ' + w, 6.8) > R - L) { P.text(L, y, line, 6.8, {color: '#445'}); y += 9; line = w; } else line = line ? line + ' ' + w : w; }
    if (line) { P.text(L, y, line, 6.8, {color: '#445'}); y += 9; }
    // footer
    const fy = P.H - 30; P.line(L, fy - 12, R, fy - 12, .4, '#b8c0c8');
    P.text(L, fy, 'Tool3D metrology - estimate from photographs, not a certified measurement. Scale traceable only via the stated reference.', 7, {color: '#667788'});
    P.text(R, fy, 'Signature: ____________________', 8, {align: 'right'});
    const post = T.postReport && T.postReport.pdfPage ? T.postReport.pdfPage() : null;   // js/post: Keyence / Alicona page
    return M.pdfBytes(post ? [P, post] : P);
  }

  // ---------- HTML (self-contained, A4 print) ----------
  function htmlDoc() {
    if (!ready()) return null;
    const d = data(), S = T.metro.state, light = T.metro.LIGHT, ov = d.overall || {light: 'amber', decision: 'n/a'};
    const strips = d.flutes.map((_, i) => overlay(i)).map((c, i) => c ? `<figure><img src="${c.toDataURL('image/jpeg', .88)}"><figcaption>F${i + 1}</figcaption></figure>` : '').join('');
    const snap = snapshot3d(), m = T.metro.chartModel(700, 200);
    const svg = !m ? '' : `<svg viewBox="0 0 700 200" width="100%"><rect x="${m.zoneC[0]}" y="${m.pad.t}" width="${m.zoneC[1] - m.zoneC[0]}" height="${200 - m.pad.t - m.pad.b}" fill="#e6eefc"/>
      <rect x="${m.zoneN[0]}" y="${m.pad.t}" width="${Math.max(0, m.zoneN[1] - m.zoneN[0])}" height="${200 - m.pad.t - m.pad.b}" fill="#fcefe2"/>
      ${m.yt.map(v => `<line x1="${m.pad.l}" x2="${700 - m.pad.r}" y1="${m.Y(v)}" y2="${m.Y(v)}" stroke="#dde1e6"/><text x="${m.pad.l - 4}" y="${m.Y(v) + 3}" font-size="10" text-anchor="end">${v.toFixed(1)}</text>`).join('')}
      ${m.xt.map(z => `<text x="${m.X(z)}" y="${200 - m.pad.b + 13}" font-size="10" text-anchor="middle">${z}</text>`).join('')}
      <line x1="${m.pad.l}" x2="${700 - m.pad.r}" y1="${m.Y(m.limit)}" y2="${m.Y(m.limit)}" stroke="${light.red}" stroke-dasharray="6 4"/>
      <line x1="${m.pad.l}" x2="${700 - m.pad.r}" y1="${m.Y(m.warn)}" y2="${m.Y(m.warn)}" stroke="${light.amber}" stroke-dasharray="2 3"/>
      ${m.lines.map(L => `<polyline fill="none" stroke="${L.color}" stroke-width="1.6" points="${L.pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}"/>`).join('')}
      <text x="660" y="198" font-size="10">z (mm)</text><text x="2" y="12" font-size="10">VB (mm)</text></svg>`;
    const q = e => ['vbMax', 'vbb', 'vbc', 'vbn'].map(k => `<td>${f3(e.q[k].v)} <small>± ${f3(e.q[k].U)}</small></td>`).join('');
    const wi = d.worst == null ? 0 : d.worst, B = d.flutes[wi].q;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tool wear report ${esc(d.toolId)}</title>
<style>@page{size:A4;margin:12mm}body{font:12px/1.4 system-ui,"Segoe UI",sans-serif;color:#1d2330;margin:0 auto;max-width:190mm;padding:12px;background:#fff}
header{background:#1f2a36;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-radius:4px}h1{font-size:18px;margin:0}header p{margin:2px 0 0;color:#c8d2dc;font-size:11px}
.badge{padding:8px 12px;border-radius:4px;color:#fff;font-weight:700;text-align:center;background:${light[ov.light]}}
.info{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 16px;margin:10px 0}.info span{color:#678;display:inline-block;width:64px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid #d5d9e0;padding:3px 4px;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#e8edf2}
small{color:#678}.dot{display:inline-block;width:10px;height:10px;border-radius:50%}.imgs{display:flex;gap:6px;align-items:flex-end;margin:10px 0}figure{margin:0;text-align:center}figure img{height:200px;display:block}.snap img{height:auto;width:260px}
h2{font-size:13px;margin:12px 0 4px}.note{font-size:10px;color:#445}footer{margin-top:14px;border-top:1px solid #ccd;padding-top:6px;display:flex;justify-content:space-between;font-size:10px;color:#678}</style></head><body>
<header><div><h1>Tool wear inspection report</h1><p>Peripheral flank wear VB — ISO 8688-2 / ISO 3685 — photo-based measurement</p></div>
<div class="badge">${T.metro.LBL[ov.light] || '-'} · ${DEC[ov.decision]}<br><small style="color:#fff">VBmax ${f3(d.vbMax && d.vbMax.v)} ± ${f3(d.vbMax && d.vbMax.U)} mm</small></div></header>
<div class="info"><div><span>Tool ID</span><b>${esc(d.toolId)}</b></div><div><span>Operator</span>${esc(d.operator || '-')}</div><div><span>Date</span>${d.date}</div>
<div><span>Diameter</span>Ø ${d.D} mm</div><div><span>Flutes</span>${d.k}</div><div><span>Helix</span>${(+d.helixDeg).toFixed(1)}°</div>
<div><span>Engine</span>${esc(d.engine || '-')}</div><div><span>Scale</span>${d.calib.pxPerMm.toFixed(2)} ± ${d.calib.U_pxPerMm.toFixed(2)} px/mm (${d.calib.method})</div><div><span>Limit</span>${f3(d.limitMm)} mm (warn ${Math.round(d.warnFrac * 100)} %)</div></div>
<table><tr><th>Flute</th><th>VBmax</th><th>VBB avg</th><th>VBC corner</th><th>VBN notch</th><th>Area mm²</th><th>Vol. mm³</th><th>Decision</th></tr>
${d.flutes.map((e, i) => `<tr><td>F${i + 1}${e.edited ? '*' : ''}${e.mode === 'operator-assisted' || e.mode === 'awaiting-operator' ? ` <small>${e.mode}</small>` : ''}</td>${q(e)}<td>${e.failed ? '-' : e.areaMm2.toFixed(3)}</td><td>${e.failed ? '-' : e.volumeMm3.toFixed(4)}</td><td>${DEC[e.status.decision]} <i class="dot" style="background:${light[e.status.light]}"></i></td></tr>`).join('')}</table>
<p class="note">mm, value ± U (k=2). * = corrected by the operator.</p>
<div class="imgs">${strips}${snap ? `<figure class="snap"><img src="${snap.toDataURL('image/jpeg', .88)}"><figcaption>3D model with mapped wear</figcaption></figure>` : ''}</div>
<h2>VB(z) profile along the cutting edge</h2>${svg}
<h2>Uncertainty budget — F${wi + 1} (standard uncertainties, mm)</h2>
<table><tr><th></th><th>scale</th><th>edge</th><th>repeat.</th><th>helix</th><th>U (k=2)</th></tr>${[['VBmax', B.vbMax], ['VBB', B.vbb], ['VBC', B.vbc], ['VBN', B.vbn]].map(([n, b]) => `<tr><td>${n}</td><td>${f3(b.parts.scale)}</td><td>${f3(b.parts.edge)}</td><td>${f3(b.parts.rep)}</td><td>${f3(b.parts.helix)}</td><td><b>${f3(b.U)}</b></td></tr>`).join('')}</table>
<p class="note">Calibration: ${d.calib.method === 'diameter' ? `tool diameter Ø${d.D} ± ${S.prefs.diaTolMm} mm` : `reference target ${S.prefs.refMm} mm (deviation vs diameter ${d.calib.deviationPct.toFixed(2)} %)`}; ${Object.entries(d.calib.parts).map(([k, v]) => `${k} ${(100 * v).toFixed(2)} %`).join(', ')}.</p>
${d.manual.length ? `<h2>Manual measurements</h2><table><tr><th>Type</th><th>Flute</th><th>Value mm</th><th>U mm</th></tr>${d.manual.map(m => `<tr><td>${m.kind}</td><td>F${m.flute}</td><td>${f3(m.mm)}</td><td>${f3(m.U)}</td></tr>`).join('')}</table>` : ''}
<p class="note">${esc(METHOD)}</p>
${T.postReport && T.postReport.html ? T.postReport.html() || '' : ''}
<footer><span>Tool3D metrology — estimate from photographs, not a certified measurement.</span><span>Signature: ____________________</span></footer></body></html>`;
  }

  T.metroReport = {
    pdfBytes: pdf, htmlDoc,
    pdf() { const b = pdf(); if (b) save(`tool3d-report-${safeId()}-${fileStamp()}.pdf`, new Blob([b], {type: 'application/pdf'})); return b; },
    html() { const h = htmlDoc(); if (h) save(`tool3d-report-${safeId()}-${fileStamp()}.html`, new Blob([h], {type: 'text/html'})); return h; },
    print() { const h = htmlDoc(); if (!h) return; const w = window.open('', '_blank'); if (!w) return this.html(); w.document.write(h); w.document.close(); setTimeout(() => { try { w.print(); } catch (e) { /* closed */ } }, 600); },
    csv() { if (!ready()) return null; const t = M.csv(data()) + (T.postReport && T.postReport.csv ? String.fromCharCode(13, 10) + (T.postReport.csv() || '') : ''); save(`tool3d-${safeId()}-${fileStamp()}.csv`, new Blob(['﻿' + t], {type: 'text/csv'})); return t; }
  };
})();
