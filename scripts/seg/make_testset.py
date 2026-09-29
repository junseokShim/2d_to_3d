"""Held-out synthetic test photos for test/wear/seg-run.js: whole tools (tip up, full frame, background, noise, JPEG),
one side photo per flute (tool turned by 360/k between shots) + one top photo, with ground-truth label PNGs.
Seeds are disjoint from the training pool (pool ids < 1e6 use seed 1000003*id+17).

--seed_add N makes a different set with the same recipe (engine-level validation, e.g. .work/valset; the committed
test set uses 0).  vbMaxMm = the nominal land per flute; vbZoneBMm / vbCornerMm = what the render actually draws
(rendered_vb), the reference of seg-run.js.  --patch_index adds those two to an existing set without re-rendering.
usage: make_testset.py OUTDIR [--w 400 --h 440] [--seed_add N]
"""
import os, sys, json, math, argparse
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(__file__))
import render, augment


def photo(rng, rgb, a, lab, low_light=False):
    h, w = lab.shape
    bg = augment.background(rng, h, w)
    img = rgb * a[..., None] + bg * (1 - a[..., None])
    img *= np.array([augment.U(rng, .9, 1.1), 1, augment.U(rng, .9, 1.1)], np.float32)
    if low_light:
        img *= .2
    img = cv2.GaussianBlur(img.astype(np.float32), (0, 0), augment.U(rng, .5, 1.0))
    img = np.clip(img, 0, 1)
    img = img + cv2.randn(np.empty(img.shape, np.float32), 0, 1) * np.sqrt(.002 * img + .003 ** 2) * (3 if low_light else 1)
    img = np.clip(img, 0, 1)
    if low_light:
        img = np.clip(img * 4, 0, 1)
    im8 = (img ** (1 / 2.2) * 255 + .5).astype(np.uint8)
    ok, buf = cv2.imencode('.jpg', im8[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 80])
    return cv2.imdecode(buf, cv2.IMREAD_COLOR)     # BGR


def rendered_vb(tool, zb=.36):
    """the land the render actually draws (render.wear_label: vb * ragged noise * corner boost, tapered at ap), per flute:
    zone-B VBmax (ISO 8688-2 VB without the corner: z > zb R, where the corner boost has decayed below 5 %) and the
    corner max (z <= zb R, corner boost included)"""
    import torch
    W, R = tool.wear, tool.R
    z = torch.linspace(0, 1.3 * tool.D, 2000, dtype=torch.float64)
    zoneB, corner = [], []
    for i in range(tool.k):
        if W is None or W['ap'] <= 0 or W['vb'][i] <= 0:
            zoneB.append(0.); corner.append(0.); continue
        n = render._noise2(z * 6, torch.full_like(z, i * 3.1), W['seed'], freqs=(1, 3, 9), amps=(1, .5, .3))
        prof = W['vb'][i] * (1 + .25 * n) * (1 + (W['cornerBoost'][i] - 1) * torch.exp(-z / (.12 * R))) * (1 - torch.sigmoid((z - W['ap']) / (.04 * R + .02)))
        zoneB.append(round(float(prof[z > zb * R].max()), 4)); corner.append(round(float(prof[z <= zb * R].max()), 4))
    return zoneB, corner


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('out')
    ap.add_argument('--w', type=int, default=400)
    ap.add_argument('--h', type=int, default=440)
    ap.add_argument('--seed_add', type=int, default=0)
    ap.add_argument('--patch_index', action='store_true', help='only add vbZoneBMm / vbCornerMm to an existing index.json (no render)')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    cases = [dict(name='t4', k=4, D=10, seed=9_000_001, mode='flank', vb=.25, top=True),
             dict(name='t3low', k=3, D=12, seed=9_000_004, mode='flank', vb=.3, low=True),
             dict(name='t2chip', k=2, D=8, seed=9_000_003, mode='chip', vb=.2, top=True),
             dict(name='clean', k=2, D=10, seed=9_000_005, mode='none', vb=0)]
    index = json.load(open(os.path.join(a.out, 'index.json'))) if a.patch_index else []
    for c in cases:
        c['seed'] += a.seed_add
        rng = np.random.default_rng(c['seed'])
        tool = render.Tool(rng, D=c['D'])
        tool.k = c['k']; tool.P = 2 * math.pi / tool.k
        tool.beta = math.radians(30)
        render.plan_wear(tool, rng, c['mode'])
        if c['mode'] != 'none':
            tool.wear['vb'][:] = c['vb'] * np.linspace(.8, 1.2, tool.k)
            tool.wear['ap'] = max(tool.wear['ap'], .5 * tool.D)
        zoneB, corner = rendered_vb(tool)
        if a.patch_index:
            for e in index:
                if e['case'] == c['name']:
                    e.update(vbZoneBMm=zoneB, vbCornerMm=corner)
            continue
        dpx = .4 * a.w                       # tool diameter in the photo
        ppm = dpx / tool.D
        phi0 = tool.phi0
        for i in range(tool.k + (1 if c.get('top') else 0)):
            view = 'side' if i < tool.k else 'top'
            tool.phi0 = phi0 + i * tool.P
            r = np.random.default_rng(c['seed'] * 10 + i)
            rgb, lab, al, meta = render.render(r, a.h, a.w, view=view, ppm=ppm, mode='keep', tool=tool, fixed=dict(elev=4 if view == 'side' else 88, tipFrac=.15, xo=0))
            img = photo(r, rgb, al, lab, c.get('low', False))
            fn = f"{c['name']}_{'side%d' % (i + 1) if view == 'side' else 'top'}"
            cv2.imwrite(os.path.join(a.out, fn + '.png'), img)
            cv2.imwrite(os.path.join(a.out, fn + '_lab.png'), lab)
            index.append(dict(file=fn + '.png', label=fn + '_lab.png', case=c['name'], view=view, flutes=tool.k, D=tool.D, ppm=ppm,
                              vbMaxMm=[float(v) for v in tool.wear['vb']], vbZoneBMm=zoneB, vbCornerMm=corner, chips=len(tool.chips), blobs=len(tool.blobs), low=bool(c.get('low'))))
            print(fn, np.bincount(lab.ravel(), minlength=5), flush=True)
    json.dump(index, open(os.path.join(a.out, 'index.json'), 'w'), indent=1)


if __name__ == '__main__':
    main()
