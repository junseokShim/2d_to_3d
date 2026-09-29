"""Keyence VHX ground-truth labels for Tool3D microscope mode (toolwear format).

Inputs  C:/agent_research_team/datasets/키엔스자료/*.tif (VHX screenshots, 2880x2160; 152822 stitched 8011x3426)
Outputs <DS>/reference/keyence/{images,masks,labelinfo,work}/keyence_<id>.*   (datasets only, never the repo)

Working resolution: long side <= 1600 px (the app's network input cap), recorded as scale + px/mm in labelinfo.
Classes: 0 background, 1 tool, 2 flank wear land, 3 chipping, 255 ignore.

How a field is labelled (one field = one clean image + its annotated twin, pixel-identical apart from the overlays):
  background  SAM2 (point prompts in the dark out-of-focus background), holes (debris) -> 255
  coating     SAM2 (point prompts on the unworn coated flank); the unworn flank = class 1
  wear land   tool pixels inside the hand polygon `land` that SAM calls non-coating, plus the edge side of the hand
              polylines `bandB` (the polished band between the dark worn zone and the coating texture: SAM merges it
              with the coating, the Keyence operator counts it as worn)
  chipping    hand polygons `chip` (conchoidal fracture craters) intersected with the wear land
  ignore      Keyence UI (lens label, scale bar, measurement arrows/lines/text = |twin - clean| > 30, dilated),
              `ign` polygons (unlit far faces, stitch gaps), tool outside the land that SAM calls non-coating
              (thin edge band, uncertain), `unc` polygons (uncertain wear boundary), and a thin band on the coating
              side of the wear boundary.
Run: .venv python scripts/data/label_keyence.py [field ...]   (SAM masks are cached in work/; --resam to redo)
"""
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

SRC = 'C:/agent_research_team/datasets/키엔스자료'
DS = os.environ.get('TOOLWEAR', 'C:/agent_research_team/datasets/toolwear')
OUT = os.path.join(DS, 'reference', 'keyence')
SAM_CKPT = 'C:/agent_research_team/datasets/models/sam2/sam2.1_hiera_small.pt'
LONG = 1600

# all coordinates in full-resolution TIF pixels
FIELDS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'keyence_spec.json'), encoding='utf-8'))


def load(n):
    im = Image.open(f'{SRC}/20260828_{n}.tif'); im.seek(0)
    return im.convert('RGB')


def poly_mask(polys, W, H, s):
    m = Image.new('L', (W, H), 0); d = ImageDraw.Draw(m)
    for p in polys: d.polygon([(x * s, y * s) for x, y in p], fill=1)
    return np.asarray(m, bool)


def band_side(line, far, W, H, s):
    """edge side of a polyline: polygon = the line + the line shifted by `far` (full px vector) towards the edge"""
    p = line + [(x + far[0], y + far[1]) for x, y in reversed(line)]
    return poly_mask([p], W, H, s)


_PRED = None
def sam(a, pos, neg, s, cache):
    global _PRED
    if os.path.exists(cache) and '--resam' not in sys.argv: return np.load(cache)
    if _PRED is None:
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        _PRED = SAM2ImagePredictor(build_sam2('configs/sam2.1/sam2.1_hiera_s.yaml', SAM_CKPT, device='cuda' if torch.cuda.is_available() else 'cpu'))
    _PRED.set_image(a)
    pts = np.array(pos + neg, float) * s
    m, sc, _ = _PRED.predict(point_coords=pts, point_labels=np.array([1] * len(pos) + [0] * len(neg)), multimask_output=True)
    k = int(np.argmax(sc)); np.save(cache, m[k].astype(bool)); return m[k].astype(bool)


def border(m, k=8):
    """SAM leaves a few border rows/columns out: copy the mask from k px inside"""
    return np.pad(m[k:-k, k:-k], k, mode='edge')


def dilate(m, r):
    return np.asarray(Image.fromarray(m.astype(np.uint8) * 255).filter(ImageFilter.MaxFilter(2 * r + 1))) > 0


def fill_holes(m):
    """background holes (not connected to the border through ~m) -> True"""
    from scipy import ndimage
    return ndimage.binary_fill_holes(m)


def largest(m):
    from scipy import ndimage
    lab, n = ndimage.label(m)
    if n <= 1: return m
    sz = ndimage.sum(m, lab, range(1, n + 1)); return lab == (1 + int(np.argmax(sz)))


