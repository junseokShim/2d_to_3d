"""Tool-only masks for QIT-CEMC (coated 4-flute end mill, 4.5X toolmaker microscope, green backdrop, side + end view of
each cutting edge, 68 wear cycles; expert VBmax / VB(1/2ap) / wear area S per edge in 'tool wear.xls').

The wear land is not reliably visible at this resolution (focus, framing and zoom change between cycles, no px/mm), so
no class 2/3 is written. Per image:
  green backdrop (chroma key)                           -> 0 background
  tool (not green, not in the dark shadow)              -> 1, except
  tool within BAND px of any non-tool pixel             -> 255 (wear land / chipping / edge uncertainty lives there)
  dark shadow, defocused (blurred) tool and a RING around green -> 255
QMS3D software screenshots (non 640x480 frames) are skipped. Frames whose tool interior is < MIN_TOOL of the image are
dropped. Writes processed/{images,masks,labelinfo}/qit_C<cycle>_<view><edge>.png.
  python label_qit.py <root> [--limit N] [--out DIR]
"""
import argparse, glob, json, os
import cv2, numpy as np

IGN = 255
BAND = 90       # px (~0.2 of frame height): wide enough to cover VBmax up to 0.7 mm at 4.5X
RING = 4
MIN_TOOL = 0.03
DROP = {'qit_C22_side4'}  # manual QA: zoomed-in, defocused facet labelled as tool


def wear_table(xls):
    import xlrd
    s = xlrd.open_workbook(xls).sheet_by_index(0)
    out = {}
    for i in range(4, s.nrows):
        r = s.row_values(i)
        if r[0] == '': continue
        c = int(r[0])
        for e in range(4):
            out[(c, 'side', e + 1)] = dict(vbMaxMm=r[1 + 3 * e], vbHalfApMm=r[2 + 3 * e], areaMm2=r[3 + 3 * e])
            out[(c, 'end', e + 1)] = dict(vbMaxMm=r[13 + 2 * e], areaMm2=r[14 + 2 * e])
    return out


def label(img):
    b = cv2.GaussianBlur(img, (0, 0), 3).astype(int)            # average out the ground-in texture streaks
    B, G, R = b[..., 0], b[..., 1], b[..., 2]
    green = (G - np.maximum(R, B) > 55) & (G > 110)
    green = cv2.morphologyEx(green.astype(np.uint8), cv2.MORPH_OPEN, np.ones((5, 5), np.uint8))
    dark = (b.max(2) < 55) & (green == 0)
    tool = ((green == 0) & ~dark & (G - np.maximum(R, B) < 35)).astype(np.uint8)   # greenish gradient -> neither
    tool = cv2.morphologyEx(tool, cv2.MORPH_OPEN, np.ones((7, 7), np.uint8))
    n, lb, st, _ = cv2.connectedComponentsWithStats(tool)
    if n > 1: tool = (lb == 1 + np.argmax(st[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    tool = cv2.morphologyEx(tool, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    m = np.full(img.shape[:2], IGN, np.uint8)
    m[green > 0] = 0
    ring = cv2.dilate(tool, np.ones((2 * RING + 1,) * 2, np.uint8))
    m[(ring > 0) & (m == 0)] = IGN
    # distance from every tool pixel to the nearest non-tool pixel; image borders are not edges
    pad = cv2.copyMakeBorder(tool, 1, 1, 1, 1, cv2.BORDER_REPLICATE)
    dist = cv2.distanceTransform(pad, cv2.DIST_L2, 5)[1:-1, 1:-1]
    # in focus only: local high-pass energy at least half the tool's median (defocused flute / body -> ignore)
    gr = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    hp = np.abs(gr - cv2.GaussianBlur(gr, (0, 0), 2))
    en = cv2.blur(hp, (41, 41))
    sharp = en > 0.5 * np.median(en[tool > 0]) if tool.any() else np.zeros_like(tool, bool)
    m[(tool > 0) & (dist > BAND) & sharp] = 1
    return m, dict(greenFrac=float((m == 0).mean()), toolFrac=float((m == 1).mean()), toolRawFrac=float(tool.mean()),
                   ignoreFrac=float((m == IGN).mean()))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('root'); ap.add_argument('--limit', type=int, default=0); ap.add_argument('--out', default=''); ap.add_argument('--min', type=float, default=MIN_TOOL)
    a = ap.parse_args()
    x = os.path.join(a.root, 'raw/qit_cemc/x')
    wt = wear_table(os.path.join(x, 'tool wear.xls'))
    out = a.out or os.path.join(a.root, 'processed')
    for d in ('images', 'masks', 'labelinfo'): os.makedirs(os.path.join(out, d), exist_ok=True)
    fs = sorted(f.replace('\\', '/') for f in glob.glob(os.path.join(x, 'Image/[0-9]*/*-[1-4].png')))
    if a.limit: fs = fs[:a.limit]
    cnt = dict(kept=0, screenshot=0, small=0)
    for f in fs:
        cyc = int(f.split('/')[-2]); view, edge = os.path.basename(f)[:-4].split('-'); edge = int(edge)
        img = cv2.imread(f)
        if img.shape[:2] != (480, 640): cnt['screenshot'] += 1; continue
        sid = 'qit_C%02d_%s%d' % (cyc, view, edge)
        if sid in DROP: cnt['qaDrop'] = cnt.get('qaDrop', 0) + 1; continue
        m, info = label(img)
        if info['toolFrac'] < a.min: cnt['small'] += 1; continue
        info.update(source='qit_cemc', cycle=cyc, view=view, edge=edge, labelQuality='tool-only', rawImage=os.path.relpath(f, a.root).replace('\\', '/'),
                    **{k: (v if v != '' else None) for k, v in wt.get((cyc, view, edge), {}).items()})
        cv2.imwrite(os.path.join(out, 'images', sid + '.png'), img); cv2.imwrite(os.path.join(out, 'masks', sid + '.png'), m)
        json.dump(info, open(os.path.join(out, 'labelinfo', sid + '.json'), 'w'))
        cnt['kept'] += 1
    print(cnt)
