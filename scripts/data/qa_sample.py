"""QA sheets: random 10% (min 2) of each source's processed pairs -> qa/<source>/sheet_NN.jpg (image | overlay, 3 per row)
and qa/<source>/sample.json (the ids). Inspect the sheets, then record rejects in qa/<source>/rejects.json.
  python qa_sample.py <root> [--frac 0.1] [--seed 0] [--prefix mud_,syn_]
"""
import argparse, glob, json, os, random
import cv2, numpy as np
from overlay import over

SRC = {'mud_': 'mudestreda', 'syn_': 'synth_endmill', 'matwi_': 'matwi', 'aqifi_': 'aqifi_endmill', 'qit_': 'qit_cemc', 'target_': 'target'}

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('root'); ap.add_argument('--frac', type=float, default=0.1)
    ap.add_argument('--seed', type=int, default=0); ap.add_argument('--prefix', default=','.join(SRC)); ap.add_argument('--w', type=int, default=360); ap.add_argument('--cols', type=int, default=3); ap.add_argument('--per', type=int, default=12)
    a = ap.parse_args()
    ids = sorted(os.path.basename(p)[:-4] for p in glob.glob(os.path.join(a.root, 'processed/masks/*.png')))
    for pre in a.prefix.split(','):
        mine = [i for i in ids if i.startswith(pre)]
        if not mine: continue
        rnd = random.Random(a.seed)
        pick = sorted(rnd.sample(mine, max(2, min(len(mine), round(a.frac * len(mine))))))
        out = os.path.join(a.root, 'qa', SRC[pre]); os.makedirs(out, exist_ok=True)
        json.dump(pick, open(os.path.join(out, 'sample.json'), 'w'), indent=0)
        tiles = []
        for i in pick:
            img = cv2.imread(os.path.join(a.root, 'processed/images', i + '.png'))
            m = cv2.imread(os.path.join(a.root, 'processed/masks', i + '.png'), cv2.IMREAD_GRAYSCALE)
            t = np.concatenate([img, over(img, m)], 1)
            s = 2 * a.w / t.shape[1]; t = cv2.resize(t, (2 * a.w, int(t.shape[0] * s)), interpolation=cv2.INTER_AREA)
            cv2.putText(t, i, (4, 14), cv2.FONT_HERSHEY_SIMPLEX, .45, (0, 0, 255), 1)
            tiles.append(t)
        per = a.per
        for k in range(0, len(tiles), per):
            ts = tiles[k:k + per]
            H = max(t.shape[0] for t in ts)
            ts = [cv2.copyMakeBorder(t, 0, H - t.shape[0] + 2, 0, 2, cv2.BORDER_CONSTANT) for t in ts]
            while len(ts) % a.cols: ts.append(np.zeros_like(ts[0]))
            sheet = np.concatenate([np.concatenate(ts[r:r + a.cols], 1) for r in range(0, len(ts), a.cols)], 0)
            cv2.imwrite(os.path.join(out, 'sheet_%02d.jpg' % (k // per)), sheet, [cv2.IMWRITE_JPEG_QUALITY, 85])
        print(SRC[pre], len(mine), 'sampled', len(pick))