def keyence_lines(ann, clean=None, sel=None):
    """Keyence overlay lines (reference edge line + the parallel lines drawn to it), RANSAC on coloured overlay pixels.
    ann/clean: full-res RGB int arrays; overlay pixels = |ann - clean| > 30 (or `sel` mask when there is no clean twin).
    -> [{c, t, n, x}] (full px), first = the reference (most pixels), each with distRefPx = distance to the reference"""
    if sel is None:
        d = np.abs(ann - clean).max(2) > 30; ys, xs = np.nonzero(d); C = ann[ys, xs]
        r, g, b = C.T; keep = ((g > r + 15) & (g > b + 15)) | ((b > r + 40) & (g > r + 40))   # green / cyan dotted + thin lines
        P = np.c_[xs[keep], ys[keep]].astype(float)
    else:
        ys, xs = np.nonzero(sel); P = np.c_[xs, ys].astype(float)
    rng = np.random.default_rng(0); out = []
    for _ in range(4):
        if len(P) < 60: break
        best = None
        for _ in range(3000):
            i, j = rng.choice(len(P), 2, replace=False); dv = P[j] - P[i]; nn = np.hypot(*dv)
            if nn < 50: continue
            nv = np.array([-dv[1], dv[0]]) / nn; inl = np.abs((P - P[i]) @ nv) < 2
            if best is None or inl.sum() > best.sum(): best = inl
        if best.sum() < 60: break
        q = P[best]; c = q.mean(0); tv = np.linalg.svd(q - c)[2][0]; tv = tv if tv[0] > 0 else -tv; nv = np.array([-tv[1], tv[0]])
        out.append(dict(c=c.round(2).tolist(), t=tv.round(5).tolist(), n=int(best.sum()), x=[float(q[:, 0].min()), float(q[:, 0].max())]))
        P = P[np.abs((P - c) @ nv) > 7]
    if out:
        c0, t0 = np.array(out[0]['c']), np.array(out[0]['t']); n0 = np.array([-t0[1], t0[0]])
        for L in out: L['distRefPx'] = round(float(abs((np.array(L['c']) - c0) @ n0)), 2)
    return out


