"""Aqifi 2026 end-mill figures (CC BY 4.0, zenodo 21845441): New_tool.jpg and Worn_tool.jpg, 640x480 USB-microscope end views
of a 3.175 mm 2-flute carbide end mill. The author's VB_annotated.png is the worn image with drawn VB lines (0.02 mm) and is
not used as an input (baked-in annotation), only as the reference for where the wear land is.
Tool (1) = SAM2.1 mask from hand-placed points; background (0) = the smooth bright backdrop connected to the top border;
everything else (defocused shank/flutes) = 255 ignore. Wear (2) = the bright worn rim along the land's cutting edge inside a
hand-placed polygon (Worn only), threshold on brightness.
  python label_aqifi.py <root>
"""
import json, os, sys
import cv2, numpy as np

sys.path.insert(0, os.path.dirname(__file__))
from label_matwi import sam_predictor, IGN

# point prompts (x, y) in original pixels, read off a coordinate grid of each image
SPEC = {
    'New_tool': dict(pos=[(160, 330), (260, 320), (380, 330), (330, 230), (250, 250)], neg=[(80, 60), (560, 80), (320, 30)], wear=None),
    'Worn_tool': dict(pos=[(200, 320), (300, 300), (420, 320), (400, 220), (330, 200)], neg=[(80, 60), (560, 60), (320, 40)],
                      wear=[(158, 342), (470, 350), (470, 388), (158, 382)]),
}


def sam(img, pos, neg):
    import torch
    pr = sam_predictor()
    pts = np.array(pos + neg, np.float32); lab = np.array([1] * len(pos) + [0] * len(neg), np.int32)
    with torch.inference_mode(), torch.autocast('cuda', dtype=torch.bfloat16):
        pr.set_image(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        ms, sc, _ = pr.predict(point_coords=pts, point_labels=lab, multimask_output=False)
    return ms[0].astype(np.uint8), float(sc[0])


def backdrop(img):
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY).astype(np.float32)
    sd = np.sqrt(np.maximum(cv2.blur(g * g, (9, 9)) - cv2.blur(g, (9, 9)) ** 2, 0))
    c = ((hsv[..., 2] > 215) & (hsv[..., 1] < 40) & (sd < 6)).astype(np.uint8)
    n, lb, st, _ = cv2.connectedComponentsWithStats(c)
    top = set(np.unique(lb[0])) - {0}
    return np.isin(lb, list(top))


if __name__ == '__main__':
    root = sys.argv[1]
    src = os.path.join(root, 'raw/aqifi_endmill/Figures')
    for d in ('images', 'masks', 'labelinfo'): os.makedirs(os.path.join(root, 'processed', d), exist_ok=True)
    for name, sp in SPEC.items():
        img = cv2.imread(os.path.join(src, name + '.jpg'))
        tool, sc = sam(img, sp['pos'], sp['neg'])
        m = np.full(tool.shape, IGN, np.uint8)
        m[backdrop(img)] = 0
        m[tool > 0] = 1
        vbPx = 0
        if sp['wear']:
            pm = np.zeros_like(tool); cv2.fillPoly(pm, [np.array(sp['wear'], np.int32)], 1)
            v = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[..., 2]
            w = ((v > 200) & (pm > 0) & (tool > 0)).astype(np.uint8)
            w = cv2.morphologyEx(w, cv2.MORPH_CLOSE, np.ones((3, 5), np.uint8))
            m[w > 0] = 2
            cols = w.sum(0); vbPx = float(np.percentile(cols[cols > 0], 90)) if (cols > 0).any() else 0
        sid = 'aqifi_' + name.lower()
        cv2.imwrite(os.path.join(root, 'processed/images', sid + '.png'), img)
        cv2.imwrite(os.path.join(root, 'processed/masks', sid + '.png'), m)
        info = dict(source='aqifi_endmill', rawImage='raw/aqifi_endmill/Figures/%s.jpg' % name, samScore=sc, vbMm=0.02 if sp['wear'] else 0.0,
                    vbPxP90=vbPx, toolDiameterMm=3.175, flutes=2, view='end')
        json.dump(info, open(os.path.join(root, 'processed/labelinfo', sid + '.json'), 'w'))
        print(sid, {c: int((m == c).sum()) for c in (0, 1, 2, IGN)}, 'sam %.2f' % sc, 'vbPx %.1f' % vbPx)
