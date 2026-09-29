"""Render a pool of USB-microscope-like end-mill views (seg11): the human's 640x480 samples (datasets/human_samples)
show the tool filling the frame, tip at the top, 20-100 px/mm, lit by a coloured backlight / ring light that throws
long specular streaks down the helical flutes (TOOL, not wear), and broken tip corners with bright fracture facets.

Differences to gen_pool.py: side views near the tool's side (elev -6..14 deg), tip row 2-20 % from the top, tool
diameter 0.55-1.15 of the frame width, dark coatings, lights with narrow bright soft boxes (glossy streaks), corner
breakage (big chips on the corner) on ~45 % of tools; ~12 % end (top) views.  Compositing (backlight, tint, streaks,
facet glints, microscope optics) happens on the fly in augment.compose_micro.
Seeds 1000003 * i + 17 with i >= 4e6: disjoint from the main pool (0..), pool_thin (2e6..) and the test / val sets.
usage: gen_pool_micro.py OUT START COUNT [SIZE]"""
import sys, os, json, math, time
import numpy as np, cv2, torch
sys.path.insert(0, os.path.dirname(__file__))
import render

U = lambda r, a, b: float(r.uniform(a, b))
DARK = [((.12, .12, .14), 1.6), ((.18, .16, .2), 1.2), ((.1, .1, .12), 1.0), ((.28, .22, .32), .8), ((.08, .08, .09), .8),
        ((.3, .33, .38), .5), ((.55, .56, .58), .3)]


def micro_lights(rng):
    """1-2 weak key lights + 2-6 narrow, bright soft boxes (ring light / backlight seen in the polished lands)"""
    dirs = []
    for _ in range(int(rng.integers(1, 3))):
        v = torch.tensor([U(rng, -1, 1), U(rng, -1.2, .3), U(rng, -1, .6)])
        dirs.append((v / v.norm(), torch.tensor([1., 1, 1]) * U(rng, .2, .9)))
    boxes = []
    for _ in range(int(rng.integers(2, 7))):
        v = torch.tensor([U(rng, -1, 1), U(rng, -1.3, .6), U(rng, -1, 1)])
        boxes.append((v / v.norm(), U(rng, .06, .3), U(rng, 1, 4)))
    amb = U(rng, .03, .2)

    def env(r):
        e = torch.zeros(r.shape[0], 1, device=r.device) + U(rng, .02, .08)
        for (v, w, a) in boxes:
            d = (r * v.to(r.device)[None]).sum(-1)
            e = e + a * torch.exp(-(1 - d).clamp(min=0) / (w * w))[:, None]
        return e.expand(-1, 3)
    return dict(dirs=dirs, amb=amb, env=env, specTint=torch.tensor([1., 1, 1], device=render.DEV))


render.make_lights = micro_lights
render.COATS = DARK

out, start, count = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
size = int(sys.argv[4]) if len(sys.argv) > 4 else 512
os.makedirs(out, exist_ok=True)
t0 = time.time()
with open(os.path.join(out, f'meta_{start}.jsonl'), 'a') as mf:
    for i in range(start, start + count):
        if os.path.exists(os.path.join(out, f'{i:06d}_lab.png')):
            continue
        rng = np.random.default_rng(1000003 * i + 17)
        tool = render.Tool(rng, D=float(rng.choice([6, 8, 10, 10, 12, 12, 16])) * U(rng, .97, 1.03))
        r = rng.random()
        mode = 'none' if r < .15 else 'flank' if r < .4 else 'chip' if r < .7 else 'mixed'
        render.plan_wear(tool, rng, mode)
        R = tool.R
        if mode in ('chip', 'mixed') and rng.random() < .75 or mode == 'flank' and rng.random() < .2:
            # corner breakage like the human's D10 / D12: 0.3-2.5 mm deep chunks off 1-2 tip corners
            for _ in range(int(rng.integers(1, 3))):
                j = int(rng.integers(tool.k))
                th = tool.edgeTheta(j, 0.0) + U(rng, -.15, .1)
                s = U(rng, .08, .5) * R
                c = (R * math.cos(th), R * math.sin(th), U(rng, -.2, .3) * s)
                tool.chips.append((c, (s * U(rng, .7, 1.5), s * U(rng, .7, 1.5), s * U(rng, 1, 2.2))))
        view = 'side' if rng.random() < .88 else 'top'
        dpx = U(rng, .55, 1.15) * size
        ppm = dpx / tool.D
        if view == 'side':
            fixed = dict(elev=U(rng, -6, 14), tipFrac=U(rng, .02, .2), xo=U(rng, -.1, .1))
        else:
            ppm = U(rng, .35, .7) * size / tool.D
            fixed = dict(elev=U(rng, 82, 90))
        rgb, lab, a, meta = render.render(rng, size, size, view=view, ppm=ppm, mode='keep', tool=tool, fixed=fixed)
        if (lab > 0).mean() < .05:
            continue
        g = (np.clip(rgb, 0, 1) ** (1 / 2.2) * 255 + .5).astype(np.uint8)[..., ::-1]
        rgba = np.concatenate([g, (a * 255 + .5).astype(np.uint8)[..., None]], -1)
        cv2.imwrite(os.path.join(out, f'{i:06d}_rgba.png'), rgba)
        cv2.imwrite(os.path.join(out, f'{i:06d}_lab.png'), lab)
        meta['id'] = i
        meta['mode'] = mode
        meta['micro'] = 1
        mf.write(json.dumps(meta) + '\n'); mf.flush()
        if i % 50 == 0:
            print(i, f'{(time.time() - t0) / (i - start + 1):.2f}s/img', flush=True)
