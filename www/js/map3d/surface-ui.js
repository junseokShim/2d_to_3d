/* Tool3D section ③ surface metrology panel: 3D evaluations of the measured model under the viewer (#surf).
 * Needs map3d-core.js, surface-metrology.js, js/render. Runs after every map3d result ('tool3d:map3d'):
 *   deviation vs nominal -> viewer colour map (Deviation mode, um scale bar), per-flute labels in the 3D view,
 *   per-flute table (VBmax, equivalent edge radius, edge recession, worn area side / end face, wear volume, chip depth, Dmin),
 *   edge sections normal to the cutting edge (nominal vs worn + inscribed edge radius), deviation statistics per face,
 *   chips, tolerance check, tool-life trend (wear volume per measurement, browser storage), section profile along a
 *   line picked on the model ('tool3d:profile-line'), CSV + PNG export.
 * Publishes window.Tool3D.surfaceResult and 'tool3d:surface' (report / section ④ may read it).
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, P = T.surfaceCore, C = T.map3dCore;
  if (!P || !C) { console.warn('surface-ui: surface-metrology.js / map3d-core.js missing'); return; }
  const $ = s => document.querySelector(s);
  const f1 = v => v == null ? '—' : (+v).toFixed(1), f3 = v => v == null ? '—' : (+v).toFixed(3), f4 = v => v == null ? '—' : (+v).toFixed(4);
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  let cur = null, prof = null;

  const CSS = `
#surf{margin-top:12px}
#surf .sh{display:flex;flex-wrap:wrap;align-items:center;gap:8px;justify-content:space-between;border-bottom:2px solid #1f5fbf;padding-bottom:6px}
#surf .sh b{font-size:15px}#surf .sh .src{font-size:12px;color:var(--mut)}
#surf .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,360px),1fr));gap:12px;margin-top:10px}
#surf .card{border:1px solid var(--line);border-radius:8px;padding:8px 10px;background:#fbfcfd;min-width:0}
#surf .card h4{margin:0 0 6px;font-size:13px;color:#24406e;display:flex;justify-content:space-between;gap:6px}
#surf table{margin-top:0;font-size:12.5px}#surf th{font-weight:600;text-align:right;padding:4px;border-bottom:1px solid #9aa6b8;white-space:nowrap}
#surf th:first-child,#surf td:first-child{text-align:left}#surf td{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
#surf tr.tot td{font-weight:600;border-top:1px solid #9aa6b8}
#surf .tw{overflow-x:auto}
#surf .ok{color:#16723a;font-weight:600}#surf .ng{color:#a8261e;font-weight:600}
#surf .secs{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px}
#surf .secs figure{margin:0;text-align:center;font-size:11px}#surf svg{width:100%;height:auto;display:block}
#surf .note{font-size:11px;color:var(--mut);margin-top:6px}
#surf input.tid{width:9em;padding:5px 8px;border:1px solid var(--line);border-radius:6px;font:inherit;font-size:13px}`;

  function ensure() {
    let el = $('#surf');
    if (!el) { const sec = $('#tool3d-view') && $('#tool3d-view').closest('section'); if (!sec) return null; el = document.createElement('div'); el.id = 'surf'; sec.append(el); }
    if (!$('#surf-css')) { const st = document.createElement('style'); st.id = 'surf-css'; st.textContent = CSS; document.head.append(st); }
    return el;
  }

  // ---------- compute ----------
  function compute() {
    const R3 = T.render, G = T._render && T._render.geometry, res = R3 && R3.map;
    if (!res || !res.atlas || !R3.params || !G) return null;
    const q = R3.params, L = G.layout(q), look = C.toothLookup(L), lookEnd = C.toothLookup(Object.assign({}, L, {tanH: 0}));
    const o = {clearanceDeg: q.clear1Deg, rakeDeg: q.rakeDeg, helixDeg: q.helixDeg, landMm: L.land1Mm + L.land2Mm, lookEnd};
    const dev = P.deviation(res.atlas, look, o), stats = P.volumeStats(dev, P.DEFAULTS.devTolUm);
    const flutes = P.perFlute(dev, res.atlas, look, L, res.perTooth || [], o);
    const faces = P.perFace(dev, res.faces || [], res.atlas.azSign, P.DEFAULTS.devTolUm);
    const chips = P.chips(res.atlas, look, o);
    const endArea = res.totals.endAreaMm2 || {}, endWornMm2 = P.r4((endArea[2] || 0) + (endArea[3] || 0));
    const tol = P.tolerance({devMaxUm: -stats.DminUm, chipDepthUm: Math.max(0, ...flutes.map(f => f.chipDepthUm)), vdvMm3: stats.VdvMm3,
      wearVolumeMm3: Math.max(0, ...flutes.map(f => f.volumeMm3))});
    return {params: {flutes: q.flutes, diameterMm: q.diameterMm, helixDeg: q.helixDeg, hand: q.hand, clearanceDeg: q.clear1Deg, rakeDeg: q.rakeDeg},
      L, dev, stats, flutes, faces, chips, endWornMm2, tol, mock: !!res.mock, source: res.source,
      totals: {wearVolumeMm3: P.r4(flutes.reduce((s, f) => s + f.volumeMm3, 0)), wornAreaMm2: P.r4(flutes.reduce((s, f) => s + f.wornAreaMm2, 0)), endWornMm2}};
  }

  // flute labels: on the envelope at the cutting edge of each tooth, a quarter diameter above the tip
  function edgeLabels(S) {
    const L = S.L, R = L.R, z = .25 * S.params.diameterMm, out = [];
    S.flutes.forEach((f, t) => {
      const cols = L.cols.filter(c => c.tooth === t && c.s >= 0 && c.s < 50); if (!cols.length) return;
      const c = cols.reduce((b, x) => x.s < b.s ? x : b), a = Math.atan2(c.y, c.x) + L.tanH * z;
      out.push({pos: [1.04 * R * Math.cos(a), 1.04 * R * Math.sin(a), z], cls: 'F' + f.flute,
        text: `F${f.flute}  V ${f4(f.volumeMm3)} mm³\nrβ ${f1(f.edgeRadiusUm)} µm  VB ${f1(f.vbMaxUm)} µm`});
    });
    return out;
  }

  // ---------- drawings ----------
  // edge section normal to the cutting edge: nominal wedge (dashed), worn profile, inscribed edge radius
  function sectionSvg(f) {
    const s = f.section, pts = s.nominal.concat(s.worn), W = 150, H = 120;
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs, 0), y0 = Math.min(...ys), y1 = Math.max(...ys, 0);
    const sc = Math.min((W - 20) / ((x1 - x0) || 1), (H - 20) / ((y1 - y0) || 1)), X = x => 10 + (x - x0) * sc, Y = y => 10 + (y1 - y) * sc;
    const pl = a => a.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ');
    const r = s.edgeRadiusUm / 1000 * sc;
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="F${f.flute} edge section"><rect width="${W}" height="${H}" fill="#fff"/>` +
      `<polyline points="${pl(s.nominal)}" fill="none" stroke="#8a94a6" stroke-dasharray="4 3" stroke-width="1.2"/>` +
      `<polygon points="${pl(s.worn)} ${X(s.worn[0][0] - .001)},${Y(s.worn[s.worn.length - 1][1])}" fill="#c9d6ea" stroke="none" opacity=".55"/>` +
      `<polyline points="${pl(s.worn)}" fill="none" stroke="#1f5fbf" stroke-width="1.8"/>` +
      (r > .5 ? `<circle cx="${X(s.centre[0]).toFixed(1)}" cy="${Y(s.centre[1]).toFixed(1)}" r="${r.toFixed(1)}" fill="none" stroke="#d9480f" stroke-width="1.2"/>` : '') +
      `<text x="4" y="${H - 4}" font-size="9" fill="#333">rake ↑  clearance ←</text></svg>`;
  }
  // section profile: height (nominal dashed, measured solid) + deviation band below
  function profileSvg(pr) {
    const W = 640, H1 = 170, H2 = 90, pad = 42, pts = pr.points, sMax = pr.lengthMm || 1;
    const hs = pts.flatMap(p => [p.nominalMm, p.measuredMm]), h0 = Math.min(...hs), h1 = Math.max(...hs), hr = (h1 - h0) || 1e-3;
    const X = s => pad + s / sMax * (W - pad - 10), Y = h => 10 + (h1 - h) / hr * (H1 - 20);
    const dv = pts.map(p => p.devUm), dMin = Math.min(-1, ...dv), Yd = d => H1 + 14 + (d / dMin) * (H2 - 24);
    const line = (f, Yf) => pts.map((p, i) => (i ? 'L' : 'M') + X(p.sMm).toFixed(1) + ' ' + Yf(f(p)).toFixed(1)).join('');
    const unit = pr.part === 'end' ? '축 위치 z (mm)' : '반경 r (mm)';
    const iMin = dv.indexOf(Math.min(...dv));
    let ticks = '';
    for (let i = 0; i <= 4; i++) { const s = sMax * i / 4; ticks += `<text x="${X(s).toFixed(1)}" y="${H1 + H2 + 4}" font-size="10" text-anchor="middle" fill="#445">${s.toFixed(2)}</text>`; }
    return `<svg viewBox="0 0 ${W} ${H1 + H2 + 22}" role="img" aria-label="section profile"><rect width="${W}" height="${H1 + H2 + 22}" fill="#fff"/>` +
      `<text x="4" y="12" font-size="10" fill="#445">${unit}</text><text x="4" y="${Y(h1) + 14}" font-size="10" fill="#445">${h1.toFixed(3)}</text><text x="4" y="${Y(h0)}" font-size="10" fill="#445">${h0.toFixed(3)}</text>` +
      `<path d="${line(p => p.nominalMm, Y)}" fill="none" stroke="#8a94a6" stroke-dasharray="5 3" stroke-width="1.3"/>` +
      `<path d="${line(p => p.measuredMm, Y)}" fill="none" stroke="#1f5fbf" stroke-width="1.6"/>` +
      `<line x1="${pad}" x2="${W - 10}" y1="${H1 + 14}" y2="${H1 + 14}" stroke="#16a34a" stroke-width="1"/>` +
      `<path d="${line(p => p.devUm, Yd)}" fill="none" stroke="#d9480f" stroke-width="1.4"/>` +
      `<text x="4" y="${H1 + 18}" font-size="10" fill="#445">0 µm</text><text x="4" y="${Yd(dMin)}" font-size="10" fill="#445">${dMin.toFixed(1)}</text>` +
      (dv[iMin] < 0 ? `<circle cx="${X(pts[iMin].sMm).toFixed(1)}" cy="${Yd(dv[iMin]).toFixed(1)}" r="3" fill="#d9480f"/><text x="${Math.min(W - 120, X(pts[iMin].sMm) + 6).toFixed(1)}" y="${(Yd(dv[iMin]) - 4).toFixed(1)}" font-size="10" fill="#d9480f">Dmin ${dv[iMin].toFixed(1)} µm @ ${pts[iMin].sMm.toFixed(3)} mm</text>` : '') +
      ticks + `<text x="${W - 10}" y="${H1 + H2 + 18}" font-size="10" text-anchor="end" fill="#445">거리 s (mm)</text></svg>`;
  }

  // ---------- panel ----------
  const toolId = () => { const i = $('#surf-tid'); return (i && i.value.trim()) || `${cur ? cur.params.flutes : ''}FL-D${cur ? cur.params.diameterMm : ''}`; };
  function render() {
    const el = ensure(); if (!el) return;
    if (!cur) { el.innerHTML = ''; return; }
    const S = cur, keep = $('#surf-tid') ? $('#surf-tid').value : '';
    const rows = S.flutes.map(f => `<tr><td>F${f.flute}</td><td>${f1(f.vbMaxUm)}</td><td>${f1(f.edgeRadiusUm)}</td><td>${f1(f.recessionUm)}</td><td>${f3(f.wornAreaMm2)}</td><td>${f3(f.endAreaMm2)}</td><td>${f4(f.volumeMm3)}</td><td>${f1(f.chipDepthUm)}</td><td>${f1(f.DminUm)}</td></tr>`).join('');
    const sum = k => S.flutes.reduce((s, f) => s + f[k], 0);
    const tot = `<tr class="tot"><td>합계/최대</td><td>${f1(Math.max(0, ...S.flutes.map(f => f.vbMaxUm)))}</td><td>${f1(Math.max(0, ...S.flutes.map(f => f.edgeRadiusUm)))}</td><td>${f1(Math.max(0, ...S.flutes.map(f => f.recessionUm)))}</td><td>${f3(sum('wornAreaMm2'))}</td><td>${f3(sum('endAreaMm2'))}</td><td>${f4(sum('volumeMm3'))}</td><td>${f1(Math.max(0, ...S.flutes.map(f => f.chipDepthUm)))}</td><td>${f1(Math.min(0, ...S.flutes.map(f => f.DminUm)))}</td></tr>`;
    const st = S.stats, statRows = P.STAT_ROWS.map(r => `<tr><td>${r[0]} <span class="hint">${r[3]}</span></td><td>${r[2] === 'mm³' ? f4(st[r[1]]) : r[2] === 'mm²' ? f3(st[r[1]]) : f1(st[r[1]])} ${r[2]}</td></tr>`).join('');
    const faceRows = S.faces.map(f => `<tr><td>${esc(f.face)}${f.kind === 'side' ? ' ' + Math.round(f.angleDeg) + '°' : ' (끝면)'}</td><td>${f1(f.DminUm)}</td><td>${f4(f.VvMm3)}</td><td>${f4(f.VdvMm3)}</td><td>${f3(f.areaMm2)}</td></tr>`).join('');
    const chipRows = S.chips.slice(0, 8).map(c => `<tr><td>#${c.n} ${c.where === 'end' ? '끝면' : '측면'}${c.tooth == null ? '' : ' F' + (c.tooth + 1)}</td><td>${f3(c.lengthMm)}</td><td>${f3(c.areaMm2)}</td><td>${f1(c.maxDepthUm)}</td><td>${f4(c.volumeMm3)}</td></tr>`).join('');
    const tolRows = S.tol.rows.map(t => `<tr><td>${t.label}</td><td>${t.value == null ? '—' : t.unit === 'mm³' ? f4(t.value) : f1(t.value)}</td><td>≤ ${t.limit} ${t.unit}</td><td class="${t.pass == null ? '' : t.pass ? 'ok' : 'ng'}">${t.pass == null ? '—' : t.pass ? 'OK' : 'NG'}</td></tr>`).join('');
    const hist = P.history(storage(), toolId()), tr = P.trend(hist, P.DEFAULTS.tol.wearVolumeMm3 * S.flutes.length, 'volumeMm3');
    el.innerHTML = `<div class="sh"><b>3D 표면 측정</b><span class="src">${S.mock ? '[MOCK] ' : ''}매핑: ${esc(S.source || '')} · 공칭 모델 대비 · 헬릭스 ${f1(S.params.helixDeg)}° · 여유각 ${S.params.clearanceDeg}° · 경사각 ${S.params.rakeDeg}°</span>
      <span style="display:flex;gap:6px;flex-wrap:wrap"><button type="button" data-act="dev">편차 맵</button><button type="button" data-act="profile">단면 프로파일</button><button type="button" data-act="csv">CSV</button><button type="button" data-act="png">3D 화면 PNG</button></span></div>
      <div class="grid">
        <div class="card" style="grid-column:1/-1"><h4>날별 3D 측정 <span class="hint">VB·rβ·후퇴: 날 직각 단면, 체적: 공칭면 아래</span></h4><div class="tw"><table id="surf-flutes">
          <tr><th>날</th><th>VBmax µm</th><th>등가 날 반경 rβ µm</th><th>날끝 후퇴 µm</th><th>마모 면적 mm²</th><th>끝면 마모 면적 mm²</th><th>마모 체적 mm³</th><th>치핑 깊이 µm</th><th>Dmin µm</th></tr>${rows}${tot}</table></div>
          <div class="note">끝면(윗면) 마모 면적 합 ${f3(S.endWornMm2)} mm² · 등가 날 반경 = 여유면·경사면·마모 랜드에 접하는 내접원 반경 (사진 기반 쐐기 모델, 높이 미측정)</div></div>
        <div class="card"><h4>날 직각 단면 <span class="hint">점선 공칭 · 실선 마모 · 원 rβ</span></h4><div class="secs">${S.flutes.map(f => `<figure>${sectionSvg(f)}<figcaption>F${f.flute} · VB ${f1(f.vbMaxUm)} · rβ ${f1(f.edgeRadiusUm)} µm</figcaption></figure>`).join('')}</div></div>
        <div class="card"><h4>편차 통계 (공칭 대비) <span class="hint">허용 ${st.tolUm} µm</span></h4><table>${statRows}</table>
          <div class="tw"><table style="margin-top:8px"><tr><th>면</th><th>Dmin µm</th><th>Vv mm³</th><th>Vdv mm³</th><th>A mm²</th></tr>${faceRows}</table></div></div>
        <div class="card"><h4>판정 <span class="${S.tol.pass == null ? '' : S.tol.pass ? 'ok' : 'ng'}">${S.tol.pass == null ? '—' : S.tol.pass ? '합격' : '불합격'}</span></h4><table><tr><th>항목</th><th>값</th><th>기준</th><th></th></tr>${tolRows}</table>
          <h4 style="margin-top:10px">치핑 ${S.chips.length}개</h4><div class="tw"><table><tr><th>위치</th><th>길이 mm</th><th>면적 mm²</th><th>깊이 µm</th><th>체적 mm³</th></tr>${chipRows || '<tr><td colspan="5">없음</td></tr>'}</table></div></div>
        <div class="card"><h4>공구 수명 (마모 체적 추이)</h4><div class="ctl" style="margin-top:0"><label>공구 ID <input id="surf-tid" class="tid" value="${esc(keep)}" placeholder="${esc(toolId())}"></label><button type="button" data-act="rec">현재 측정 기록</button></div>
          ${trendSvg(hist)}<div class="note">${hist.length} 회 기록${tr ? ` · 측정당 +${f4(tr.slope)} mm³` + (tr.remaining != null ? ` · 한계(날당 ${P.DEFAULTS.tol.wearVolumeMm3} mm³)까지 약 ${f1(tr.remaining)} 회` : '') : ''}</div></div>
        <div class="card" style="grid-column:1/-1" id="surf-profile"><h4>단면 프로파일 <span class="hint">3D 화면에서 [Profile] 후 두 점 클릭 · 점선 공칭 · 실선 측정 · 아래 편차</span></h4>${prof ? profileSvg(prof) + `<div class="note">${prof.part === 'end' ? '끝면' : '측면'} · 길이 ${f3(prof.lengthMm)} mm · 높이차 ${f3(prof.heightRangeMm)} mm · Dmin ${f1(prof.devMinUm)} µm @ ${f3(prof.sAtMinMm)} mm</div>` : '<div class="note">선을 지정하면 표시됩니다. 빠른 선택: <button type="button" data-act="p-circ">원주 (z = 0.3D)</button> <button type="button" data-act="p-edge">F1 절삭날 방향</button> <button type="button" data-act="p-end">끝면 지름</button></div>'}</div>
      </div>`;
  }
  function trendSvg(h) {
    if (h.length < 2) return '<div class="note">2회 이상 기록하면 추이가 표시됩니다.</div>';
    const W = 300, H = 90, ys = h.map(e => e.volumeMm3), m = Math.max(...ys) || 1, X = i => 24 + i / (h.length - 1) * (W - 34), Y = v => H - 14 - v / m * (H - 24);
    return `<svg viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="#fff"/><path d="${ys.map((v, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1)).join('')}" fill="none" stroke="#1f5fbf" stroke-width="1.6"/>` +
      ys.map((v, i) => `<circle cx="${X(i).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="2.5" fill="#1f5fbf"/>`).join('') + `<text x="2" y="10" font-size="9" fill="#445">${m.toFixed(4)} mm³</text></svg>`;
  }
  function storage() { try { return window.localStorage; } catch (e) { return {getItem: () => null, setItem() {}}; } }

  function csv() {
    const S = cur; if (!S) return '';
    const L = [], row = a => L.push(a.map(v => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : v).join(','));
    row(['Tool3D 3D surface metrology']); row(['model', 'nominal parametric end mill; depths from the wedge model (VB tan clearance) and map3d chip depth; photos give no height']);
    row(['flutes', S.params.flutes, 'diameter_mm', S.params.diameterMm, 'helix_deg', S.params.helixDeg, 'clearance_deg', S.params.clearanceDeg, 'rake_deg', S.params.rakeDeg]);
    row([]); row(['flute', 'VBmax_um', 'edge_radius_um', 'recession_um', 'worn_area_mm2', 'end_area_mm2', 'wear_volume_mm3', 'chip_depth_um', 'Dmin_um']);
    S.flutes.forEach(f => row(['F' + f.flute, f.vbMaxUm, f.edgeRadiusUm, f.recessionUm, f.wornAreaMm2, f.endAreaMm2, f.volumeMm3, f.chipDepthUm, f.DminUm]));
    row(['end_face_worn_area_mm2', S.endWornMm2]);
    row([]); row(['deviation'].concat(P.STAT_ROWS.map(r => r[0] + '_' + r[2].replace('µ', 'u').replace('³', '3').replace('²', '2'))));
    row(['model'].concat(P.STAT_ROWS.map(r => S.stats[r[1]]))); S.faces.forEach(f => row([f.face].concat(P.STAT_ROWS.map(r => f[r[1]]))));
    if (S.chips.length) { row([]); row(['chip', 'where', 'flute', 'z0_mm', 'z1_mm', 'length_mm', 'area_mm2', 'max_depth_um', 'volume_mm3']); S.chips.forEach(c => row([c.n, c.where, c.tooth == null ? '' : c.tooth + 1, c.z0Mm, c.z1Mm, c.lengthMm, c.areaMm2, c.maxDepthUm, c.volumeMm3])); }
    row([]); row(['tolerance', 'value', 'limit', 'unit', 'pass']); S.tol.rows.forEach(t => row([t.key, t.value, t.limit, t.unit, t.pass == null ? '' : t.pass ? 'PASS' : 'FAIL']));
    if (prof) { row([]); row(['profile_s_mm', 'nominal_mm', 'measured_mm', 'dev_um']); prof.points.forEach(p => row([p.sMm, p.nominalMm, p.measuredMm, p.devUm])); }
    return L.join('\r\n') + '\r\n';
  }
  function save(name, blob) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); }

  function presetLine(kind) {
    if (!cur || !T.render) return;
    const L = cur.L, R = L.R, D = cur.params.diameterMm;
    if (kind === 'p-end') { T.render.addPick([-.8 * R, 0, 0], 'end'); T.render.addPick([.8 * R, 0, 0], 'end'); return; }
    if (kind === 'p-circ') { const z = .3 * D; T.render.addPick([R, 0, z], 'side'); T.render.addPick([R * Math.cos(2.4), R * Math.sin(2.4), z], 'side'); return; }
    const c = L.cols.filter(x => x.tooth === 0 && x.s >= 0 && x.s < 50).reduce((b, x) => x.s < b.s ? x : b, {s: 1e9, x: R, y: 0}), a0 = Math.atan2(c.y, c.x) - .02;
    const z1 = Math.min(1.2 * D, L.zTwistMax);
    T.render.addPick([R * Math.cos(a0), R * Math.sin(a0), 0], 'side'); T.render.addPick([R * Math.cos(a0 + L.tanH * z1), R * Math.sin(a0 + L.tanH * z1), z1], 'side');
  }

  function onClick(e) {
    const b = e.target.closest && e.target.closest('#surf button[data-act]'); if (!b) return;
    const a = b.dataset.act;
    if (a === 'dev') T.render.mode('dev');
    else if (a === 'profile') { T.render.profileMode(true); $('#tool3d-view').scrollIntoView({block: 'center', behavior: 'smooth'}); }
    else if (a === 'csv') save('surface_3d.csv', new Blob(['﻿' + csv()], {type: 'text/csv'}));
    else if (a === 'png') fetch(T.render.snapshot()).then(r => r.blob()).then(bl => save('view_3d.png', bl));
    else if (a === 'rec') { P.historyAdd(storage(), toolId(), {t: Date.now(), volumeMm3: cur.totals.wearVolumeMm3, vbMaxUm: Math.max(0, ...cur.flutes.map(f => f.vbMaxUm))}); render(); }
    else if (/^p-/.test(a)) presetLine(a);
  }

  function run() {
    let S = null;
    try { S = compute(); } catch (e) { console.warn('surface-ui:', e); }
    cur = S; prof = null;
    if (T.render) { T.render.setDeviation(S ? S.dev : null); T.render.setLabels(S ? edgeLabels(S) : []); T.render.clearProfile(); }
    const out = S && {params: S.params, flutes: S.flutes.map(f => Object.assign({}, f)), stats: S.stats, faces: S.faces, chips: S.chips, endWornMm2: S.endWornMm2,
      tolerance: S.tol, totals: S.totals, mock: S.mock, source: S.source, snapshot: () => T.render.snapshot(), csv};
    T.surfaceResult = out || null;
    render();
    window.dispatchEvent(new CustomEvent('tool3d:surface', {detail: T.surfaceResult}));
    return T.surfaceResult;
  }
  function onProfile(e) {
    if (!cur) return;
    const d = e.detail, rNom = P.nominalRadius(cur.L);
    prof = P.profile({p0: d.p0, p1: d.p1, part: d.part, rNom, endZ: cur.L.endZ, dev: cur.dev, n: 300});
    if (T.surfaceResult) T.surfaceResult.profile = prof;
    render();
    const card = $('#surf-profile'); if (card && T.render) T.render.profileMode(false);
    window.dispatchEvent(new CustomEvent('tool3d:surface-profile', {detail: prof}));
  }

  window.addEventListener('tool3d:map3d', () => setTimeout(run, 0));
  window.addEventListener('tool3d:profile-line', onProfile);
  document.addEventListener('click', onClick);
  T.surface = {run, csv, get result() { return T.surfaceResult; }, get profile() { return prof; }};
})();
