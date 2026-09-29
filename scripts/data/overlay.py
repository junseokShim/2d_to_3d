"""QA overlays: python overlay.py <root> <out.jpg> <id1,id2,...|glob> [--w 520] [--cols 2]
Tints mask classes over the image (1 tool blue, 2 wear green, 3 chip red, 4 adhesion yellow) with the class outline;
255 = ignore is darkened with a magenta tint."""
import argparse, glob, os
import cv2, numpy as np

PAL = np.array([[0, 0, 0], [200, 80, 40], [0, 255, 0], [0, 0, 255], [0, 220, 255]], np.uint8)  # BGR


def over(img, m, alpha=0.35):
    ign = m == 255
    m = np.where(ign, 0, m)
    col = PAL[np.clip(m, 0, 4)]
    o = img.copy(); sel = m > 1
    o[ign] = (img[ign] * 0.55 + np.array([160, 0, 160]) * 0.2).clip(0, 255).astype(np.uint8)
    o[sel] = (img[sel] * (1 - alpha * 1.5) + col[sel] * alpha * 1.5).clip(0, 255).astype(np.uint8)
    o[m == 1] = (img[m == 1] * (1 - alpha * .4) + col[m == 1] * alpha * .4).astype(np.uint8)
    for c in range(1, 5):
        cs, _ = cv2.findContours((m == c).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(o, cs, -1, PAL[c].tolist(), 1)
    return o


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('root'); ap.add_argument('out'); ap.add_argument('ids')
    ap.add_argument('--w', type=int, default=520); ap.add_argument('--cols', type=int, default=2); ap.add_argument('--side', action='store_true')
    a = ap.parse_args()
    ids = a.ids.split(',') if ',' in a.ids or not any(c in a.ids for c in '*?') else \
        [os.path.basename(p)[:-4] for p in sorted(glob.glob(os.path.join(a.root, 'processed/masks', a.ids + '.png')))]
    tiles = []
    for i in ids:
        img = cv2.imread(os.path.join(a.root, 'processed/images', i + '.png'))
        m = cv2.imread(os.path.join(a.root, 'processed/masks', i + '.png'), cv2.IMREAD_GRAYSCALE)
        o = over(img, m)
        if a.side: o = np.concatenate([img, o], 1)
        s = a.w / o.shape[1]; o = cv2.resize(o, (a.w, int(o.shape[0] * s)), interpolation=cv2.INTER_AREA)
        cv2.putText(o, i, (4, 14), cv2.FONT_HERSHEY_SIMPLEX, .45, (0, 0, 255), 1)
        tiles.append(o)
    H = max(t.shape[0] for t in tiles)
    tiles = [cv2.copyMakeBorder(t, 0, H - t.shape[0], 0, 2, cv2.BORDER_CONSTANT) for t in tiles]
    while len(tiles) % a.cols: tiles.append(np.zeros_like(tiles[0]))
    rows = [np.concatenate(tiles[r:r + a.cols], 1) for r in range(0, len(tiles), a.cols)]
    cv2.imwrite(a.out, np.concatenate(rows, 0), [cv2.IMWRITE_JPEG_QUALITY, 85])
    print('wrote', a.out, len(ids))
