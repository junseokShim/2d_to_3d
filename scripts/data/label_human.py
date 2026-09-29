"""Ground-truth labels for the human's USB-microscope photos (datasets/human_samples/공구 이미지, 27 JPG 640x480, purple backlight, tip up).
Classes: 0 background, 1 tool, 2 flank wear land, 3 chipping/fracture, 4 adhesion, 255 ignore.
Inputs: scripts/data/human_spec.json (hand work, per image, original pixel coords):
  view      'side' | 'top'
  roi2/roi3/roi4   polygons: the class is the BRIGHT part of the polygon inside the tool (auto threshold, filled) -> crisp boundaries
  poly2/poly3/poly4 polygons: the class is the whole polygon (inside the tool)
  ign       polygons -> 255 (uncertain); bg / tool polygons force the silhouette; tipX [x0, x1] columns used for the tip line fit
  thr       optional fixed grey threshold for roi*; pxPerMm optional override (+ pxPerMmNote)
Tool silhouette: smooth backdrop colour model seeded from the top/side borders (+ bottom corners), then spec fixes.
Metrics per image (mm, ISO 8688-2 style, see DEFS) -> datasets/toolwear/reference/human_gt.json; images/masks/labelinfo -> processed/hum_*.
  python label_human.py [--root C:/agent_research_team/datasets/toolwear] [--only 10-1-1] [--prev DIR]
"""
import argparse, glob, json, os, re
import cv2, numpy as np

SRC = 'C:/agent_research_team/datasets/human_samples/공구 이미지'
HERE = os.path.dirname(os.path.abspath(__file__))
TOOLS = {'10Pi_1': 10.0, '10Pi_2': 10.0, '12Pi': 12.0}
DEFS = {
    'tipLine': 'side view: straight line fitted to the intact top silhouette (end of the tool); top view: circle fitted to the intact outer silhouette',
    'chipDepthMm': 'max distance of class-3 pixels from the tip line (side) or inward from the outer circle (top)',
    'vbcMm': 'max distance from the tip line of any wear/chip/adhesion pixel (2,3,4) in the region connected to the tip (corner wear incl. chipping, ISO 8688-2 VBC-like)',
    'vbMaxMm': 'class-2 land width measured perpendicular to the land axis (principal axis of each connected land), max over the land; null when no class 2',
    'vbMeanMm': 'mean of that width profile (bins of 0.1 mm along the axis)',
    'areaMm2': 'pixel area per class / pxPerMm^2',
}


def imread(p):
    return cv2.imdecode(np.fromfile(p, np.uint8), cv2.IMREAD_COLOR)


