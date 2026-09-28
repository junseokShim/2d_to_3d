"""Eval-only 'target' split: the human's real phone crops (repo test/wear/samples/*.png).
Tool mask by GrabCut from a hand-set box (skin and the app's yellow overlay dots forced to background),
then hand-placed polygons for wear (2) / chipping (3) that I judged visible at the tip after zoomed inspection.
The yellow dashed marks are the app's overlay baked into these crops; they are labelled as whatever lies under them.
  python label_target.py <repo> <root>
"""
import json, os, sys
import cv2, numpy as np

# box = (x0, y0, x1, y1) around the tool in original pixels; wear/chip = polygons in original pixels
SPEC = {
    'side1': dict(box=(62, 94, 119, 249)),
    'side2': dict(box=(68, 88, 122, 249)),
    'side3': dict(box=(66, 85, 120, 249)),
    'side4': dict(box=(66, 81, 124, 249)),
    'top':   dict(box=(113, 78, 170, 132)),
}


def skin(img):
    ycc = cv2.cvtColor(img, cv2.COLOR_BGR2YCrCb)
    return (ycc[..., 1] > 135) & (ycc[..., 1] < 180) & (ycc[..., 2] > 85) & (ycc[..., 2] < 135) & (ycc[..., 0] > 80)


def yellow(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    return (hsv[..., 0] > 20) & (hsv[..., 0] < 40) & (hsv[..., 1] > 90) & (hsv[..., 2] > 90)


def tool_mask(img, box):
    h, w = img.shape[:2]
    gc = np.full((h, w), cv2.GC_BGD, np.uint8)
    x0, y0, x1, y1 = box
    gc[y0:y1, x0:x1] = cv2.GC_PR_FGD
    # the central third of the box is surely tool
    cx0, cx1 = x0 + (x1 - x0) // 3, x1 - (x1 - x0) // 3
    gc[y0 + (y1 - y0) // 6:y1 - 10, cx0:cx1] = cv2.GC_FGD
    gc[skin(img)] = cv2.GC_BGD
    bg, fg = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    cv2.grabCut(img, gc, None, bg, fg, 8, cv2.GC_INIT_WITH_MASK)
    m = ((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD)).astype(np.uint8)
    m[skin(img)] = 0
    # keep the largest component, fill holes, smooth
    n, lb, st, _ = cv2.connectedComponentsWithStats(m)
    if n > 1: m = (lb == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    cs, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    out = np.zeros_like(m); cv2.drawContours(out, cs, -1, 1, -1)
    return out


if __name__ == '__main__':
    repo, root = sys.argv[1], sys.argv[2]
    spec = SPEC
    extra = os.path.join(os.path.dirname(__file__), 'target_polys.json')
    polys = json.load(open(extra)) if os.path.exists(extra) else {}
    for d in ('images', 'masks'): os.makedirs(os.path.join(root, 'processed', d), exist_ok=True)
    for name, sp in spec.items():
        img = cv2.imread(os.path.join(repo, 'test/wear/samples', name + '.png'))
        m = tool_mask(img, sp['box'])
        for cls, key in ((2, 'wear'), (3, 'chip'), (4, 'adhesion')):
            for poly in polys.get(name, {}).get(key, []):
                pm = np.zeros_like(m); cv2.fillPoly(pm, [np.array(poly, np.int32)], 1)
                m[(pm > 0) & (m > 0)] = cls
        sid = 'target_' + name
        cv2.imwrite(os.path.join(root, 'processed/images', sid + '.png'), img)
        cv2.imwrite(os.path.join(root, 'processed/masks', sid + '.png'), m)
        print(sid, {c: int((m == c).sum()) for c in range(5)})
