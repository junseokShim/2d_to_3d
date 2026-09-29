"""Evaluate checkpoints on labelled real images of the human's USB microscope (processed/hum_*) and other labelled real
sets (qit_w_*), per image and per tool: tool / chip / damage IoU, chip depth and VBC from the tip line, VBmax of the flank
land, the same way worker-hlabel's label_human.py measured the ground truth (labelinfo/<stem>.json).

The network sees the whole frame scaled so the tool diameter is NET_D px (the app's side window uses 128-256 px);
the prediction is resampled (nearest) to the label grid.

usage: fold_eval.py OUTDIR CKPT[=name] [CKPT ...] [--match REGEX] [--net_d 256]
"""
import os, re, sys, json, glob, argparse
import numpy as np, cv2, torch
sys.path.insert(0, os.path.dirname(__file__))
import train, target_eval, data

P = os.path.join(data.DS_ROOT, 'processed')
KEYENCE = os.path.join(data.DS_ROOT, 'reference', 'keyence')      # Keyence VHX insert images (no tool diameter): whole frame, short side --short


def land_width(m, ppm):
    """label_human.py land_width: class-2 land width perpendicular to its principal axis -> max mm"""
    n, lbl, st, _ = cv2.connectedComponentsWithStats(m.astype(np.uint8), 8)
    best = 0.0
    for i in range(1, n):
        if st[i, 4] < 30:
            continue
        ys, xs = np.nonzero(lbl == i)
        Q = np.c_[xs, ys].astype(float); mu = Q.mean(0)
        _, _, vt = np.linalg.svd(Q - mu, full_matrices=False)
        u = (Q - mu) @ vt[0]; v = (Q - mu) @ vt[1]
        bins = np.floor((u - u.min()) / max(1.0, 0.1 * ppm)).astype(int)
        for k in np.unique(bins):
            vv = v[bins == k]
            if len(vv) > 3:
                best = max(best, (np.percentile(vv, 99) - np.percentile(vv, 1) + 1) / ppm)
    return best


def depth_map(info, h, w):
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    if info.get('tipLine'):
        a, b = info['tipLine']
        return (ys - (a * xs + b)) / np.sqrt(1 + a * a)
    cx, cy, R = info['circle']
    return R - np.hypot(xs - cx, ys - cy)


def measures(m, info):
    ppm = info['pxPerMm']
    d = depth_map(info, *m.shape)
    chip = m == 3
    out = dict(chipDepthMm=float(d[chip].max()) / ppm if chip.any() else 0.0)
    dm = np.isin(m, (2, 3, 4))
    n, lbl = cv2.connectedComponents(dm.astype(np.uint8), connectivity=8)
    vbc = 0.0
    for i in range(1, n):
        r = lbl == i
        if r.sum() >= 20 and d[r].min() < .1 * ppm + 2:
            vbc = max(vbc, float(d[r].max()) / ppm)
    out['vbcMm'] = vbc
    out['vbMaxMm'] = land_width(m == 2, ppm) if (m == 2).sum() >= 30 else 0.0
    return out


def iou(a, b, valid):
    a, b = a & valid, b & valid
    u = (a | b).sum()
    return float((a & b).sum() / u) if u else float('nan')


