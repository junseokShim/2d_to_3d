/* Tool3D measurement report: two-page PDF (own writer, metro-core PdfPage), printable HTML and CSV, laid out like a
 * digital-microscope measurement report.
 * Page 1: tool info, overall decision, flank wear per flute (VBmax / VBB / VBC / VBN, value ± U, positions), annotated image
 * of the worst flute (reference line, VB dimension lines with values, scale bar, magnification), its dimension list and
 * statistics, VB profile along the edge. Page 2: end-face wear area per tooth (annotated top image + table), all flutes,
 * tolerance verdict, tool-life trend, uncertainty budget, calibration, manual measurements, method.
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, M = T.metroCore;
  const f1 = v => v == null || Number.isNaN(+v) ? '-' : (+v).toFixed(1), f2 = v => v == null || Number.isNaN(+v) ? '-' : (+v).toFixed(2);
  const f3 = v => v == null || Number.isNaN(+v) ? '-' : (+v).toFixed(3), f4 = v => v == null || Number.isNaN(+v) ? '-' : (+v).toFixed(4), pad = n => String(n).padStart(2, '0');
  const stamp = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const fileStamp = () => stamp().replace(/[: ]/g, '').replace(/-/g, '');
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'})[c]);
  function save(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 30000); }
  const ready = () => T.metro && T.metro.state.ready;
  const safeId = () => (T.metro.state.prefs.toolId || 'tool').replace(/[^\w.-]+/g, '_');
  const at = z => z == null ? '' : '@' + (+z).toFixed(2);

  function snapshot3d() {
    const g = document.querySelector('#tool3d-view canvas') || document.querySelector('#gl'); if (!g || !g.width) return null;
    const s = Math.min(1, 900 / g.width), c = Object.assign(document.createElement('canvas'), {width: Math.round(g.width * s), height: Math.round(g.height * s)}), x = c.getContext('2d');
    x.fillStyle = '#20242c'; x.fillRect(0, 0, c.width, c.height); try { x.drawImage(g, 0, 0, c.width, c.height); } catch (e) { return null; }
    return c;
  }
  const jpeg = c => { const b = atob(c.toDataURL('image/jpeg', .9).split(',')[1]), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
  const EMPTY = {v: 0, U: 0};
  function data() {
    const s = T.metro.summary(); s.date = stamp();
    s.flutes = s.flutes.map(e => e || {q: {vbMax: EMPTY, vbAvg: EMPTY, vbb: EMPTY, vbbMax: EMPTY, vbc: EMPTY, vbn: EMPTY}, profile: [], status: {decision: 'n/a', light: 'amber'}, failed: true});
    return s;
  }
  const DEC = {conform: 'CONFORM', nonconform: 'NONCONFORM', indeterminate: 'INDETERMINATE', 'n/a': 'N/A'};
  const LIGHT = {green: '#1e9e4a', amber: '#e0a100', red: '#d0342c'};
  const METHOD = 'VB = width of the flank wear land normal to the cutting edge (ISO 8688-2 / ISO 3685), per row of the rectified flute image; ' +
    'reference line = straight line fitted on the unworn part of the cutting edge; VB dimension lines run from the edge to the wear front. ' +
    'End-face wear area = worn pixels of the end-face photo (network classes flank wear / chipping / adhesion, else the brightness rule) / (px/mm)^2, ' +
    'teeth split by the k-fold symmetry of the end face. U = k*u_c, k = 2 (~95 %); u_c = RSS of scale, edge localisation sqrt(2)*sigma/(px/mm) ' +
    '(sigma 0.5 px auto, 1 px manual), repeatability and helix angle +-2 deg. Decision rule ISO 14253-1: conform if VB+U < limit, nonconform if VB-U > limit.';
  const modeTag = e => ({'operator-assisted': ' (OA)', 'awaiting-operator': ' (unconfirmed)'}[e.mode] || '');

  // ---------- PDF ----------
  function header(P, d, title, sub) {
    const W = P.W, R = W - 36, ov = d.overall || {light: 'amber', decision: 'n/a'};
    P.rect(0, 0, W, 58, '#1f2a36'); P.text(36, 25, title, 15, {bold: true, color: '#ffffff'}); P.text(36, 42, sub, 8.5, {color: '#c8d2dc'});
    P.rect(R - 150, 12, 150, 34, LIGHT[ov.light]); P.text(R - 75, 28, (T.metro.LBL[ov.light] || '-') + ' - ' + DEC[ov.decision], 10, {bold: true, color: '#ffffff', align: 'center'});
    P.text(R - 75, 40, 'VBmax ' + f3(d.vbMax && d.vbMax.v) + ' +- ' + f3(d.vbMax && d.vbMax.U) + ' mm', 8, {color: '#ffffff', align: 'center'});
  }
  function footer(P, n, N) {
    const fy = P.H - 26; P.line(36, fy - 12, P.W - 36, fy - 12, .4, '#b8c0c8');
    P.text(36, fy, 'Tool3D measurement - estimate from photographs, not a certified measurement. Scale traceable only via the stated reference.', 6.8, {color: '#667788'});
    P.text(P.W - 36, fy, 'Page ' + n + '/' + N + '   Signature: ________________', 7.5, {align: 'right'});
  }
  const sect = (P, x, y, t) => { P.text(x, y, t, 9.5, {bold: true}); P.line(x, y + 3, P.W - 36, y + 3, .5, '#1f2a36'); return y + 14; };
  function img(P, c, x, y, maxW, maxH) { if (!c) return [0, 0]; const s = Math.min(maxW / c.width, maxH / c.height), w = c.width * s, h = c.height * s; P.image(jpeg(c), c.width, c.height, x, y, w, h); return [w, h]; }
  function wrap(P, text, x, y, w, size, color) { let line = ''; for (const t of text.split(' ')) { if (P.width(line + ' ' + t, size) > w) { P.text(x, y, line, size, {color}); y += size + 2.4; line = t; } else line = line ? line + ' ' + t : t; } if (line) { P.text(x, y, line, size, {color}); y += size + 2.4; } return y; }

  function page1(d) {
    const P = M.PdfPage(), L = 36, R = P.W - 36, S = T.metro.state;
    header(P, d, 'Tool wear inspection report', 'Flank wear VB and end-face wear area - ISO 8688-2 / ISO 3685 - ' + (d.inputMode === 'microscope' ? 'microscope ' + d.magnification + 'x' : 'photo-based') + ' measurement');
    let y = 74; const info = [['Tool ID', d.toolId], ['Operator', d.operator || '-'], ['Date', d.date], ['Diameter', 'D ' + d.D + ' mm'], ['Flutes', d.k], ['Helix', f1(d.helixDeg) + ' deg'],
      ['Engine', d.engine || '-'], ['Scale', d.calib.pxPerMm.toFixed(2) + ' +- ' + d.calib.U_pxPerMm.toFixed(2) + ' px/mm (' + d.calib.method + ')'], ['Limit VB', f3(d.limitMm) + ' mm (warn ' + Math.round(d.warnFrac * 100) + ' %)']];
    info.forEach(([k, v], i) => { const cx = L + (i % 3) * 176, cy = y + Math.floor(i / 3) * 13; P.text(cx, cy, k, 7.5, {color: '#667788'}); P.text(cx + 48, cy, String(v), 8.5, {bold: i === 0}); });
    y = sect(P, L, y + 44, 'Flank wear per flute (mm, value +- U k=2, @ = position z from the tip in mm)');
    const cols = [['Flute', 52], ['VBmax', 64], ['@z', 30], ['VBB avg', 64], ['VBC', 64], ['@z', 30], ['VBN', 64], ['@z', 30], ['worn mm', 40], ['Decision', 85]];
    P.rect(L, y - 9, R - L, 13, '#e8edf2'); let x = L + 3; cols.forEach(([h, w]) => { P.text(x, y, h, 7.8, {bold: true}); x += w; }); y += 13;
    d.flutes.forEach((e, i) => {
      const q = e.q, p = d.vb && d.vb[i] ? d.vb[i].pos : null, st = d.vb && d.vb[i] ? d.vb[i].stats : null;
      const cells = ['F' + (i + 1) + (e.edited ? '*' : '') + modeTag(e), f3(q.vbMax.v) + ' +-' + f3(q.vbMax.U), p ? at(p.vbMax.zMm) : '', f3(q.vbb.v) + ' +-' + f3(q.vbb.U), f3(q.vbc.v) + ' +-' + f3(q.vbc.U), p ? at(p.vbc.zMm) : '',
        f3(q.vbn.v) + ' +-' + f3(q.vbn.U), p ? at(p.vbn.zMm) : '', st ? f2(st.wornMm) : '-', e.failed ? 'not measured' : DEC[e.status.decision]];
      x = L + 3; cells.forEach((c, j) => { P.text(x, y, c, 8, {bold: j === 1, color: j === 2 || j === 5 || j === 7 ? '#667788' : '#000000'}); x += cols[j][1]; });
      P.rect(R - 11, y - 7, 8, 8, LIGHT[e.status.light]); P.line(L, y + 4, R, y + 4, .3, '#d5d9e0'); y += 13;
    });
    P.text(L, y + 1, '* = edge/band corrected by the operator. Zones: C = 0..' + f3(d.flutes[0].zones && d.flutes[0].zones.cornerMm) + ' mm, N = ap ' + f3(d.flutes[0].zones && d.flutes[0].zones.apMm) + ' +- ' + f3(d.flutes[0].zones && d.flutes[0].zones.notchHalfMm) + ' mm, B = rest.', 6.8, {color: '#667788'});
    // worst flute, annotated, with its dimension list and statistics
    const wi = d.worst == null ? 0 : d.worst, vb = d.vb && d.vb[wi];
    y = sect(P, L, y + 18, 'VB measurement F' + (wi + 1) + ' (worst flute): reference line, VB dimension lines, scale bar');
    const A = T.metro.annotated(wi, 460, 640), [iw, ih] = img(P, A, L, y, 250, 330);
    const tx = L + Math.max(iw, 120) + 14; let ty = y + 8;
    if (vb) {
      P.text(tx, ty, 'No.', 7.8, {bold: true}); P.text(tx + 40, ty, 'z mm', 7.8, {bold: true}); P.text(tx + 90, ty, 'u mm', 7.8, {bold: true}); P.text(tx + 140, ty, 'VB um', 7.8, {bold: true}); ty += 4; P.line(tx, ty, R, ty, .4, '#b8c0c8'); ty += 10;
      vb.lines.forEach(l => { const c = l.isMax ? '#c00000' : '#000000'; P.text(tx, ty, '[' + l.n + ']' + (l.isMax ? ' max' : ''), 8, {color: c}); P.text(tx + 40, ty, f3(l.zMm), 8, {color: c}); P.text(tx + 90, ty, f3(l.uMm), 8, {color: c}); P.text(tx + 140, ty, f2(l.vbUm), 8, {bold: true, color: c}); ty += 11; });
      if (!vb.lines.length) { P.text(tx, ty, 'no wear land on this flute', 8, {color: '#667788'}); ty += 11; }
      ty += 6; const s = vb.stats;
      [['VB max / mean / min', f2(s.maxUm) + ' / ' + f2(s.meanUm) + ' / ' + f2(s.minUm) + ' um'], ['sd / median', f2(s.sdUm) + ' / ' + f2(s.medianUm) + ' um'], ['worn length', f3(s.wornMm) + ' of ' + f3(s.lengthMm) + ' mm (' + f1(s.wornPct) + ' %)'],
        ['magnification (equiv.)', String(vb.mag).replace('×', 'x') + ', ' + f2(vb.umPerPx) + ' um/px'], ['reference line', (vb.ref.from === 'unworn' ? 'fit on unworn edge' : 'fit on all rows') + ', rms ' + f2(vb.ref.residualPx) + ' px'],
        ['VBB span', vb.pos.vbb.span ? 'z ' + f2(vb.pos.vbb.span[0]) + '..' + f2(vb.pos.vbb.span[1]) + ' mm' : '-'], ['VBmax position', vb.pos.vbMax.zMm == null ? '-' : 'z ' + f2(vb.pos.vbMax.zMm) + ' mm']]
        .forEach(([k, v]) => { P.text(tx, ty, k, 7.5, {color: '#667788'}); P.text(tx + 100, ty, v, 7.8); ty += 11; });
    }
    y += Math.max(ih, ty - y) + 14;
    // VB profile along the edge (all flutes)
    const cw = R - L, ch = Math.min(170, P.H - 60 - y - 20), m = T.metro.chartModel(cw, ch);
    y = sect(P, L, y, 'VB profile along the cutting edge (all flutes)');
    if (m && ch > 80) {
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
    return P;
  }
  function page2(d) {
    const P = M.PdfPage(), L = 36, R = P.W - 36, S = T.metro.state, E = d.endFace;
    header(P, d, 'Tool wear inspection report', 'Tool ' + d.toolId + ' - ' + d.date + ' - end face, all flutes, tolerance, trend, uncertainty');
    let y = sect(P, L, 76, 'End-face wear area per tooth (top view)');
    if (E) {
      const [iw, ih] = img(P, T.metro.topAnnotated(480), L, y, 210, 210), tx = L + iw + 14; let ty = y + 8;
      const cols = [['Tooth', 34], ['at', 30], ['land mm2', 48], ['worn mm2', 50], ['flank', 42], ['chip', 42], ['adh.', 40], ['%', 28], ['rim mm', 36]];
      let x = tx; cols.forEach(([h, w]) => { P.text(x, ty, h, 7.5, {bold: true}); x += w; }); ty += 4; P.line(tx, ty, R, ty, .4, '#b8c0c8'); ty += 10;
      E.teeth.concat([Object.assign({tooth: 'sum', centreDeg: null, rimDepthMm: null}, E.total)]).forEach(t => {
        x = tx; [t.tooth === 'sum' ? 'Total' : 'T' + t.tooth, t.centreDeg == null ? '' : Math.round(t.centreDeg) + ' deg', f4(t.landMm2), f4(t.wornMm2), f4(t.flankMm2), f4(t.chippingMm2), f4(t.adhesionMm2), f1(t.wornPct), t.rimDepthMm == null ? '' : f3(t.rimDepthMm)]
          .forEach((c, j) => { P.text(x, ty, c, 7.8, {bold: j === 3 || t.tooth === 'sum'}); x += cols[j][1]; }); ty += 11;
      });
      ty += 4; ty = wrap(P, 'Source: ' + (E.source === 'network' ? 'network segmentation of the end face (flank wear / chipping / adhesion)' : 'brightness rule of the wear engine (coating loss)') + '; ' + f1(E.pxPerMm) + ' px/mm; land = end face without the flute gullies; teeth split at the k-fold symmetry (phase ' + f1(E.phaseDeg) + ' deg).', tx, ty, R - tx, 7, '#445566');
      y += Math.max(ih, ty - y) + 12;
    } else { P.text(L, y + 4, 'No top (end-face) photo, or the end-face circle was not found.', 8, {color: '#667788'}); y += 20; }
    // all flutes, annotated
    y = sect(P, L, y, 'All flutes (reference line, VB dimension lines)');
    const hT = 170; let ix = L;
    d.flutes.forEach((_, i) => { const c = T.metro.annotated(i, 300, 520); if (!c) return; const w = Math.min((R - L - 6 * (d.k - 1)) / d.k, c.width / c.height * hT); const [ww, hh] = img(P, c, ix, y, w, hT); P.text(ix + ww / 2, y + hh + 9, 'F' + (i + 1), 7.5, {align: 'center'}); ix += ww + 6; });
    y += hT + 22;
    // tolerance + trend side by side
    const tol = d.tolerance, yt0 = y; y = sect(P, L, y, 'Tolerance verdict' + (tol && tol.pass != null ? (tol.pass ? '  -  PASS' : '  -  FAIL') : ''));
    if (tol) tol.rows.forEach(r => { P.text(L, y, r.label, 7.8); P.text(L + 120, y, r.value == null ? '-' : (r.unit === 'mm²' ? f4(r.value) : f3(r.value)) + ' ' + r.unit.replace('²', '2'), 7.8, {bold: true}); P.text(L + 190, y, '<= ' + r.limit + ' ' + r.unit.replace('²', '2'), 7.8); P.text(L + 250, y, r.pass == null ? '-' : r.pass ? 'PASS' : 'FAIL', 7.8, {bold: true, color: r.pass == null ? '#667788' : r.pass ? '#1e9e4a' : '#d0342c'}); y += 11; });
    let y2 = yt0 + 14; const hist = M.history(storeOf(), S.prefs.toolId), tr = T.metroVb ? T.metroVb.trend(hist, d.limitMm) : null, x2 = L + 300;
    P.text(x2, yt0, 'Tool-life trend (' + hist.length + ' saved)', 9.5, {bold: true});
    if (tr) { P.text(x2, y2, 'VBmax slope ' + f1(tr.slope * 1000) + ' um per ' + tr.per + (tr.remaining != null ? ', limit in about ' + f1(tr.remaining) + (tr.per === 'min' ? ' min' : ' measurements') : ''), 7.8); y2 += 11; }
    hist.slice(-5).forEach(h => { P.text(x2, y2, h.date + '  VBmax ' + f3(h.vbMax) + ' +- ' + f3(h.U) + ' mm', 7.5); y2 += 10; });
    if (!hist.length) { P.text(x2, y2, 'no saved measurements for this tool id', 7.5, {color: '#667788'}); y2 += 10; }
    y = Math.max(y, y2) + 10;
    // uncertainty + calibration
    const wi = d.worst == null ? 0 : d.worst, q = d.flutes[wi].q;
    y = sect(P, L, y, 'Uncertainty budget (worst flute F' + (wi + 1) + '), standard uncertainties in mm');
    const bc = [['', 50], ['scale', 56], ['edge', 56], ['repeat.', 56], ['helix', 56], ['U (k=2)', 56]]; let x = L; bc.forEach(([h, w]) => { P.text(x, y, h, 7.5, {bold: true}); x += w; }); y += 10;
    const yb = y; [['VBmax', q.vbMax], ['VBB', q.vbb], ['VBC', q.vbc], ['VBN', q.vbn]].forEach(([n, b]) => { x = L; [n, f3(b.parts && b.parts.scale), f3(b.parts && b.parts.edge), f3(b.parts && b.parts.rep), f3(b.parts && b.parts.helix), f3(b.U)].forEach((c, j) => { P.text(x, y, c, 7.5, {bold: j === 5}); x += bc[j][1]; }); y += 10; });
    const cal = d.calib, rx = L + 350; let ry = yb;
    P.text(rx, ry - 10, 'Calibration', 8.5, {bold: true});
    P.text(rx, ry, cal.pxPerMm.toFixed(2) + ' px/mm, U_rel(k=2) ' + (200 * cal.uRel).toFixed(2) + ' %', 7.5); ry += 10;
    P.text(rx, ry, cal.method === 'diameter' ? 'from tool diameter D' + d.D + ' +-' + S.prefs.diaTolMm + ' mm' : cal.method === 'reference' ? 'reference target ' + S.prefs.refMm + ' mm, dev. vs D ' + cal.deviationPct.toFixed(2) + ' %' : cal.method, 7.5); ry += 10;
    if (d.manual.length) { P.text(rx, ry, 'Manual: ' + d.manual.slice(0, 3).map(m => (m.kind === 'caliper' ? 'VB' : 'dist') + ' F' + m.flute + ' ' + f3(m.mm) + '+-' + f3(m.U)).join('; '), 7); }
    y = Math.max(y, ry) + 10;
    wrap(P, METHOD, L, y, R - L, 6.8, '#445566');
    return P;
  }
  let _store = null; const storeOf = () => _store || (_store = (() => { try { return window.localStorage; } catch (e) { return null; } })() || {getItem: () => null, setItem: () => {}});
  function pdf() {
    if (!ready()) return null;
    const d = data(), pages = [page1(d), page2(d)];
    const post = T.postReport && T.postReport.pdfPage ? T.postReport.pdfPage() : null;   // js/post: 3D deviation page
    pages.forEach((P, i) => footer(P, i + 1, pages.length + (post ? 1 : 0)));
    return M.pdfBytes(post ? pages.concat([post]) : pages);
  }

  // ---------- HTML (self-contained, A4 print) ----------
  function htmlDoc() {
    if (!ready()) return null;
    const d = data(), S = T.metro.state, ov = d.overall || {light: 'amber', decision: 'n/a'}, wi = d.worst == null ? 0 : d.worst, vb = d.vb && d.vb[wi], E = d.endFace;
    const url = c => c ? c.toDataURL('image/jpeg', .9) : '';
    const A = T.metro.annotated(wi, 520, 700), top = E ? T.metro.topAnnotated(480) : null, snap = snapshot3d(), m = T.metro.chartModel(700, 200);
    const all = d.flutes.map((_, i) => T.metro.annotated(i, 300, 520)).map((c, i) => c ? `<figure><img src="${url(c)}"><figcaption>F${i + 1}</figcaption></figure>` : '').join('');
    const svg = !m ? '' : `<svg viewBox="0 0 700 200" width="100%"><rect x="${m.zoneC[0]}" y="${m.pad.t}" width="${m.zoneC[1] - m.zoneC[0]}" height="${200 - m.pad.t - m.pad.b}" fill="#e6eefc"/>
      <rect x="${m.zoneN[0]}" y="${m.pad.t}" width="${Math.max(0, m.zoneN[1] - m.zoneN[0])}" height="${200 - m.pad.t - m.pad.b}" fill="#fcefe2"/>
      ${m.yt.map(v => `<line x1="${m.pad.l}" x2="${700 - m.pad.r}" y1="${m.Y(v)}" y2="${m.Y(v)}" stroke="#dde1e6"/><text x="${m.pad.l - 4}" y="${m.Y(v) + 3}" font-size="10" text-anchor="end">${v.toFixed(1)}</text>`).join('')}
      ${m.xt.map(z => `<text x="${m.X(z)}" y="${200 - m.pad.b + 13}" font-size="10" text-anchor="middle">${z}</text>`).join('')}
      <line x1="${m.pad.l}" x2="${700 - m.pad.r}" y1="${m.Y(m.limit)}" y2="${m.Y(m.limit)}" stroke="${LIGHT.red}" stroke-dasharray="6 4"/>
      <line x1="${m.pad.l}" x2="${700 - m.pad.r}" y1="${m.Y(m.warn)}" y2="${m.Y(m.warn)}" stroke="${LIGHT.amber}" stroke-dasharray="2 3"/>
      ${m.lines.map(Ln => `<polyline fill="none" stroke="${Ln.color}" stroke-width="1.6" points="${Ln.pts.map(p => p.map(v => v.toFixed(1)).join(',')).join(' ')}"/>`).join('')}
      <text x="660" y="198" font-size="10">z (mm)</text><text x="2" y="12" font-size="10">VB (mm)</text></svg>`;
    const pm = b => `${f3(b.v)} <small>± ${f3(b.U)}</small>`, z = v => v == null ? '' : ` <small class="at">@ ${(+v).toFixed(2)}</small>`;
    const B = d.flutes[wi].q, tol = d.tolerance;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tool wear report ${esc(d.toolId)}</title>
<style>@page{size:A4;margin:12mm}body{font:12px/1.4 system-ui,"Segoe UI",sans-serif;color:#1d2330;margin:0 auto;max-width:190mm;padding:12px;background:#fff}
header{background:#1f2a36;color:#fff;padding:12px 16px;display:flex;justify-content:space-between;align-items:center;border-radius:4px}h1{font-size:18px;margin:0}header p{margin:2px 0 0;color:#c8d2dc;font-size:11px}
.badge{padding:8px 12px;border-radius:4px;color:#fff;font-weight:700;text-align:center;background:${LIGHT[ov.light]}}
.info{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 16px;margin:10px 0}.info span{color:#678;display:inline-block;width:64px}
table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}th,td{border-bottom:1px solid #d5d9e0;padding:3px 4px;text-align:right}th:first-child,td:first-child{text-align:left}th{background:#e8edf2}
small{color:#678}.at{color:#678}.dot{display:inline-block;width:10px;height:10px;border-radius:50%}.max td{color:#c00000;font-weight:600}
.row{display:flex;gap:14px;align-items:flex-start;margin:8px 0}.row>div{flex:1}figure{margin:0;text-align:center}figure img{display:block;max-width:100%}.imgs{display:flex;gap:6px;align-items:flex-end;flex-wrap:wrap}.imgs img{height:200px}
h2{font-size:13px;margin:14px 0 4px;border-bottom:1.5px solid #1f2a36;padding-bottom:2px}.note{font-size:10px;color:#445}.pass{color:#1e9e4a;font-weight:700}.fail{color:#d0342c;font-weight:700}
footer{margin-top:14px;border-top:1px solid #ccd;padding-top:6px;display:flex;justify-content:space-between;font-size:10px;color:#678}.pb{break-before:page}</style></head><body>
<header><div><h1>Tool wear inspection report</h1><p>Flank wear VB and end-face wear area — ISO 8688-2 / ISO 3685 — photo-based measurement</p></div>
<div class="badge">${T.metro.LBL[ov.light] || '-'} · ${DEC[ov.decision]}<br><small style="color:#fff">VBmax ${f3(d.vbMax && d.vbMax.v)} ± ${f3(d.vbMax && d.vbMax.U)} mm</small></div></header>
<div class="info"><div><span>Tool ID</span><b>${esc(d.toolId)}</b></div><div><span>Operator</span>${esc(d.operator || '-')}</div><div><span>Date</span>${d.date}</div>
<div><span>Diameter</span>Ø ${d.D} mm</div><div><span>Flutes</span>${d.k}</div><div><span>Helix</span>${f1(d.helixDeg)}°</div>
<div><span>Engine</span>${esc(d.engine || '-')}</div><div><span>Scale</span>${d.calib.pxPerMm.toFixed(2)} ± ${d.calib.U_pxPerMm.toFixed(2)} px/mm (${d.calib.method})</div><div><span>Limit</span>${f3(d.limitMm)} mm (warn ${Math.round(d.warnFrac * 100)} %)</div></div>
<h2>Flank wear per flute</h2>
<table><tr><th>Flute</th><th>VBmax</th><th>VBB avg</th><th>VBC corner</th><th>VBN notch</th><th>worn mm</th><th>Area mm²</th><th>Decision</th></tr>
${d.flutes.map((e, i) => { const p = d.vb && d.vb[i] ? d.vb[i].pos : null, st = d.vb && d.vb[i] ? d.vb[i].stats : null; return `<tr><td>F${i + 1}${e.edited ? '*' : ''}${modeTag(e) ? ` <small>${e.mode}</small>` : ''}</td><td>${pm(e.q.vbMax)}${z(p && p.vbMax.zMm)}</td><td>${pm(e.q.vbb)}</td><td>${pm(e.q.vbc)}${z(p && p.vbc.zMm)}</td><td>${pm(e.q.vbn)}${z(p && p.vbn.zMm)}</td><td>${st ? f2(st.wornMm) : '-'}</td><td>${e.failed ? '-' : f3(e.areaMm2)}</td><td>${DEC[e.status.decision]} <i class="dot" style="background:${LIGHT[e.status.light]}"></i></td></tr>`; }).join('')}</table>
<p class="note">mm, value ± U (k=2), @ = position z from the tip (mm). * = corrected by the operator.</p>
<h2>VB measurement — F${wi + 1} (worst flute)</h2>
<div class="row"><div>${A ? `<figure><img src="${url(A)}"><figcaption>Reference line (dashed), VB dimension lines [n], scale bar</figcaption></figure>` : ''}</div>
<div>${vb ? `<table><tr><th>No.</th><th>z mm</th><th>u mm</th><th>VB µm</th></tr>${vb.lines.map(l => `<tr${l.isMax ? ' class="max"' : ''}><td>[${l.n}]${l.isMax ? ' max' : ''}</td><td>${f3(l.zMm)}</td><td>${f3(l.uMm)}</td><td>${f2(l.vbUm)}</td></tr>`).join('')}</table>
<table style="margin-top:8px"><tr><td>VB max / mean / min</td><td>${f2(vb.stats.maxUm)} / ${f2(vb.stats.meanUm)} / ${f2(vb.stats.minUm)} µm</td></tr><tr><td>σ / median</td><td>${f2(vb.stats.sdUm)} / ${f2(vb.stats.medianUm)} µm</td></tr>
<tr><td>worn length</td><td>${f3(vb.stats.wornMm)} of ${f3(vb.stats.lengthMm)} mm</td></tr><tr><td>magnification (equiv.)</td><td>${esc(vb.mag)} · ${f2(vb.umPerPx)} µm/px</td></tr><tr><td>reference line</td><td>${vb.ref.from === 'unworn' ? 'fit on the unworn edge' : 'fit on all rows'}, rms ${f2(vb.ref.residualPx)} px</td></tr></table>` : ''}</div></div>
<h2>VB profile along the cutting edge</h2>${svg}
<h2 class="pb">End-face wear area per tooth</h2>
${E ? `<div class="row"><div style="flex:0 0 240px">${top ? `<figure><img src="${url(top)}"><figcaption>End face (worn area tinted, tooth sectors)</figcaption></figure>` : ''}</div><div>
<table><tr><th>Tooth</th><th>at</th><th>land mm²</th><th>worn mm²</th><th>flank</th><th>chipping</th><th>adhesion</th><th>%</th><th>rim mm</th></tr>
${E.teeth.map(t => `<tr><td>T${t.tooth}</td><td>${Math.round(t.centreDeg)}°</td><td>${f4(t.landMm2)}</td><td><b>${f4(t.wornMm2)}</b></td><td>${f4(t.flankMm2)}</td><td>${f4(t.chippingMm2)}</td><td>${f4(t.adhesionMm2)}</td><td>${f1(t.wornPct)}</td><td>${f3(t.rimDepthMm)}</td></tr>`).join('')}
<tr><td><b>Total</b></td><td></td><td>${f4(E.total.landMm2)}</td><td><b>${f4(E.total.wornMm2)}</b></td><td>${f4(E.total.flankMm2)}</td><td>${f4(E.total.chippingMm2)}</td><td>${f4(E.total.adhesionMm2)}</td><td>${f1(E.total.wornPct)}</td><td></td></tr></table>
<p class="note">Source: ${E.source === 'network' ? 'network segmentation of the end face' : 'brightness rule (coating loss)'} · ${f1(E.pxPerMm)} px/mm · land = end face without the flute gullies.</p></div></div>` : '<p class="note">No top (end-face) photo, or the end-face circle was not found.</p>'}
<h2>All flutes</h2><div class="imgs">${all}${snap ? `<figure><img src="${url(snap)}"><figcaption>3D model</figcaption></figure>` : ''}</div>
${tol ? `<h2>Tolerance verdict — ${tol.pass == null ? '-' : tol.pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>'}</h2><table><tr><th>Item</th><th>value</th><th>limit</th><th>result</th></tr>${tol.rows.map(r => `<tr><td>${esc(r.label)}</td><td>${r.value == null ? '-' : (r.unit === 'mm²' ? f4(r.value) : f3(r.value)) + ' ' + r.unit}</td><td>${r.limit} ${r.unit}</td><td>${r.pass == null ? '-' : r.pass ? '<span class="pass">PASS</span>' : '<span class="fail">FAIL</span>'}</td></tr>`).join('')}</table>` : ''}
<h2>Uncertainty budget — F${wi + 1} (standard uncertainties, mm)</h2>
<table><tr><th></th><th>scale</th><th>edge</th><th>repeat.</th><th>helix</th><th>U (k=2)</th></tr>${[['VBmax', B.vbMax], ['VBB', B.vbb], ['VBC', B.vbc], ['VBN', B.vbn]].map(([n, b]) => `<tr><td>${n}</td><td>${f3(b.parts && b.parts.scale)}</td><td>${f3(b.parts && b.parts.edge)}</td><td>${f3(b.parts && b.parts.rep)}</td><td>${f3(b.parts && b.parts.helix)}</td><td><b>${f3(b.U)}</b></td></tr>`).join('')}</table>
<p class="note">Calibration: ${d.calib.method === 'diameter' ? `tool diameter Ø${d.D} ± ${S.prefs.diaTolMm} mm` : d.calib.method === 'reference' ? `reference target ${S.prefs.refMm} mm (deviation vs diameter ${d.calib.deviationPct.toFixed(2)} %)` : esc(d.calib.method)}; ${Object.entries(d.calib.parts || {}).map(([k, v]) => `${k} ${(100 * v).toFixed(2)} %`).join(', ')}.</p>
${d.manual.length ? `<h2>Manual measurements</h2><table><tr><th>Type</th><th>Flute</th><th>Value mm</th><th>U mm</th></tr>${d.manual.map(mm => `<tr><td>${mm.kind}</td><td>F${mm.flute}</td><td>${f3(mm.mm)}</td><td>${f3(mm.U)}</td></tr>`).join('')}</table>` : ''}
<p class="note">${esc(METHOD)}</p>
${T.postReport && T.postReport.html ? T.postReport.html() || '' : ''}
<footer><span>Tool3D measurement — estimate from photographs, not a certified measurement.</span><span>Signature: ____________________</span></footer></body></html>`;
  }

  T.metroReport = {
    pdfBytes: pdf, htmlDoc,
    pdf() { const b = pdf(); if (b) save(`tool3d-report-${safeId()}-${fileStamp()}.pdf`, new Blob([b], {type: 'application/pdf'})); return b; },
    html() { const h = htmlDoc(); if (h) save(`tool3d-report-${safeId()}-${fileStamp()}.html`, new Blob([h], {type: 'text/html'})); return h; },
    print() { const h = htmlDoc(); if (!h) return; const w = window.open('', '_blank'); if (!w) return this.html(); w.document.write(h); w.document.close(); setTimeout(() => { try { w.print(); } catch (e) { /* closed */ } }, 600); },
    csv() {
      if (!ready()) return null; const d = data();
      const t = M.csv(d) + (T.metroVb ? T.metroVb.csvSections(d) : '') + (T.postReport && T.postReport.csv ? String.fromCharCode(13, 10) + (T.postReport.csv() || '') : '');
      save(`tool3d-${safeId()}-${fileStamp()}.csv`, new Blob(['﻿' + t], {type: 'text/csv'})); return t;
    }
  };
})();
