"""Render a pool of phone-like side views with THIN flank lands (seg9): VB 0.1-0.5 mm, 9-30 px/mm native (the app
upsamples such photos to 224-384 px per tool diameter, so the network must place a soft, few-pixel land boundary),
camera near the tool's side (elev -8..15 deg), tip in the upper part of the frame.  Same file layout as gen_pool.py
(train.py --pool2).  Seeds 1000003 * i + 17 with i >= 2e6: disjoint from the main pool and the test / val sets.
usage: gen_pool_thin.py OUT START COUNT [SIZE]"""
import sys, os, json, math, time
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(__file__))
import render

U = lambda r, a, b: float(r.uniform(a, b))
out, start, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
size = int(sys.argv[4]) if len(sys.argv) > 4 else 512
os.makedirs(out, exist_ok=True)
t0 = time.time()
with open(os.path.join(out, f'meta_{start}.jsonl'), 'a') as mf:
    for i in range(start, start + count):
        if os.path.exists(os.path.join(out, f'{i:06d}_lab.png')):
            continue
        rng = np.random.default_rng(1000003 * i + 17)
        tool = render.Tool(rng)
        r = rng.random()
        mode = 'none' if r < .12 else 'flank' if r < .7 else 'mixed'
        render.plan_wear(tool, rng, mode)
        if mode != 'none':
            base = math.exp(U(rng, math.log(.1), math.log(.5)))
            W = tool.wear
            for j in range(tool.k):
                if W['vb'][j] > 0:
                    W['vb'][j] = base * U(rng, .6, 1.3)
                    W['vbEnd'][j] = W['vb'][j] * U(rng, .3, 1.1) if W['vbEnd'][j] > 0 else 0
            W['ap'] = max(W['ap'], U(rng, .3, .8) * tool.D)
        ppm = math.exp(U(rng, math.log(9), math.log(30)))
        ppm = min(max(ppm * tool.D, 80), 300) / tool.D
        view = 'side' if rng.random() < .92 else 'top'
        fixed = dict(elev=U(rng, -8, 15), tipFrac=U(rng, .08, .3)) if view == 'side' else None
        rgb, lab, a, meta = render.render(rng, size, size, view=view, ppm=ppm, mode='keep', tool=tool, fixed=fixed)
        if (lab > 0).mean() < .02:
            continue
        g = (np.clip(rgb, 0, 1) ** (1 / 2.2) * 255 + .5).astype(np.uint8)[..., ::-1]
        rgba = np.concatenate([g, (a * 255 + .5).astype(np.uint8)[..., None]], -1)
        cv2.imwrite(os.path.join(out, f'{i:06d}_rgba.png'), rgba)
        cv2.imwrite(os.path.join(out, f'{i:06d}_lab.png'), lab)
        meta['id'] = i
        meta['mode'] = mode
        mf.write(json.dumps(meta) + '\n'); mf.flush()
        if i % 50 == 0:
            print(i, f'{(time.time() - t0) / (i - start + 1):.2f}s/img', flush=True)
