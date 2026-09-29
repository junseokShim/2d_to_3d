"""ExtraDrey (TUHH, doi 10.15480/882.17237, Public Domain Mark 1.0) -> toolwear format.
Raw pairs come from fetch_extradrey.py: raw/extradrey/CT0XX_Y/Images/{Image/*.jpg, Mask/*_mask.png}.
Source masks: 0 bg, 85 flank wear, 170 tool, 255 adhesion  ->  0 bg, 1 tool, 2 flank wear, 4 adhesion.
Views: FF flank 150x, FFL flank 100x (fully labelled); RF rake face: the dataset marks only the tool area
(crater/edge wear not labelled), so RF after 0 s is tool-only: tool within RF_BAND_MM of the tool outline -> 255.
Scale: measured from the blue 100 um scale bar (150x ~1010 px/mm, 100x ~680 px/mm at 2048 px); the bar + label -> 255.
Images downscaled to <= MAXW px wide. VB_Max (um) from Experiment_Documentation.xlsx by (edge, cutting time end).
  python label_extradrey.py <root>      (root = datasets/toolwear)
  python label_extradrey.py <root> --vb   (any python with openpyxl: only writes raw/extradrey/_meta/vb_max.json)
"""
import glob, json, os, re, sys
import cv2, numpy as np

MAXW = 1600
RF_BAND_MM = 0.5
MAP = {0: 0, 85: 2, 170: 1, 255: 4}
PXMM_DEFAULT = {'': 1010.0, 'L': 680.0}


def imread(p, flag):
    return cv2.imdecode(np.fromfile(p, np.uint8), flag)


def scale_bar(im):
    """Return (px per mm, bar box) from the blue 100 um bar in the bottom-right corner, or (None, None)."""
    h, w = im.shape[:2]
    c = im[h - 200:, w - 400:].astype(int)
    b = c[:, :, 0] - np.maximum(c[:, :, 1], c[:, :, 2]) > 50
    rows = [y for y in range(b.shape[0]) if b[y].sum() > 20]
    if not rows: return None, None
    xs = np.nonzero(b[rows[len(rows) // 2]])[0]
    return (xs.max() - xs.min() + 1) * 10.0, (w - 400 + xs.min() - 10, h - 200 + rows[0] - 10)


def vb_table(root):
    jp = os.path.join(root, 'raw/extradrey/_meta/vb_max.json')
    try:
        import openpyxl
    except ImportError:
        return {tuple(k.split('@')[0:1]) + (int(k.split('@')[1]),): v for k, v in json.load(open(jp)).items()} if os.path.exists(jp) else {}
    ws = openpyxl.load_workbook(os.path.join(root, 'raw/extradrey/_meta/Experiment_Documentation.xlsx'), read_only=True).worksheets[0]
    hdr, out = None, {}
    for r in ws.iter_rows(values_only=True):
        if r and r[0] == 'ID': hdr = {k: i for i, k in enumerate(r)}; continue
        if hdr and r and r[hdr['Cutting edge']] and r[hdr['VB_Max']] is not None:
            try:
                out[(r[hdr['Cutting edge']], int(r[hdr['Cutting Time End [s]']]))] = dict(vb=float(r[hdr['VB_Max']]), material=r[hdr['Material']],
                                                                                       geometry=r[hdr['Tool Geometry']])
            except (TypeError, ValueError):
                pass
    json.dump({'%s@%d' % k: v for k, v in out.items()}, open(jp, 'w'), indent=0)
    return out


def main(root):
    R = os.path.join(root, 'raw/extradrey')
    P = os.path.join(root, 'processed')
    for d in ('images', 'masks', 'labelinfo'): os.makedirs(os.path.join(P, d), exist_ok=True)
    vbt = vb_table(root)
    n, stats = 0, {}
    for mp in sorted(glob.glob(os.path.join(R, 'CT*/Images/Mask/*_mask.png'))):
        base = os.path.basename(mp)[:-9]
        mo = re.match(r'(CT(\d+)_(\d+))_(\d+)s_(FF|RF|CE)(L?)$', base)
        if not mo: print('skip name', base); continue
        edge, tool, ed, t, face, lo = mo.group(1), int(mo.group(2)), int(mo.group(3)), int(mo.group(4)), mo.group(5), mo.group(6)
        ip = os.path.join(R, edge, 'Images/Image', base + '.jpg')
        if not os.path.exists(ip): print('no image', base); continue
        im, m0 = imread(ip, cv2.IMREAD_COLOR), imread(mp, cv2.IMREAD_GRAYSCALE)
        if im is None or m0 is None or im.shape[:2] != m0.shape: print('bad pair', base); continue
        bad = ~np.isin(m0, list(MAP))
        m = np.zeros_like(m0)
        for s, d in MAP.items(): m[m0 == s] = d
        m[bad] = 255
        if face == 'CE': print('skip CE', base); continue
        pxmm, box = scale_bar(im)
        pxmm_src = 'scale bar'
        if pxmm is None or not (0.8 < pxmm / PXMM_DEFAULT[lo] < 1.2):
            pxmm, pxmm_src = PXMM_DEFAULT[lo], 'magnification default'
        if box: m[box[1]:, box[0]:] = 255
        else: m[-140:, -200:] = 255
        quality = 'expert mask (dataset)'
        if face == 'RF' and t > 0:
            tool_m = (m == 1).astype(np.uint8)
            pad = cv2.copyMakeBorder(tool_m, 1, 1, 1, 1, cv2.BORDER_REPLICATE)
            dist = cv2.distanceTransform(pad, cv2.DIST_L2, 5)[1:-1, 1:-1]
            m[(tool_m > 0) & (dist < RF_BAND_MM * pxmm)] = 255
            quality = 'tool-only'
        s = min(1.0, MAXW / im.shape[1])
        if s < 1:
            sz = (round(im.shape[1] * s), round(im.shape[0] * s))
            im = cv2.resize(im, sz, interpolation=cv2.INTER_AREA); m = cv2.resize(m, sz, interpolation=cv2.INTER_NEAREST)
        sid = 'xd_%s_%ds_%s%s' % (edge, t, face, lo)
        cv2.imencode('.png', im)[1].tofile(os.path.join(P, 'images', sid + '.png'))
        cv2.imencode('.png', m)[1].tofile(os.path.join(P, 'masks', sid + '.png'))
        v = vbt.get((edge, t), {})
        info = dict(source='extradrey', edge=edge, toolId='CT%03d' % tool, edgeNo=ed, timeS=t, view={'FF': 'flank', 'RF': 'rake'}[face] + (' 100x' if lo else ' 150x'),
                    magnification=100 if lo else 150, pxPerMm=round(pxmm * s, 1), pxPerMmSource=pxmm_src, labelQuality=quality,
                    vbUm=v.get('vb'), material=v.get('material'), toolGeometry=v.get('geometry'), wearPx=int((m == 2).sum()),
                    rawImage=os.path.relpath(ip, root).replace('\\', '/'), rawMask=os.path.relpath(mp, root).replace('\\', '/'))
        json.dump(info, open(os.path.join(P, 'labelinfo', sid + '.json'), 'w'))
        n += 1; k = face + lo; stats[k] = stats.get(k, 0) + 1
    print('installed', n, stats, 'vb rows', len(vbt))


if __name__ == '__main__':
    if '--vb' in sys.argv: print(len(vb_table(sys.argv[1])), 'VB rows')
    else: main(sys.argv[1])