def run(fid, F):
    im = load(F['src']); W0, H0 = im.size; s = min(1, LONG / max(W0, H0)); W, H = round(W0 * s), round(H0 * s)
    a = np.asarray(im.resize((W, H), Image.LANCZOS))
    os.makedirs(f'{OUT}/work', exist_ok=True)
    bg = sam(a, F['bgPos'], F['bgNeg'], s, f'{OUT}/work/{fid}_bg.npy')
    bg = border(bg)   # SAM drops the image border
    bg = largest(bg); bgf = fill_holes(bg); debris = bgf & ~bg
    coat = sam(a, F['coatPos'], F['coatNeg'], s, f'{OUT}/work/{fid}_coat.npy').copy()
    coat = border(coat)
    tool = ~bgf
    land = poly_mask(F['land'], W, H, s)
    wear = np.zeros((H, W), bool)
    wear |= tool & land & ~coat
    for b in F.get('bandB', []): wear |= tool & land & band_side(b['line'], b['far'], W, H, s)
    from scipy import ndimage
    wear = ndimage.binary_opening(wear, iterations=1); wear = ndimage.binary_fill_holes(wear) & tool
    lab, n = ndimage.label(wear); near = dilate(bgf, 3)                                  # keep wear touching the cutting edge
    keep = np.unique(lab[near & wear]); wear = np.isin(lab, keep[keep > 0])
    m = np.where(tool, 1, 0).astype(np.uint8)
    m[wear] = 2
    if F.get('chip'): m[wear & poly_mask(F['chip'], W, H, s)] = 3
    ign = debris.copy()
    # tool outside the land that SAM does not call coating: within edgeBand px of the edge = thin rim (uncertain) -> 255,
    # farther away = other unworn faces of the tool (unlit / ground faces beyond the flank) -> tool
    other = tool & ~land & ~coat
    ign |= other & dilate(bgf, max(1, round(F.get('edgeBand', 40) * s)))
    ign |= poly_mask(F.get('ign', []), W, H, s) | poly_mask(F.get('unc', []), W, H, s)
    ign |= dilate(wear, 2) & ~wear & tool                                               # coating side of the wear boundary
    for x0, y0, x1, y1 in F.get('ui', []): ign[int(y0 * s):int(y1 * s) + 1, int(x0 * s):int(x1 * s) + 1] = True
    klines0 = []
    if F.get('overlayByColour'):   # no clean twin: Keyence overlay by colour (red arrows/marks, green dotted line near its fitted line, pure black stitch gaps)
        A = np.asarray(im).astype(int); r, g, b = A[..., 0], A[..., 1], A[..., 2]
        red = (r > 180) & (g < 70) & (b < 70); black = A.max(2) < 4
        klines0 = keyence_lines(None, sel=(g > r + 25) & (g > b + 25) & (g > 140))[:1]
        c0, t0 = np.array(klines0[0]['c']), np.array(klines0[0]['t']); yy, xx = np.mgrid[0:H0, 0:W0]
        v = (xx - c0[0]) * -t0[1] + (yy - c0[1]) * t0[0]; u = (xx - c0[0]) * t0[0] + (yy - c0[1]) * t0[1]
        x = xx; dotted = (np.abs(v) < 6) & (x >= klines0[0]['x'][0] - 5) & (x <= klines0[0]['x'][1] + 5)
        for extra in F.get('overlayLines', []):   # the drawn parallel boundary line: v = dist, u in [u0, u1] from the arrow foot
            foot = np.array(extra['foot']); uu = (xx - foot[0]) * t0[0] + (yy - foot[1]) * t0[1]
            dotted |= (np.abs(np.abs(v) - extra['dist']) < 5) & (uu > extra['u'][0] - 5) & (uu < extra['u'][1] + 5)
        ov = red | dotted | black
        ovw = np.asarray(Image.fromarray(ov.astype(np.uint8) * 255).resize((W, H), Image.BILINEAR)) > 0
        ign |= dilate(ovw, 2)
        del A, r, g, b, yy, xx, v, u, x
    base = m.copy(); base[ign] = 255
    os.makedirs(f'{OUT}/images', exist_ok=True); os.makedirs(f'{OUT}/masks', exist_ok=True); os.makedirs(f'{OUT}/labelinfo', exist_ok=True)
    ppm_full = F['pxPerMm']
    for n in [F['src']] + F.get('twins', []):
        mk = base.copy(); img = a
        klines = klines0 + ([dict(klines0[0], c=list(np.array(klines0[0]['c']) + np.array([klines0[0]['t'][1], -klines0[0]['t'][0]]) * L['dist']), n=0, distRefPx=L['dist']) for L in F.get('overlayLines', [])] if klines0 else [])
        if n != F['src']:
            b = np.asarray(load(n)).astype(int); d = np.abs(b - np.asarray(im).astype(int)).max(2) > 30
            klines = keyence_lines(b, np.asarray(im).astype(int))
            dd = np.asarray(Image.fromarray(d.astype(np.uint8) * 255).resize((W, H), Image.BILINEAR)) > 0
            mk[dilate(dd, 3)] = 255
            img = np.asarray(load(n).resize((W, H), Image.LANCZOS))
        Image.fromarray(img).save(f'{OUT}/images/keyence_{n}.png'); Image.fromarray(mk).save(f'{OUT}/masks/keyence_{n}.png')
        cnt = {int(k): int(v) for k, v in zip(*np.unique(mk, return_counts=True))}
        meas = []
        for mm in F['measurements'].get(n, []):
            e = dict(mm, p1w=[round(v * s, 1) for v in mm['p1']], p2w=[round(v * s, 1) for v in mm['p2']])
            if klines:   # exact geometry: foot of the arrow on the reference line, normal towards p1, the drawn line's distance
                c0, t0 = np.array(klines[0]['c']), np.array(klines[0]['t']); n0 = np.array([-t0[1], t0[0]])
                p1, p2 = np.array(mm['p1']), np.array(mm['p2']); foot = c0 + t0 * ((p2 - c0) @ t0); n0 = n0 if (p1 - foot) @ n0 > 0 else -n0
                far = foot + n0 * ((p1 - foot) @ n0)
                L = min(klines[1:], key=lambda L: abs(L['distRefPx'] - abs((p1 - foot) @ n0)))
                e.update(footW=(foot * s).round(2).tolist(), normalW=n0.round(5).tolist(), linePxFull=L['distRefPx'], linePxW=round(L['distRefPx'] * s, 2),
                         pxPerMmFromLine=round(L['distRefPx'] / mm['valueUm'] * 1000, 1))
            meas.append(e)
        info = dict(id=f'keyence_{n}', source=f'{SRC}/20260828_{n}.tif', field=fid, cleanTwin=F['src'], magnification=F['mag'], lens=F.get('lens'),
                    fullSize=[W0, H0], workSize=[W, H], scale=round(s, 6), pxPerMmFull=ppm_full, pxPerMm=round(ppm_full * s, 3), umPerPx=round(1000 / (ppm_full * s), 4),
                    scaleSource=F.get('scaleSource', 'blue VHX scale bar'), pxPerMmScaleBar=F.get('pxPerMmScaleBar'), edge=F['edge'], measurements=meas, keyenceLines=[dict(L, c=[round(v * s, 2) for v in L['c']], x=[round(v * s, 1) for v in L['x']], distRefPxW=round(L['distRefPx'] * s, 2)) for L in klines], pixels=cnt, notes=F.get('notes', ''),
                    classes={'0': 'background', '1': 'tool (unworn coated flank)', '2': 'flank wear land', '3': 'chipping', '255': 'ignore'})
        json.dump(info, open(f'{OUT}/labelinfo/keyence_{n}.json', 'w', encoding='utf-8'), indent=1, ensure_ascii=False)
        print(n, W, H, 'px/mm', info['pxPerMm'], cnt)


if __name__ == '__main__':
    want = [a for a in sys.argv[1:] if not a.startswith('--')]
    for fid, F in FIELDS.items():
        if not want or fid in want: run(fid, F)
