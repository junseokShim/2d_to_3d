"""Semi-automatic masks for Mudestreda tool images (1550x500 microscope, flank face on top, blurred background below).

Per column: cutting edge row = texture step (tool is textured, background is smooth), fitted by a robust line + local
refinement. Wear land (class 2) = contiguous band directly above the edge whose pixels deviate from the intact flank
statistics (bright worn land and the dark wear-boundary groove). Classes: 0 background, 1 tool, 2 flank wear.
Writes processed/{images,masks}/mud_<id>.png and a per-image json with the band stats; QA overlays separately.
  python label_mudestreda.py <root> [--limit N]
"""
import argparse, glob, json, os
import cv2, numpy as np


def local_std(g, k=9):
    g = g.astype(np.float32)
    m = cv2.blur(g, (k, k)); m2 = cv2.blur(g * g, (k, k))
    return np.sqrt(np.maximum(m2 - m * m, 0))


def edge_rows(img):
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    s = local_std(g, 9)
    h, w = g.shape
    # background below the edge: low texture. Column score: rows where texture above/below differs most
    cs = np.cumsum(s, axis=0)
    rows = np.arange(20, h - 20)
    e = np.zeros(w, np.float32)
    for x0 in range(0, w, 8):
        col = s[:, x0:x0 + 8].mean(1)
        c = np.cumsum(col)
        above = (c[rows] - c[rows - 20]) / 20
        below = (c[rows + 20] - c[rows]) / 20
        score = above - below
        e[x0:x0 + 8] = rows[np.argmax(score)]
    # robust line fit (edge is straight in these images)
    xs = np.arange(w)
    good = np.ones(w, bool)
    for _ in range(5):
        p = np.polyfit(xs[good], e[good], 1)
        r = e - np.polyval(p, xs)
        good = np.abs(r) < max(4, 2.5 * np.median(np.abs(r[good])) + 1)
    line = np.polyval(p, xs)
    # local refinement: strongest vertical intensity gradient within +-6 px of the line (edge is a bright rim)
    gy = cv2.Sobel(cv2.GaussianBlur(g, (5, 5), 0).astype(np.float32), cv2.CV_32F, 0, 1, ksize=5)
    ref = np.zeros(w, np.float32)
    for x in range(w):
        y0 = int(round(line[x])); a, b = max(0, y0 - 6), min(h, y0 + 7)
        ref[x] = a + np.argmax(np.abs(gy[a:b, x]))
    ref = cv2.medianBlur(ref.reshape(1, -1).astype(np.float32), 5).ravel() if w > 5 else ref
    return line, ref, p


