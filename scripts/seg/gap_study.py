"""Domain-gap study: run a checkpoint on unlabelled real images (the human's USB-microscope samples, QIT-CEMC, Keyence)
and write overlay contact sheets + per-image class shares.

The window is not the app's (no alignment here): the image is scaled so its shorter side is S px (a few S per image),
which puts a tool that fills the frame at D ~ 0.5-0.8 S, the range the app window uses (128-256 px).

usage: gap_study.py CKPT OUTDIR [--sets human,qit,keyence] [--scales 256,384]
"""
import os, sys, glob, json, argparse
import numpy as np, cv2, torch
sys.path.insert(0, os.path.dirname(__file__))
import train, target_eval

DS = 'C:/agent_research_team/datasets'
SETS = {
    'human': lambda: sorted(glob.glob(DS + '/human_samples/*/*/*.jpg')),
    'qit': lambda: sorted(glob.glob(DS + '/toolwear/processed/images/qit_*.png'))[::20],
    'keyence': lambda: sorted(glob.glob(DS + '/키엔스자료/*.tif')),
}


def imread(p):
    b = np.fromfile(p, np.uint8)                       # unicode paths
    im = cv2.imdecode(b, cv2.IMREAD_COLOR)
    return im[..., ::-1].copy()


def run(model, img, S):
    h, w = img.shape[:2]
    k = S / min(h, w)
    W, H = int(np.ceil(w * k / 32) * 32), int(np.ceil(h * k / 32) * 32)
    crop = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA if k < 1 else cv2.INTER_LINEAR)
    pred, _ = target_eval.predict(model, crop)
    return crop, pred


def overlay(crop, pred):
    o = crop.copy()
    m = pred >= 2
    o[m] = (.35 * o[m] + .65 * target_eval.COL[pred[m]]).astype(np.uint8)
    c, _ = cv2.findContours((pred > 0).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(o, c, -1, (0, 255, 0), 1)
    return np.hstack([crop, o])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ckpt')
    ap.add_argument('outdir')
    ap.add_argument('--sets', default='human,qit,keyence')
    ap.add_argument('--scales', default='256,384')
    ap.add_argument('--encoder', default='tu-mobilenetv3_large_100')
    a = ap.parse_args()
    os.makedirs(a.outdir, exist_ok=True)
    m = train.build(a.encoder, weights=None).cuda()
    m.load_state_dict(torch.load(a.ckpt, map_location='cuda'))
    m.eval()
    res = {}
    for sname in a.sets.split(','):
        tiles = []
        for p in SETS[sname]():
            img = imread(p)
            name = os.path.relpath(p, DS).replace('\\', '/')
            for S in map(int, a.scales.split(',')):
                crop, pred = run(m, img, S)
                n = pred.size
                share = [round(float((pred == c).sum()) / n, 4) for c in range(5)]
                tool = max(1, int((pred > 0).sum()))
                res[f'{name}@{S}'] = dict(share=share, wearOfTool=round(float((pred >= 2).sum()) / tool, 4))
                ov = overlay(crop, pred)
                ov = cv2.resize(ov, (int(ov.shape[1] * 200 / ov.shape[0]), 200))
                cv2.putText(ov, f'{os.path.basename(p)} S{S}', (4, 14), cv2.FONT_HERSHEY_SIMPLEX, .45, (255, 255, 0), 1)
                tiles.append(ov)
        # sheets of 12 tiles, 2 per row
        for s0 in range(0, len(tiles), 12):
            ch = tiles[s0:s0 + 12]
            w = max(t.shape[1] for t in ch)
            ch = [cv2.copyMakeBorder(t, 1, 1, 0, w - t.shape[1], cv2.BORDER_CONSTANT) for t in ch]
            if len(ch) % 2:
                ch.append(np.zeros_like(ch[0]))
            rows = [np.hstack(ch[j:j + 2]) for j in range(0, len(ch), 2)]
            cv2.imwrite(os.path.join(a.outdir, f'{sname}_{s0 // 12:02d}.jpg'), np.vstack(rows)[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, 80])
    json.dump(res, open(os.path.join(a.outdir, 'gap.json'), 'w'), indent=1)
    for sname in a.sets.split(','):
        ks = [k for k in res if k.startswith({'human': 'human', 'qit': 'toolwear', 'keyence': '키엔스'}[sname])]
        for S in a.scales.split(','):
            kk = [k for k in ks if k.endswith('@' + S)]
            if kk:
                sh = np.mean([res[k]['share'] for k in kk], 0)
                wt = np.mean([res[k]['wearOfTool'] for k in kk])
                print(f'{sname:8s} S{S} n{len(kk)} share bg/tool/flank/chip/adh ' + ' '.join(f'{v:.3f}' for v in sh) + f'  wear/tool {wt:.3f}')


if __name__ == '__main__':
    main()
