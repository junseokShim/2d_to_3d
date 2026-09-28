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


def adhesion(img, edge, m):
    # brown/yellow deposits (b* well above the flank) within 40 px above the edge -> class 4
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB).astype(np.float32)
    B = cv2.GaussianBlur(lab[..., 2], (5, 5), 0)
    h, w = B.shape
    ref = B[max(0, int(edge.min()) - 200):max(1, int(edge.min()) - 110)]
    mu, sd = np.median(ref), 1.4826 * np.median(np.abs(ref - np.median(ref))) + 1e-3
    yy = np.arange(h)[:, None]
    near = (yy <= edge[None, :] + 2) & (yy > edge[None, :] - 40)
    cand = ((B - mu) / sd > 4.0) & near
    cand = cv2.morphologyEx(cand.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 9), np.uint8))
    n, lb, stats, _ = cv2.connectedComponentsWithStats(cand)
    for i in range(1, n):
        if stats[i, cv2.CC_STAT_AREA] >= 150: m[(lb == i) & (m > 0)] = 4
    return m


def label(path):
    img = cv2.imread(path)
    h, w = img.shape[:2]
    line, edge, p = edge_rows(img)
    hts = wear_band(img, edge)
    m = np.zeros((h, w), np.uint8)
    yy = np.arange(h)[:, None]
    m[yy <= edge[None, :]] = 1
    band = (yy <= edge[None, :]) & (yy > edge[None, :] - hts[None, :])
    m[band] = 2
    m = adhesion(img, edge, m)
    return img, m, dict(adhesionPx=int((m == 4).sum()), edgeSlope=float(p[0]), edgeRowMean=float(edge.mean()), wearFrac=float((hts > 0).mean()),
                        vbPxMax=float(hts.max()), vbPxMean=float(hts[hts > 0].mean()) if (hts > 0).any() else 0.0)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('root'); ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--only', default='')
    a = ap.parse_args()
    src = sorted(glob.glob(os.path.join(a.root, 'raw/mudestreda/dataset_original/tool/*.jpg')))
    if a.only: src = [s for s in src if os.path.basename(s).split('.')[0] in a.only.split(',')]
    if a.limit: src = src[:a.limit]
    out_i, out_m, out_j = (os.path.join(a.root, 'processed', d) for d in ('images', 'masks', 'labelinfo'))
    for d in (out_i, out_m, out_j): os.makedirs(d, exist_ok=True)
    for s in src:
        sid = 'mud_' + os.path.basename(s).split('.')[0]
        img, m, info = label(s)
        cv2.imwrite(os.path.join(out_i, sid + '.png'), img); cv2.imwrite(os.path.join(out_m, sid + '.png'), m)
        json.dump(info, open(os.path.join(out_j, sid + '.json'), 'w'))
    print('labelled', len(src))