def wear_band(img, edge, maxh=90):
    """Return per-column wear-land height (px above the edge)."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = cv2.GaussianBlur(lab[..., 0], (3, 3), 0)
    h, w = L.shape
    # intact flank statistics: band 110..200 px above the edge
    ys = []
    for x in range(0, w, 4):
        e = int(edge[x]); a, b = max(0, e - 200), max(0, e - 110)
        if b > a: ys.append(L[a:b, x])
    ref = np.concatenate(ys) if ys else L.ravel()
    mu, sd = np.median(ref), 1.4826 * np.median(np.abs(ref - np.median(ref))) + 1e-3
    z = (L - mu) / sd
    # (a) dark wear-boundary groove: darkest row 4..70 px above the edge (x-smoothed); wear land = edge..groove
    Lx = cv2.blur(L, (21, 1))
    zx = (Lx - mu) / sd
    # (b) otherwise a bright land smoother than the striated intact flank, contiguous from the edge
    st = local_std(lab[..., 0], 7)
    st_ref = np.median(st[max(0, int(edge.min()) - 200):max(1, int(edge.min()) - 110)])
    bright = cv2.blur(((z > 2.0) & (st < 0.8 * st_ref)).astype(np.float32), (41, 3))
    heights = np.zeros(w, np.float32)
    for x in range(w):
        e = int(round(edge[x]))
        a, b = max(0, e - maxh), max(0, e - 4)
        if b <= a: continue
        col = zx[a:b, x]
        k = int(np.argmin(col))
        if col[k] < -2.5:
            heights[x] = (e - (a + k)) + 3
            continue
        hgt = 0; miss = 0
        for d in range(1, maxh):
            y = e - d
            if y < 0: break
            if bright[y, x] > 0.4: hgt = d; miss = 0
            else:
                miss += 1
                if miss > 4: break
        heights[x] = hgt
    # spiky per-column heights -> upper envelope: closing (max then min) along x, then light smoothing
    hk = np.ones((1, 41), np.uint8)
    h1 = cv2.erode(cv2.dilate(heights.reshape(1, -1), hk), hk).ravel()
    h1 = np.minimum(h1, cv2.dilate(heights.reshape(1, -1), np.ones((1, 81), np.uint8)).ravel())
    heights = np.convolve(h1, np.ones(15) / 15, mode='same')
    heights[heights < 5] = 0     # the sharp edge rim itself (few px) is not wear
    heights[:40] = 0; heights[-40:] = 0  # vignetted borders give false bright evidence
    # drop runs shorter than 60 px (isolated specks)
    on = heights > 0; x = 0
    while x < w:
        if on[x]:
            x2 = x
            while x2 < w and on[x2]: x2 += 1
            if x2 - x < 60: heights[x:x2] = 0
            x = x2
        else: x += 1
    return heights


def wear_band_dp(img, edge, maxh=100, ref=(110, 200), step=4, lam=0.6, conf_thr=-1.6, gap_fill=320, aclip=4.0, local_ref=True):
    """v2: trace the wear-land upper boundary (dark groove / bright-land -> striated-flank step) as one smooth path by
    dynamic programming over columns, so the band does not stop where the groove fades.
    Returns (heights, uncertain): per-column band height in px, and a bool per column where wear is likely but the
    boundary is not confidently seen (-> label 255 = ignore instead of calling it intact tool)."""
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    L = cv2.GaussianBlur(lab[..., 0], (3, 3), 0)
    h, w = L.shape
    ys = []; mus = np.full(w, np.nan, np.float32)
    for x in range(0, w, 4):
        e = int(edge[x]); a, b = max(0, e - ref[1]), max(0, e - ref[0])
        if b > a: ys.append(L[a:b, x]); mus[x] = np.median(L[a:b, x])
    refv = np.concatenate(ys) if ys else L.ravel()
    mu, sd = np.median(refv), 1.4826 * np.median(np.abs(refv - np.median(refv))) + 1e-3
    if local_ref:
        # illumination drifts along the edge: per-column flank level (running median over ~200 px) instead of one value
        xs_ = np.flatnonzero(~np.isnan(mus))
        mcol = np.interp(np.arange(w), xs_, mus[xs_])
        k = 101; pad = np.pad(mcol, k // 2, mode='edge')
        mu = np.array([np.median(pad[i:i + k]) for i in range(0, w)], np.float32)[None, :]
    Lx = cv2.blur(L, (25, 1))
    zx = (Lx - mu) / sd
    # anomaly = |deviation| from the intact striated flank (dark groove or bright/brown land); the edge rim and the
    # background (rows below edge-3) are zeroed so the rim cannot pose as a land. Boundary = anomalous below, normal above.
    A = np.clip(np.abs(zx), 0, aclip)
    A[np.arange(h)[:, None] > (edge[None, :] - 3)] = 0
    k = np.ones((8, 1), np.float32) / 8
    Abelow = cv2.filter2D(A, -1, k, anchor=(0, 0), borderType=cv2.BORDER_CONSTANT)   # mean over rows y..y+7
    Aabove = cv2.filter2D(A, -1, k, anchor=(0, 7), borderType=cv2.BORDER_CONSTANT)   # mean over rows y-7..y
    xs = np.arange(0, w, step)
    ds = np.arange(6, maxh)
    C = np.full((len(xs), len(ds)), 5.0, np.float32)
    for i, x in enumerate(xs):
        e = int(round(edge[x])); yy = e - ds
        ok = (yy >= 4) & (yy < h - 4)
        C[i, ok] = -(Abelow[yy[ok] + 1, x] - Aabove[yy[ok] - 1, x])
    # DP with |dd| <= 3 states per step, linear penalty
    n, m = C.shape
    acc = C[0].copy(); bp = np.zeros((n, m), np.int16)
    for i in range(1, n):
        best = np.full(m, np.inf, np.float32); arg = np.zeros(m, np.int16)
        for dd in range(-3, 4):
            sh = np.full(m, np.inf, np.float32)
            if dd >= 0: sh[dd:] = acc[:m - dd]
            else: sh[:dd] = acc[-dd:]
            sh = sh + lam * abs(dd)
            better = sh < best; best[better] = sh[better]; arg[better] = (np.arange(m) - dd)[better]
        acc = best + C[i]; bp[i] = arg
    path = np.zeros(n, np.int32); path[-1] = int(np.argmin(acc))
    for i in range(n - 1, 0, -1): path[i - 1] = bp[i, path[i]]
    cost = C[np.arange(n), path]
    conf = np.convolve(cost, np.ones(15) / 15, mode='same')      # ~60 px window
    good = conf < conf_thr
    hd = ds[path].astype(np.float32)
    # runs of confident columns; fill short low-confidence gaps between confident runs
    on = good.copy(); gmax = gap_fill // step
    idx = np.flatnonzero(on)
    if len(idx):
        for a_, b_ in zip(idx[:-1], idx[1:]):
            if 1 < b_ - a_ <= gmax: on[a_:b_] = True
    # drop short isolated runs (< 60 px)
    i = 0
    while i < n:
        if on[i]:
            j = i
            while j < n and on[j]: j += 1
            if (j - i) * step < 60: on[i:j] = False
            i = j
        else: i += 1
    unc = np.zeros(n, bool)
    idx = np.flatnonzero(on)
    if len(idx):
        lo, hi = idx[0], idx[-1]
        # long gaps inside the worn span and the tail to the right border: wear likely, boundary unseen -> ignore
        inside = np.zeros(n, bool); inside[lo:hi + 1] = True
        unc = inside & ~on
        tail = np.arange(n) > hi
        # wear runs along the engaged edge to the image border; its boundary there is unseen -> whole tail ignored,
        # at least as high as the typical confident land so no worn pixel is left labelled as intact tool
        if tail.any() and (n - hi) * step > 40: unc |= tail
        hd = np.where(unc, np.maximum(hd, np.median(hd[on]) + 4), hd)
    hts = np.where(on | unc, hd, 0)
    heights = np.interp(np.arange(w), xs, hts).astype(np.float32)
    uncertain = np.interp(np.arange(w), xs, unc.astype(np.float32)) > 0.5
    known = np.interp(np.arange(w), xs, on.astype(np.float32)) > 0.5
    heights[~(known | uncertain)] = 0
    heights[:40] = 0; heights[-8:] = 0; uncertain[:40] = False
    return heights, uncertain


def adhesion(img, edge, m, max_lz=1.5):
    # brown/yellow deposits (b* well above the flank) within 40 px above the edge -> class 4
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    B = cv2.GaussianBlur(lab[..., 2], (5, 5), 0)
    h, w = B.shape
    ref = B[max(0, int(edge.min()) - 200):max(1, int(edge.min()) - 110)]
    mu, sd = np.median(ref), 1.4826 * np.median(np.abs(ref - np.median(ref))) + 1e-3
    yy = np.arange(h)[:, None]
    near = (yy <= edge[None, :] + 2) & (yy > edge[None, :] - 40)
    # brown deposits are yellow but not bright; the bright beige worn land itself also has high b* -> exclude by L*
    Lc = cv2.GaussianBlur(lab[..., 0], (5, 5), 0)
    lref = Lc[max(0, int(edge.min()) - 200):max(1, int(edge.min()) - 110)]
    lmu, lsd = np.median(lref), 1.4826 * np.median(np.abs(lref - np.median(lref))) + 1e-3
    cand = ((B - mu) / sd > 4.0) & ((Lc - lmu) / lsd < max_lz) & near
    cand = cv2.morphologyEx(cand.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 9), np.uint8))
    n, lb, stats, _ = cv2.connectedComponentsWithStats(cand)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= 150: m[(lb == i) & (m > 0)] = 4
    return m


# Manual QA 2026-09-29 (worker-data3, zoomed edge strips of every image):
# DROP = the traced band misses visible wear or covers a glint/chip -> not used; BREAKAGE = the band is a fractured edge
# (large chip), so it is class 3, not flank wear.
DROP = {'T3R13B1', 'T4R14B4', 'T5R11B2', 'T5R12B4', 'T7R6B2', 'T9R6B3', 'T9R13B3', 'T9R13B4'}
BREAKAGE = {'T8R13B1', 'T8R13B2', 'T8R13B3', 'T8R13B4'}


def state_labels(root):
    """Mudestreda image-level machine state per id (sharp/used/dulled) from the official csv files."""
    st = {}
    for f in glob.glob(os.path.join(root, 'raw/mudestreda/labels_original/tool_distribution/*.csv')):
        for ln in open(f).read().splitlines()[1:]:
            p = ln.split(',')
            if len(p) >= 2: st[p[0]] = p[1]
    return st


def label(path, state=''):
    img = cv2.imread(path)
    h, w = img.shape[:2]
    line, edge, p = edge_rows(img)
    hts, unc = wear_band_dp(img, edge)
    m = np.zeros((h, w), np.uint8)
    yy = np.arange(h)[:, None]
    m[yy <= edge[None, :]] = 1
    band = (yy <= edge[None, :]) & (yy > edge[None, :] - hts[None, :])
    m[band & ~unc[None, :]] = 2
    m = adhesion(img, edge, m)
    # adhesion only on the engaged (worn) span of the edge: blobs on the corner/chamfer left of it are glare or dirt
    eng = np.flatnonzero((hts > 0) | unc)
    keep = np.zeros(w, bool)
    if len(eng): keep[max(0, eng[0] - 20):] = True
    m[(m == 4) & ~keep[None, :]] = 1
    m[band & unc[None, :] & (m != 4)] = 255
    # band height collapsing next to a much taller land (faint continuation of heavy wear): the zone between the thin
    # band and the local land height is ambiguous -> ignore rather than 'intact tool'
    hk = np.where(unc, 0, hts).astype(np.float32)
    env = cv2.dilate(hk.reshape(1, -1), np.ones((1, 601), np.uint8)).ravel()
    kn = np.flatnonzero(hk > 0)
    drop = (env > 0) & (hts < 0.6 * env) & (np.arange(w) >= (kn[0] if len(kn) else w))
    amb = (yy <= edge[None, :]) & (yy > edge[None, :] - env[None, :]) & drop[None, :] & (m == 1)
    m[amb] = 255
    if state in ('used', 'dulled') and ((hts > 0) & ~unc).mean() < 0.15:
        # worn tool but no land traced (chipped / diffuse edge): do not teach 'intact tool' there -> ignore the edge zone
        zone = (yy <= edge[None, :]) & (yy > edge[None, :] - 45) & (m == 1)
        zone[:, :40] = False
        m[zone] = 255
    return img, m, dict(adhesionPx=int((m == 4).sum()), edgeSlope=float(p[0]), edgeRowMean=float(edge.mean()), wearFrac=float(((hts > 0) & ~unc).mean()), ignorePx=int((m == 255).sum()), wearPx=int((m == 2).sum()),
                        vbPxMax=float(hts.max()), vbPxMean=float(hts[hts > 0].mean()) if (hts > 0).any() else 0.0)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('root'); ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--only', default=''); ap.add_argument('--out', default=''); ap.add_argument('--skip', default='T1,T2')
    a = ap.parse_args()
    src = sorted(glob.glob(os.path.join(a.root, 'raw/mudestreda/dataset_original/tool/*.jpg')))
    # T1 (edge often missed / rotated view) and T2 (dark, land not visible): unreliable in QA 2026-09-29 -> not labelled
    src = [s for s in src if not any(os.path.basename(s).startswith(t + 'R') for t in a.skip.split(',') if t)]
    state = state_labels(a.root)
    if a.only: src = [s for s in src if os.path.basename(s).split('.')[0] in a.only.split(',')]
    if a.limit: src = src[:a.limit]
    pdir = a.out or os.path.join(a.root, 'processed')
    out_i, out_m, out_j = (os.path.join(pdir, d) for d in ('images', 'masks', 'labelinfo'))
    for d in (out_i, out_m, out_j): os.makedirs(d, exist_ok=True)
    src = [s for s in src if os.path.basename(s).split('.')[0] not in DROP]
    for s in src:
        sid = 'mud_' + os.path.basename(s).split('.')[0]
        img, m, info = label(s, state.get(os.path.basename(s).split('.')[0], ''))
        if sid[4:] in BREAKAGE: m[m == 2] = 3
        info['state'] = state.get(os.path.basename(s).split('.')[0], '')
        cv2.imwrite(os.path.join(out_i, sid + '.png'), img); cv2.imwrite(os.path.join(out_m, sid + '.png'), m)
        json.dump(info, open(os.path.join(out_j, sid + '.json'), 'w'))
    print('labelled', len(src))