def predict_full(model, img, D_px, net_d):
    h, w = img.shape[:2]
    k = net_d / D_px
    W, H = max(32, int(round(w * k / 32)) * 32), max(32, int(round(h * k / 32)) * 32)
    crop = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR)
    pred, _ = target_eval.predict(model, crop)
    return cv2.resize(pred, (w, h), interpolation=cv2.INTER_NEAREST), crop, pred


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('outdir')
    ap.add_argument('ckpts', nargs='+')
    ap.add_argument('--match', default=r'^hum_')
    ap.add_argument('--net_d', type=int, default=256)
    ap.add_argument('--root', default=os.path.join(data.DS_ROOT, 'processed'), help='dataset dir with images/ masks/ labelinfo/ (e.g. fold_eval.KEYENCE)')
    ap.add_argument('--short', type=int, default=384, help='images without a tool diameter: short side in px')
    ap.add_argument('--group', default='', help='regex: summary group = its first match in the stem (default: tool id)')
    ap.add_argument('--encoder', default='tu-mobilenetv3_large_100')
    a = ap.parse_args()
    global P
    P = a.root
    os.makedirs(a.outdir, exist_ok=True)
    stems = sorted(os.path.splitext(os.path.basename(f))[0] for f in glob.glob(os.path.join(P, 'masks', '*.png')))
    stems = [s for s in stems if re.search(a.match, s)]
    res = {}
    for spec in a.ckpts:
        path, name = (spec.split('=', 1) + [None])[:2] if '=' in spec else (spec, os.path.basename(os.path.dirname(spec)) + '/' + os.path.basename(spec))
        m = train.build(a.encoder, weights=None).cuda()
        m.load_state_dict(torch.load(path, map_location='cuda')); m.eval()
        rows, tiles = {}, []
        for s in stems:
            img = cv2.imread(os.path.join(P, 'images', s + '.png'), cv2.IMREAD_COLOR)[..., ::-1].copy()
            lab = cv2.imread(os.path.join(P, 'masks', s + '.png'), cv2.IMREAD_UNCHANGED)
            info = json.load(open(os.path.join(P, 'labelinfo', s + '.json'), encoding='utf-8'))
            ppm = info['pxPerMm']
            Dpx = info['D'] * ppm if info.get('D') else min(img.shape[:2]) * a.net_d / a.short
            pred, crop, pnet = predict_full(m, img, Dpx, a.net_d)
            v = lab != 255
            r = dict(tool=iou(pred > 0, lab > 0, v), chip=iou(pred == 3, lab == 3, v), damage=iou(pred >= 2, lab >= 2, v) if ((lab >= 2) & v).any() or ((pred >= 2) & v).any() else float('nan'),
                     flank=iou(pred == 2, lab == 2, v))
            pm = pred.copy(); pm[~v] = 0
            pr = measures(pm, info) if info.get('tipLine') or info.get('circle') else {}
            gt = info.get('gt', {})
            r.update({k + 'Pred': round(pr[k], 3) for k in pr})
            r.update(chipDepthGt=gt.get('chipDepthMm') or 0.0, vbcGt=gt.get('vbcMm') or 0.0, vbMaxGt=gt.get('vbMaxMm') or 0.0)
            rows[s] = {k: (round(x, 3) if isinstance(x, float) else x) for k, x in r.items()}
            o = target_eval.overlay(crop, pnet, cv2.resize((lab > 0).astype(np.uint8), (crop.shape[1], crop.shape[0]), interpolation=cv2.INTER_NEAREST))
            # ground-truth damage outline in yellow
            g = cv2.resize((lab >= 2).astype(np.uint8), (crop.shape[1], crop.shape[0]), interpolation=cv2.INTER_NEAREST)
            c, _ = cv2.findContours(g, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            half = o[:, crop.shape[1]:].copy(); cv2.drawContours(half, c, -1, (255, 255, 0), 1); o[:, crop.shape[1]:] = half
            o = cv2.resize(o, (int(o.shape[1] * 180 / o.shape[0]), 180))
            cv2.putText(o, s, (3, 12), cv2.FONT_HERSHEY_SIMPLEX, .4, (255, 255, 0), 1)
            tiles.append(o)
        res[name] = rows
        w = max(t.shape[1] for t in tiles)
        tiles = [cv2.copyMakeBorder(t, 1, 1, 0, w - t.shape[1], cv2.BORDER_CONSTANT) for t in tiles]
        if len(tiles) % 3:
            tiles += [np.zeros_like(tiles[0])] * (3 - len(tiles) % 3)
        sheet = np.vstack([np.hstack(tiles[j:j + 3]) for j in range(0, len(tiles), 3)])
        cv2.imwrite(os.path.join(a.outdir, re.sub(r'[^\w.-]', '_', name) + '.jpg'), sheet[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 80])
        del m; torch.cuda.empty_cache()
    json.dump(res, open(os.path.join(a.outdir, 'fold_eval.json'), 'w'), indent=1)
    # summary per checkpoint and tool group (stem up to the side id)
    for name, rows in res.items():
        groups = {}
        for s, r in rows.items():
            g = re.search(a.group, s).group(0) if a.group and re.search(a.group, s) else re.sub(r'_(s\d_\d|top|\d+|C\d+_side\d)$', '', s)
            groups.setdefault(g, []).append((s, r))
        for g, rs in groups.items():
            side = [r for s, r in rs if not s.endswith('_top')]
            f = lambda k, L=rs: np.nanmean([r[k] for s, r in L]) if L else float('nan')
            e = lambda kp, kg: np.mean([abs(r[kp] - r[kg]) for r in side]) if side and kp in side[0] else float('nan')
            print(f'{name:28s} {g:12s} n{len(rs):2d} IoU tool {f("tool"):.3f} chip {f("chip"):.3f} flank {f("flank"):.3f} damage {f("damage"):.3f} | '
                  f'side |err| chipDepth {e("chipDepthMmPred", "chipDepthGt"):.3f} VBC {e("vbcMmPred", "vbcGt"):.3f} VBmax {e("vbMaxMmPred", "vbMaxGt"):.3f} mm')


if __name__ == '__main__':
    main()
