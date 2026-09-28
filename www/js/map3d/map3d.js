/* Tool3D map3d, browser adapter. Needs map3d-core.js, js/wear and js/render loaded.
 * Tool3D.map3d.run({shots, flutes, diameterMm})  call after Tool3D.render.update() (index.html analyze hook)
 *   faces: window.Tool3D.faceSeg when the segmentation model published it (board contract), else derived from the
 *   current wear pipeline (js/wear strips: flank band + tip chipping; top photo: bright end-face area).
 *   -> evaluate on the parametric model, colour classes + deform chips in the viewer, wearResult.faces / facesTotals /
 *      facesPerTooth, rows in the results table (#res), faceSeg[i].areasMm2.
 * Tool3D.map3d.apply(faces, {source})  same with explicit contract faces (tests, seg worker)
 * Tool3D.map3d.mock()                  synthetic faces on the current model (flagged mock)
 */
(function () {
  'use strict';
  const T = window.Tool3D = window.Tool3D || {}, C = T.map3dCore;
  if (!C) { console.warn('map3d: map3d-core.js missing'); return; }
  const f3 = v => (+v || 0).toFixed(3), f4 = v => (+v || 0).toFixed(4);

  function deriveFaces(shots, k, D) {
    const dbg = T.wearDebug; if (!dbg || !dbg.strips) return [];
    const faces = [];
    dbg.strips.forEach((e, i) => { if (e && e.strip && e.band && i < k) faces.push(C.faceFromStrip(e, i, k, D)); });
    if (shots && shots[k] && dbg.top && T.wear && T.wear.toImage) {
      try { const f = C.faceFromTop(T.wear.toImage(shots[k]), dbg.top, D); if (f) faces.push(f); } catch (e) { console.warn('map3d top:', e); }
    }
    return faces;
  }

  function freshSeg(k) {
    const s = T.faceSeg;
    return Array.isArray(s) && s.length && !s.derived && s.filter(f => !/^top|end/i.test(f.face || '')).length <= k ? s : null;
  }

  function apply(faces, o = {}) {
    const R3 = T.render, G = T._render && T._render.geometry;
    if (!R3 || !R3.params || !G || !faces || !faces.length) return null;
    const q = R3.params, layout = G.layout(q), t0 = performance.now();
    const res = C.evaluate(faces, {diameterMm: q.diameterMm, flutes: q.flutes, helixDeg: q.helixDeg, clearanceDeg: q.clear1Deg,
      cornerRadiusMm: q.cornerRadiusMm, layout});
    res.params = {flutes: q.flutes, diameterMm: q.diameterMm};
    res.mock = !!o.mock; res.source = o.source || faces[0].source || 'faceSeg';
    R3.setMap(res);
    // removed volume on the rendered model (same mesh resolution with / without the deformation)
    res.chipVolumeModelMm3 = res.totals.chip.areaMm2 > 0 ? Math.max(0, +(R3.volume(false) - R3.volume(true)).toFixed(4)) : 0;
    R3.refresh();                                              // HUD with the model volume
    res.ms = Math.round(performance.now() - t0);
    faces.forEach((f, i) => { f.areasMm2 = res.faces[i] && res.faces[i].areasMm2; });
    publish(res);
    return res;
  }

  function publish(res) {
    const out = res.faces.map(f => Object.assign({}, f));
    // chip volume = material removed from the rendered model; the envelope figure (mask on the r = D/2 cylinder) is an upper bound
    const chip = Object.assign({}, res.totals.chip, {volumeMm3: res.chipVolumeModelMm3, volumeEnvelopeMm3: res.totals.chip.volumeMm3});
    const totals = Object.assign({}, res.totals, {chip, totalVolumeMm3: +(res.totals.flank.volumeMm3 + res.chipVolumeModelMm3).toFixed(4), source: res.source, mock: res.mock, model: res.model});
    const wr = T.wearResult;
    if (wr) { wr.faces = out; wr.facesTotals = totals; wr.facesPerTooth = res.perTooth; }
    T.map3dResult = {faces: out, totals, perTooth: res.perTooth, ms: res.ms};
    rows(res);
    window.dispatchEvent(new CustomEvent('tool3d:map3d', {detail: T.map3dResult}));
  }

  function rows(res) {
    const tb = document.querySelector('#res'); if (!tb) return;
    tb.querySelectorAll('tr[data-map3d]').forEach(r => r.remove());
    const t = res.totals, name = {2: 'F', 3: 'C', 4: 'A'};
    const src = res.mock ? 'mock' : res.source === 'wear-pipeline' ? '마모 파이프라인 파생' : 'AI 세그멘테이션';
    const add = (a, b) => { const tr = document.createElement('tr'); tr.dataset.map3d = ''; tr.innerHTML = `<td>${a}</td><td>${b}</td>`; tb.append(tr); };
    add('3D 매핑 (면별 세그멘테이션)', `${res.faces.length}면 · ${src} · F 플랭크 / C 치핑 / A 응착 (모델 표면 mm²)`);
    for (const f of res.faces) add(`&nbsp;&nbsp;${f.face} ${f.kind === 'top' ? '(끝면)' : f.angleDeg.toFixed(0) + '°'}`,
      [2, 3, 4].map(c => `${name[c]} ${f3(f.areasMm2[c])}`).join(' · ') + ' mm²');
    add('3D 매핑 면적 합 (중복 블렌딩)', `F ${f3(t.flank.areaMm2)} · C ${f3(t.chip.areaMm2)} · A ${f3(t.adhesion.areaMm2)} = ${f3(t.totalAreaMm2)} mm²`);
    add('3D 매핑 체적', `플랭크 ${f4(t.flank.volumeMm3)} + 치핑 ${f4(res.chipVolumeModelMm3)} mm³ (치핑 최대 깊이 ${f3(t.chip.maxDepthMm)} mm, 추정)`);
    add('3D 매핑 날별 VBmax', res.perTooth.map(p => f3(p.vbMaxMm)).join(', ') + ' mm');
  }

  function run(o) {
    const k = o.flutes, D = o.diameterMm, seg = freshSeg(k);
    let faces = seg, source = seg ? (seg[0] && seg[0].source) || 'segmentation' : 'wear-pipeline';
    if (!faces) {
      faces = deriveFaces(o.shots, k, D);
      faces.derived = true;
      T.faceSeg = faces;
    }
    try { return apply(faces, {source}); } catch (e) { console.warn('map3d:', e); return null; }
  }

  function mock() {
    const q = T.render && T.render.params; if (!q) return null;
    const faces = C.mock(q.flutes, q.diameterMm, 40, T._render.geometry.layout(q));
    return apply(faces, {mock: true, source: 'mock'});
  }

  T.map3d = {run, apply, mock, deriveFaces};
})();
