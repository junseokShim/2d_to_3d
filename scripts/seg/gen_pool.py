"""Render a pool of synthetic tool images (RGBA + label) for training; compositing and photo degradation happen
on the fly in train.py.  usage: gen_pool.py OUT START COUNT [SIZE]"""
import sys, os, json, time
import numpy as np, cv2
sys.path.insert(0, os.path.dirname(__file__))
import render

out, start, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
size = int(sys.argv[4]) if len(sys.argv) > 4 else 512
os.makedirs(out, exist_ok=True)
t0 = time.time()
with open(os.path.join(out, f'meta_{start}.jsonl'), 'a') as mf:
    for i in range(start, start + count):
        if os.path.exists(os.path.join(out, f'{i:06d}_lab.png')):
            continue
        rng = np.random.default_rng(1000003 * i + 17)
        rgb, lab, a, meta = render.render(rng, size, size)
        if (lab > 0).mean() < .02:
            continue
        g = (np.clip(rgb, 0, 1) ** (1 / 2.2) * 255 + .5).astype(np.uint8)[..., ::-1]
        rgba = np.concatenate([g, (a * 255 + .5).astype(np.uint8)[..., None]], -1)
        cv2.imwrite(os.path.join(out, f'{i:06d}_rgba.png'), rgba)
        cv2.imwrite(os.path.join(out, f'{i:06d}_lab.png'), lab)
        meta['id'] = i
        mf.write(json.dumps(meta) + '\n'); mf.flush()
        if i % 100 == 0:
            print(i, f'{(time.time() - t0) / (i - start + 1):.2f}s/img', flush=True)
