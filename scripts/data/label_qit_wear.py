"""Wear labels for a QIT-CEMC side-view subset, guided by the expert VBmax (tool wear.xls) -> processed/*/qit_w_C<cycle>_side<edge>.

QIT has no px/mm. Scale: the worn land (rough band without grinding marks along the lower cutting edge) was measured by
hand on zoomed side views (C46_side2 VB .349 mm -> 25-35 px, C25_side2 VB .203 mm -> 15-25 px) -> PPM ~ 95 px/mm (+-20 %).
Per image (tool silhouette from label_qit.label):
  cutting edge  = tool boundary pixels whose outward normal points down (the edge the land lies on in these views)
  w             = VBmax * PPM px
  tool within 0.8 w of the edge            -> 2 (flank wear land)
  tool within 0.8 w .. 1.25 w of the edge  -> 255 (scale uncertainty)
  other in-focus tool                       -> 1; defocused tool, dark shadow, RING around the silhouette -> 255; green -> 0
Only frames with a long, sharp cutting edge are kept (>= MIN_EDGE px), N images spread over the cycles.
  python label_qit_wear.py [--root C:/agent_research_team/datasets/toolwear] [--n 72] [--prev DIR]
"""
import argparse, glob, json, os, sys
import cv2, numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from label_qit import label, wear_table, IGN, RING

PPM = 95.0
MIN_EDGE = 150


def cutting_edge(tool):
    t = cv2.GaussianBlur(tool.astype(np.float32), (0, 0), 3)
    gy = cv2.Sobel(t, cv2.CV_32F, 0, 1, ksize=5); gx = cv2.Sobel(t, cv2.CV_32F, 1, 0, ksize=5)
    bd = (tool > 0) & (cv2.erode(tool, np.ones((3, 3), np.uint8)) == 0)
    bd[:3] = bd[-3:] = False; bd[:, :3] = bd[:, -3:] = False            # image borders are not edges
    down = -gy > 0.6 * np.hypot(gx, gy) + 1e-3                         # tool above, background below
    return bd & down


def wear_mask(img, vb):
    m, info = label(img)
    tool = np.zeros(img.shape[:2], np.uint8)
    b = cv2.GaussianBlur(img, (0, 0), 3).astype(int)
    tool[(m == 1)] = 1
    # recover the raw silhouette (label() hides the BAND next to edges as 255): tool = not green, not dark
    B, G, R = b[..., 0], b[..., 1], b[..., 2]
    raw = ((G - np.maximum(R, B) < 35) & (b.max(2) >= 55) & (m != 0)).astype(np.uint8)
    raw = cv2.morphologyEx(raw, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    n, lb, st, _ = cv2.connectedComponentsWithStats(raw)
    if n > 1: raw = (lb == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    raw = cv2.morphologyEx(raw, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    gr = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    en = cv2.blur(np.abs(gr - cv2.GaussianBlur(gr, (0, 0), 2)), (21, 21))
    sharp = en > 0.5 * np.median(en[raw > 0])
    # the real edge has the textured (in-focus) tool face above it and smooth shadow / backdrop below it;
    # the blurred shadow-to-green gradient also passes the colour test but is smooth on both sides
    K = 14
    above = np.zeros_like(sharp); above[K:] = sharp[:-K]
    below = np.zeros_like(sharp); below[:-K] = sharp[K:]
    edge0 = cutting_edge(raw)
    edge = edge0 & above & ~below
    edge = cv2.morphologyEx(edge.astype(np.uint8), cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8)) > 0
    n, lb, st, _ = cv2.connectedComponentsWithStats(edge.astype(np.uint8), 8)
    big = max([st[i, cv2.CC_STAT_AREA] for i in range(1, n)] or [0])
    edge = np.isin(lb, [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] >= max(40, 0.3 * big)])   # short blobs = shadow noise
    if edge.sum() < MIN_EDGE: return None, dict(edgePx=int(edge.sum()))
    d = cv2.distanceTransform((~edge).astype(np.uint8), cv2.DIST_L2, 5)
    w = vb * PPM
    raw = raw & (cv2.dilate(sharp.astype(np.uint8), np.ones((15, 15), np.uint8)) > 0).astype(np.uint8)
    out = np.full(img.shape[:2], IGN, np.uint8)
    out[m == 0] = 0
    out[(raw > 0) & sharp] = 1
    d0 = cv2.distanceTransform((~edge0).astype(np.uint8), cv2.DIST_L2, 5)
    out[(raw > 0) & ((d <= 1.25 * w) | (d0 <= 1.25 * w))] = IGN   # unverified stretches of the lower edge stay unknown
    out[(raw > 0) & (d <= 0.8 * w)] = 2
    ring = cv2.dilate(raw, np.ones((2 * RING + 1,) * 2, np.uint8)) & ~cv2.erode(raw, np.ones((2 * RING + 1,) * 2, np.uint8))
    out[(ring > 0) & (out != 2)] = IGN
    # a wear pixel must sit on an in-focus stretch of the edge
    edge_sharp = (edge & sharp).sum() / max(1, edge.sum())
    return out, dict(edgePx=int(edge.sum()), edgeSharpFrac=round(float(edge_sharp), 3), landPx=round(w, 1))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='C:/agent_research_team/datasets/toolwear'); ap.add_argument('--n', type=int, default=72)
    ap.add_argument('--prev'); a = ap.parse_args()
    x = os.path.join(a.root, 'raw/qit_cemc/x'); P = os.path.join(a.root, 'processed')
    wt = wear_table(os.path.join(x, 'tool wear.xls'))
    cands = []
    for f in sorted(glob.glob(os.path.join(P, 'labelinfo', 'qit_C*_side*.json'))):
        li = json.load(open(f)); vb = li.get('vbMaxMm')
        if not vb: continue
        sid = os.path.basename(f)[:-5]
        img = cv2.imread(os.path.join(P, 'images', sid + '.png'))
        m, st = wear_mask(img, vb)
        if m is None or st['edgeSharpFrac'] < 0.6 or (m == 2).sum() < 200: continue
        cands.append((li['cycle'], li['edge'], sid, li, m, st, img))
    # spread over cycles: at most 2 per cycle first, then fill
    cands.sort(key=lambda c: (c[0], c[1])); pick, seen = [], {}
    for c in cands:
        if seen.get(c[0], 0) < 2 and len(pick) < a.n: pick.append(c); seen[c[0]] = seen.get(c[0], 0) + 1
    for c in cands:
        if len(pick) >= a.n: break
        if c[2] not in {q[2] for q in pick}: pick.append(c)
    for old in glob.glob(os.path.join(P, '*', 'qit_w_*')): os.remove(old)
    for cyc, e, sid, li, m, st, img in pick:
        nid = sid.replace('qit_', 'qit_w_')
        info = dict(li); info.update(st, labelQuality='VBmax-guided band (expert VBmax, px/mm estimated %.0f +-20 %%)' % PPM, pxPerMm=PPM,
                                     pxPerMmNote='QIT has no scale; land width measured by hand on zoomed side views vs expert VBmax', toolOnlyId=sid)
        cv2.imwrite(os.path.join(P, 'images', nid + '.png'), img); cv2.imwrite(os.path.join(P, 'masks', nid + '.png'), m)
        json.dump(info, open(os.path.join(P, 'labelinfo', nid + '.json'), 'w'))
        if a.prev:
            from overlay import over
            cv2.imwrite(os.path.join(a.prev, nid + '.jpg'), over(img, m))
    print('candidates', len(cands), 'written', len(pick), 'cycles', len(seen))


if __name__ == '__main__':
    main()
