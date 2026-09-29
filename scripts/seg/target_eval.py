"""Evaluate a wear segmentation model on the human's target photos (processed/target_*: eval only, never trained on).

The target masks hold only background / tool (no wear labels), so this reports
  * tool IoU (predicted class > 0 vs labelled tool) inside the network window,
  * wear pixels (classes 2-4) outside the (dilated) labelled tool = hallucination on the background,
  * wear area (mm^2, projected) inside the tool, split into the tip zone (first 0.3 D from the tip) and the flank below,
and writes an overlay per photo.  The window mimics www/js/wear/seg-wear.js: side photos are cut tool-aligned around the
tip (0.3 D above the tip .. 1.5 D below, 1.3 D either side of the axis) and scaled so the tool diameter is NET_D px;
the top photo is a 2.8 r square around the end face.  Target photos are ~11 px/mm with the tool ~10 mm (D10).

usage: target_eval.py CKPT OUTDIR [--encoder ...]
"""
import os, sys, json, argparse
import numpy as np, cv2, torch
sys.path.insert(0, os.path.dirname(__file__))
import data

NET_D = 256
COL = np.array([[0, 0, 0], [60, 60, 60], [255, 220, 0], [255, 40, 40], [40, 160, 255]], np.uint8)   # RGB per class
D_MM = 10.0


def targets(root=data.DS_ROOT):
    return data.load_real('target', root).get('target', [])


def window(img, tool, stem):
    """-> (crop RGB uint8 [H,W,3] multiple of 32, tool mask crop, info)"""
    ys, xs = np.nonzero(tool)
    if 'top' in stem:
        cx, cy = xs.mean(), ys.mean()
        r = .5 * max(xs.max() - xs.min(), ys.max() - ys.min())
        k = NET_D / (2 * r)
        S = int(np.ceil(2.8 * r * k / 32) * 32)
        M = np.float32([[k, 0, S / 2 - k * cx], [0, k, S / 2 - k * cy]])
        size, D, tip = (S, S), 2 * r, None
    else:
        tip = ys.min()
        rows = range(tip + 5, min(tool.shape[0], tip + 80))
        wid = [np.count_nonzero(tool[y]) for y in rows]
        D = float(np.median(wid))
        cx = float(np.median([np.nonzero(tool[y])[0].mean() for y in rows if tool[y].any()]))
        k = NET_D / D
        W = int(np.ceil(2.6 * D * k / 32) * 32)
        H = int(np.ceil(1.8 * D * k / 32) * 32)
        y0 = tip - .3 * D
        M = np.float32([[k, 0, W / 2 - k * cx], [0, k, -k * y0]])
        size = (W, H)
    crop = cv2.warpAffine(img, M, size, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE)
    tm = cv2.warpAffine(tool.astype(np.uint8), M, size, flags=cv2.INTER_NEAREST)
    ppm = D / D_MM * k
    return crop, tm, dict(k=k, D=D, ppm=ppm, tipY=(.3 * D * k) if tip is not None else None)


@torch.no_grad()
def predict(model, crop, dev='cuda'):
    import train
    x = train.to_input(crop[None], dev)
    with torch.autocast('cuda', dtype=torch.bfloat16):
        p = model(x).float().softmax(1)[0]
    return p.argmax(0).cpu().numpy().astype(np.uint8), p.cpu().numpy()


def overlay(crop, pred, tm):
    o = crop.copy()
    m = pred >= 2
    o[m] = (.45 * o[m] + .55 * COL[pred[m]]).astype(np.uint8)
    c, _ = cv2.findContours((pred > 0).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(o, c, -1, (0, 255, 0), 1)
    c, _ = cv2.findContours(tm, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(o, c, -1, (255, 0, 255), 1)
    return np.hstack([crop, o])


def evaluate(model, outdir=None, tag='', dev='cuda'):
    was = model.training
    model.eval()
    res, tiles = {}, []
    for ip, mp_, stem in targets():
        img = cv2.imread(ip, cv2.IMREAD_COLOR)[..., ::-1].copy()
        tool = cv2.imread(mp_, cv2.IMREAD_UNCHANGED) > 0
        crop, tm, info = window(img, tool, stem)
        pred, _ = predict(model, crop, dev)
        t, pt = tm > 0, pred > 0
        iou = float((t & pt).sum() / max(1, (t | pt).sum()))
        near = cv2.dilate(tm, np.ones((15, 15), np.uint8)) > 0
        a = 1 / info['ppm'] ** 2
        r = {'toolIoU': round(iou, 3), 'bgWearMm2': round(float(((pred >= 2) & ~near).sum()) * a, 3)}
        if info['tipY'] is not None:
            yy = np.arange(pred.shape[0])[:, None]
            tipz = (yy < info['tipY'] + .3 * NET_D) & near
            for c in (2, 3, 4):
                r[f'tip{c}'] = round(float(((pred == c) & tipz).sum()) * a, 3)
                r[f'flank{c}'] = round(float(((pred == c) & near & ~tipz).sum()) * a, 3)
        else:
            for c in (2, 3, 4):
                r[f'face{c}'] = round(float(((pred == c) & near).sum()) * a, 3)
        res[stem.replace('target_', '')] = r
        if outdir:
            ov = overlay(crop, pred, tm)
            tiles.append(cv2.resize(ov, (int(ov.shape[1] * 300 / ov.shape[0]), 300)))
    if outdir and tiles:
        os.makedirs(outdir, exist_ok=True)
        w = max(t.shape[1] for t in tiles)
        tiles = [cv2.copyMakeBorder(t, 2, 2, 0, w - t.shape[1], cv2.BORDER_CONSTANT) for t in tiles]
        cv2.imwrite(os.path.join(outdir, f'target{tag}.png'), np.vstack(tiles)[..., ::-1])
    model.train(was)
    return res


def fmt(res):
    return ' '.join(f"{k}[iou {v['toolIoU']:.2f} bg {v['bgWearMm2']:.2f} " +
                    ' '.join(f'{kk} {vv:.2f}' for kk, vv in v.items() if kk[:3] in ('tip', 'fla', 'fac') and vv > 0) + ']'
                    for k, v in res.items())


if __name__ == '__main__':
    import train
    ap = argparse.ArgumentParser()
    ap.add_argument('ckpt')
    ap.add_argument('outdir')
    ap.add_argument('--encoder', default='tu-mobilenetv3_large_100')
    a = ap.parse_args()
    m = train.build(a.encoder, weights=None).cuda()
    m.load_state_dict(torch.load(a.ckpt, map_location='cuda'))
    res = evaluate(m, a.outdir)
    print(json.dumps(res, indent=1))
    json.dump(res, open(os.path.join(a.outdir, 'target.json'), 'w'), indent=1)