def bgmask(im, T=26, tex_t=7):
    lab = cv2.cvtColor(cv2.GaussianBlur(im, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)
    h, w = im.shape[:2]
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY).astype(np.float32)
    tex = cv2.blur(np.abs(cv2.Laplacian(cv2.GaussianBlur(g, (3, 3), 0), cv2.CV_32F)), (9, 9))
    refs = []
    for (y0, y1, x0, x1) in [(0, 12, 0, w), (0, h, 0, 12), (0, h, w - 12, w), (h - 40, h, 0, 40), (h - 40, h, w - 40, w)]:
        p = lab[y0:y1, x0:x1].reshape(-1, 3); t = tex[y0:y1, x0:x1].reshape(-1)
        p = p[(t < tex_t) & (p[:, 0] > 90)]
        if len(p) < 50: continue
        Z = p[::max(1, len(p) // 3000)].astype(np.float32)
        cv2.setRNGSeed(0)
        _, _, c = cv2.kmeans(Z, 3, None, (3, 20, .5), 3, cv2.KMEANS_PP_CENTERS); refs += list(c)
    refs = np.array(refs)
    d = np.min(np.sqrt(((lab[:, :, None, :] - refs[None, None]) ** 2).sum(3)), 2)
    cand = ((d < T) & (tex < tex_t) & (lab[:, :, 0] > 90)).astype(np.uint8)
    n, lbl, st, _ = cv2.connectedComponentsWithStats(cand, 4)
    keep = np.zeros(n, bool)
    for b in set(lbl[0]) | set(lbl[:, 0]) | set(lbl[:, -1]) | set(lbl[-1, :40]) | set(lbl[-1, -40:]):
        if b and st[b, 4] > 1500: keep[b] = True
    return keep[lbl]


def polymask(shape, polys):
    m = np.zeros(shape[:2], np.uint8)
    for p in polys or []:
        cv2.fillPoly(m, [np.array(p, np.int32)], 1)
    return m.astype(bool)


def tool_mask(im, sp):
    tool = ~bgmask(im)
    tool = cv2.morphologyEx(tool.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8)).astype(bool)
    tool |= polymask(im.shape, sp.get('tool'))
    tool &= ~polymask(im.shape, sp.get('bg'))
    n, lbl, st, _ = cv2.connectedComponentsWithStats(tool.astype(np.uint8), 8)
    if n > 1:
        big = 1 + int(np.argmax(st[1:, 4])); tool = lbl == big
    # fill holes (backdrop can't be enclosed by the tool in these views)
    inv = (~tool).astype(np.uint8); n, lbl, st, _ = cv2.connectedComponentsWithStats(inv, 4)
    h, w = tool.shape
    border = set(lbl[0]) | set(lbl[-1]) | set(lbl[:, 0]) | set(lbl[:, -1])
    for b in range(1, n):
        if b not in border: tool[lbl == b] = True
    return tool


def bright_in(im, roi, tool, thr=None):
    g = cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
    sel = roi & tool
    if sel.sum() < 20: return np.zeros_like(roi), 0
    if thr is None:
        thr, _ = cv2.threshold(g[sel].reshape(-1, 1), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    b = ((cv2.GaussianBlur(g, (3, 3), 0) > thr) & sel).astype(np.uint8)
    b = cv2.morphologyEx(b, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    n, lbl, st, _ = cv2.connectedComponentsWithStats(b, 8)
    out = np.zeros_like(roi)
    for i in range(1, n):
        if st[i, 4] >= 40: out |= lbl == i
    inv = (~out).astype(np.uint8); n, lbl, st, _ = cv2.connectedComponentsWithStats(inv, 4)
    for i in range(1, n):  # fill small holes (dark pits inside the fracture face)
        if st[i, 4] < 400 and (lbl == i).any(): out |= (lbl == i) & sel
    return out & sel, float(thr)


def tip_line(tool, sp):
    """side view: fit y = a*x + b to the top silhouette over intact columns."""
    h, w = tool.shape
    xs, ys = [], []
    x0, x1 = sp.get('tipX', [0, w])
    for x in range(max(0, x0), min(w, x1)):
        c = np.flatnonzero(tool[:, x])
        if len(c) and c[0] < h * .6: xs.append(x); ys.append(c[0])
    xs, ys = np.array(xs, float), np.array(ys, float)
    keep = np.ones(len(xs), bool)
    for _ in range(6):
        a, b = np.polyfit(xs[keep], ys[keep], 1)
        r = ys - (a * xs + b)
        keep = (r < 3) & (r > -6)  # chipped/notched columns sit below the line (r>0)
        if keep.sum() < 20: break
    a, b = np.polyfit(xs[keep], ys[keep], 1)
    return float(a), float(b), float(np.std((ys - (a * xs + b))[keep]))


def fit_circle(tool):
    cs, _ = cv2.findContours(tool.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    p = max(cs, key=len)[:, 0, :].astype(float)
    keep = np.ones(len(p), bool)
    for _ in range(6):
        A = np.c_[2 * p[keep], np.ones(keep.sum())]; bb = (p[keep] ** 2).sum(1)
        cx, cy, c = np.linalg.lstsq(A, bb, rcond=None)[0]; R = np.sqrt(c + cx * cx + cy * cy)
        r = np.hypot(p[:, 0] - cx, p[:, 1] - cy) - R
        keep = r > -4  # notches (chipped corners, flute gaps) lie inside the circle
    return float(cx), float(cy), float(R)


def end_face(im, tool):
    """top view: ellipse fitted to the dark end face (the grey band outside it is the side surface of the tilted tool); major axis = D."""
    g = cv2.GaussianBlur(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY), (5, 5), 0)
    core = ((g < 100) & tool).astype(np.uint8)
    core = cv2.morphologyEx(core, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (31, 31)))
    cs, _ = cv2.findContours(core, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    c = cv2.convexHull(max(cs, key=cv2.contourArea))
    return cv2.fitEllipse(c)


def side_width(tool, a, b):
    """silhouette width (px) in rows 10..150 px below the tip line (tool diameter near the tip)."""
    h, w = tool.shape; ws = []
    for y in range(int(b + 10), min(h, int(b + 150))):
        c = np.flatnonzero(tool[y]);
        if len(c) > 10: ws.append(c[-1] - c[0] + 1)
    return float(np.percentile(ws, 90)) if ws else None


def land_width(m, ppm):
    """class-2 land width perpendicular to its principal axis -> (max, mean) mm, per connected land."""
    n, lbl, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    best, means = 0.0, []
    for i in range(1, n):
        if st[i, 4] < 30: continue
        ys, xs = np.nonzero(lbl == i); P = np.c_[xs, ys].astype(float); mu = P.mean(0)
        _, _, vt = np.linalg.svd(P - mu, full_matrices=False)
        u = (P - mu) @ vt[0]; v = (P - mu) @ vt[1]
        bins = np.floor((u - u.min()) / max(1.0, 0.1 * ppm)).astype(int); wid = []
        for k in np.unique(bins):
            vv = v[bins == k]
            if len(vv) > 3: wid.append((np.percentile(vv, 99) - np.percentile(vv, 1) + 1) / ppm)
        if wid: best = max(best, max(wid)); means += wid
    return (round(best, 3), round(float(np.mean(means)), 3)) if means else (None, None)


def run(root, spec, only=None, prev=None):
    P = os.path.join(root, 'processed')
    for d in ('images', 'masks', 'labelinfo'): os.makedirs(os.path.join(P, d), exist_ok=True)
    gt = dict(source='human USB-microscope photos 2026-09-29, ' + SRC, labeller='worker-hlabel (SAM-free colour silhouette + hand ROIs/polygons, zoom-checked)',
              classes={'0': 'background', '1': 'tool', '2': 'flank wear land', '3': 'chipping/fracture', '4': 'adhesion', '255': 'ignore'},
              definitions=DEFS, folds={t: dict(test=t, train=[u for u in TOOLS if u != t]) for t in TOOLS}, images=[])
    for rel, sp in sorted(spec.items()):
        if rel.startswith('_'): continue
        tool_name, fn = rel.split('/'); stem = fn[:-4]
        if only and only not in rel: continue
        D = TOOLS[tool_name]
        mm = re.match(r'(\d+)-(\d)-(\d)$', stem)
        sid = 'hum_%s_%s' % (tool_name, 's%s_%s' % (mm.group(2), mm.group(3)) if mm else 'top')
        im = imread(os.path.join(SRC, rel)); h, w = im.shape[:2]
        tool = tool_mask(im, sp)
        m = np.where(tool, 1, 0).astype(np.uint8)
        thrs = {}
        for c in (2, 4, 3):  # chip painted last (wins)
            cm = polymask(im.shape, sp.get('poly%d' % c)) & tool
            if sp.get('roi%d' % c):
                bm, thrs[c] = bright_in(im, polymask(im.shape, sp['roi%d' % c]), tool, sp.get('thr%d' % c, sp.get('thr')))
                cm |= bm
            for q in sp.get('sub%d' % c, []): cm &= ~polymask(im.shape, [q])
            m[cm] = c
        dmg = np.isin(m, (2, 3, 4))
        k3 = np.ones((2 * sp.get('ringPx', 1) + 1,) * 2, np.uint8)
        ring = (cv2.dilate(dmg.astype(np.uint8), k3) > 0) & ~(cv2.erode(dmg.astype(np.uint8), k3) > 0) & tool
        m[ring] = 255
        m[polymask(im.shape, sp.get('ign')) & (m == 1)] = 255
        view = sp.get('view', 'side')
        info = dict(source='human_usb_microscope', rawImage=SRC + '/' + rel, tool=tool_name, D=D, view=view, side=None, shot=None,
                    labelQuality='manual (hand ROIs/polygons, zoom-checked)', notes=sp.get('notes', ''))
        if mm and view == 'side': info['side'], info['shot'] = int(mm.group(2)), int(mm.group(3))
        met = dict(id=sid, image=rel, tool=tool_name, D=D, view=view, side=info['side'])
        if view == 'side':
            a, b, sd = tip_line(tool, sp); wpx = side_width(tool, a, b)
            full = wpx is not None and sp.get('silhouetteFull', True)
            ppm = sp.get('pxPerMm') or (wpx / D if full else None)
            info.update(tipLine=[round(a, 5), round(b, 2)], tipLineResidPx=round(sd, 2), silhouetteWidthPx=wpx)
            ys, xs = np.mgrid[0:h, 0:w]; depth = (ys - (a * xs + b)) / np.sqrt(1 + a * a)
        else:
            (cx, cy), (ea, eb), ang = end_face(im, tool); R = max(ea, eb) / 2
            ppm = sp.get('pxPerMm') or 2 * R / D
            info.update(circle=[round(cx, 1), round(cy, 1), round(R, 1)], endFaceEllipse=[round(cx, 1), round(cy, 1), round(ea, 1), round(eb, 1), round(ang, 1)])
            ys, xs = np.mgrid[0:h, 0:w]; depth = R - np.hypot(xs - cx, ys - cy)
            if sp.get('topRimIgn'):
                inner = np.zeros((h, w), np.uint8)
                cv2.ellipse(inner, ((cx, cy), (ea * sp['topRimIgn'], eb * sp['topRimIgn']), ang), 1, -1)
                m[(m == 1) & (inner == 0)] = 255
        info['pxPerMm'] = round(ppm, 2) if ppm else None
        info['pxPerMmNote'] = sp.get('pxPerMmNote') or ('tool diameter across the silhouette near the tip (%s view)' % view)
        info['thresholds'] = thrs
        met['pxPerMm'] = info['pxPerMm']
        s = ppm or 1.0; unit = 'mm' if ppm else 'px'
        chip = m == 3
        met['chipDepth' + ('Mm' if ppm else 'Px')] = round(float(depth[chip].max()) / s, 3) if chip.any() else 0.0
        dm = np.isin(m, (2, 3, 4)) | ((m == 255) & dmg)
        n, lbl = cv2.connectedComponents(dm.astype(np.uint8), connectivity=8)
        vbc = 0.0
        for i in range(1, n):
            r = lbl == i
            if depth[r].min() < 0.1 * s + 2: vbc = max(vbc, float(depth[r].max()) / s)
        met['vbc' + ('Mm' if ppm else 'Px')] = round(vbc, 3)
        vbmax, vbmean = land_width(m == 2, s)
        met['vbMax' + ('Mm' if ppm else 'Px')], met['vbMean' + ('Mm' if ppm else 'Px')] = vbmax, vbmean
        met['area' + ('Mm2' if ppm else 'Px')] = {str(c): round(float((m == c).sum()) / s / s, 4) for c in (2, 3, 4)}
        met['hasWear'] = bool((m == 2).any()); met['hasChip'] = bool(chip.any()); met['hasAdhesion'] = bool((m == 4).any())
        met['unit'] = unit; met['notes'] = sp.get('notes', '')
        info['gt'] = {k: v for k, v in met.items() if k not in ('id', 'image', 'tool', 'D', 'view', 'side', 'notes')}
        cv2.imwrite(os.path.join(P, 'images', sid + '.png'), im)
        cv2.imwrite(os.path.join(P, 'masks', sid + '.png'), m)
        json.dump(info, open(os.path.join(P, 'labelinfo', sid + '.json'), 'w'), indent=1, ensure_ascii=False)
        gt['images'].append(met)
        print(sid, 'ppm', info['pxPerMm'], {c: int((m == c).sum()) for c in (1, 2, 3, 4, 255)}, 'chip', met.get('chipDepthMm', met.get('chipDepthPx')),
              'vbc', met.get('vbcMm', met.get('vbcPx')), 'vb', vbmax)
        if prev: preview(im, m, info, os.path.join(prev, sid + '.jpg'))
    if not only:
        os.makedirs(os.path.join(root, 'reference'), exist_ok=True)
        json.dump(gt, open(os.path.join(root, 'reference', 'human_gt.json'), 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
    return gt


def preview(im, m, info, out):
    import sys; sys.path.insert(0, HERE)
    from overlay import over
    o = over(im, m)
    if info.get('tipLine'):
        a, b = info['tipLine']; cv2.line(o, (0, int(b)), (im.shape[1], int(a * im.shape[1] + b)), (0, 255, 255), 1)
    if info.get('circle'):
        cx, cy, R = info['circle']; cv2.circle(o, (int(cx), int(cy)), int(R), (0, 255, 255), 1)
    top = np.concatenate([im, o], 1)
    cv2.imwrite(out, top)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='C:/agent_research_team/datasets/toolwear')
    ap.add_argument('--spec', default=os.path.join(HERE, 'human_spec.json'))
    ap.add_argument('--only'); ap.add_argument('--prev')
    a = ap.parse_args()
    spec = json.load(open(a.spec, encoding='utf-8'))
    if a.prev: os.makedirs(a.prev, exist_ok=True)
    run(a.root, spec, a.only, a.prev)
