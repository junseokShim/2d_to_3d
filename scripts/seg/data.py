"""Light-weight sample producer (numpy + cv2 only; no torch in the worker processes, which keeps Windows' commit
charge low).  Producer(n).batches(task_iter, bs) yields (uint8 images [B,H,W,3], uint8 labels [B,H,W])."""
import os, math, json, multiprocessing as mp
import numpy as np, cv2
import augment

DS_ROOT = 'C:/agent_research_team/datasets/toolwear'


def _init():
    cv2.setNumThreads(1)


def real_sample(rng, ip, mp_, size, strength=1.0):
    img = cv2.imread(ip, cv2.IMREAD_COLOR)[..., ::-1]
    lab = cv2.imread(mp_, cv2.IMREAD_UNCHANGED)
    if lab.ndim == 3:
        lab = lab[..., 0]
    h, w = lab.shape
    s = size / max(h, w) * math.exp(augment.U(rng, math.log(.8), math.log(2.5)))
    sel = lab > 1 if (lab > 1).any() else lab > 0 if (lab > 0).any() else None
    if sel is None:
        xs, ys = np.array([w // 2]), np.array([h // 2])
    else:
        ys, xs = np.nonzero(sel)
    j = rng.integers(len(xs))
    M = cv2.getRotationMatrix2D((float(xs[j]), float(ys[j])), augment.U(rng, -20, 20), s)
    M[0, 2] += size / 2 - xs[j] + augment.U(rng, -.3, .3) * size
    M[1, 2] += size / 2 - ys[j] + augment.U(rng, -.3, .3) * size
    im = cv2.warpAffine(np.ascontiguousarray(img), M, (size, size), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
    lb = cv2.warpAffine(lab, M, (size, size), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_REFLECT)
    if rng.random() < .5:
        im, lb = im[:, ::-1], lb[:, ::-1]
    f = im.astype(np.float32) / 255
    f = f * np.array([augment.U(rng, .8, 1.2), augment.U(rng, .9, 1.1), augment.U(rng, .8, 1.2)], np.float32) * augment.U(rng, .6, 1.3)
    if rng.random() < .4 * strength:
        f = cv2.GaussianBlur(f, (0, 0), augment.U(rng, .3, 1.5))
    if rng.random() < .4 * strength:
        f = f + rng.normal(0, augment.U(rng, .005, .04), f.shape).astype(np.float32)
    im = (np.clip(f, 0, 1) * 255).astype(np.uint8)
    if rng.random() < .5:
        ok, buf = cv2.imencode('.jpg', np.ascontiguousarray(im[..., ::-1]), [cv2.IMWRITE_JPEG_QUALITY, int(augment.U(rng, 35, 95))])
        im = cv2.imdecode(buf, cv2.IMREAD_COLOR)[..., ::-1]
    return np.ascontiguousarray(im), np.ascontiguousarray(lb)


def make(task):
    """task = ('synth', seed, pool, meta, size) | ('real', seed, image, mask, size)"""
    kind, seed = task[0], task[1]
    rng = np.random.default_rng(seed)
    try:
        if kind == 'real':
            return real_sample(rng, task[2], task[3], task[4])
        pool, meta, size = task[2], task[3], task[4]
        i = meta['id']
        rgba = cv2.imread(os.path.join(pool, f'{i:06d}_rgba.png'), cv2.IMREAD_UNCHANGED)
        lab = cv2.imread(os.path.join(pool, f'{i:06d}_lab.png'), cv2.IMREAD_UNCHANGED)
        return augment.compose(rng, rgba, lab, size, meta)
    except Exception as e:   # a bad file must not kill training
        print('sample error', task[:2], e, flush=True)
        s = task[-1]
        return np.zeros((s, s, 3), np.uint8), np.zeros((s, s), np.uint8)


class Producer:
    def __init__(self, n):
        self.pool = mp.get_context('spawn').Pool(n, initializer=_init)

    def batches(self, tasks, bs):
        buf = []
        for im, lb in self.pool.imap(make, tasks, chunksize=2):
            buf.append((im, lb))
            if len(buf) == bs:
                yield np.stack([b[0] for b in buf]), np.stack([b[1] for b in buf])
                buf = []
        if buf:
            yield np.stack([b[0] for b in buf]), np.stack([b[1] for b in buf])

    def close(self):
        self.pool.terminate()


def load_pool(pool):
    metas = {}
    for f in [os.path.join(pool, x) for x in os.listdir(pool) if x.startswith('meta_')]:
        for l in open(f):
            try:
                m = json.loads(l)
            except Exception:
                continue
            if os.path.exists(os.path.join(pool, f"{m['id']:06d}_lab.png")):
                metas[m['id']] = m
    return metas


def load_real(split, root=DS_ROOT):
    """labelled real images of the shared dataset for a split: [(image, mask, item)]"""
    mf = os.path.join(root, 'manifest.json')
    if not os.path.exists(mf):
        return []
    try:
        man = json.load(open(mf, encoding='utf8'))
    except Exception:
        return []
    items = man.get('items', man.get('images', [])) if isinstance(man, dict) else man
    out = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict) or it.get('split') != split or not it.get('mask'):
            continue
        ip, mp_ = os.path.join(root, it['image']), os.path.join(root, it['mask'])
        if os.path.exists(ip) and os.path.exists(mp_):
            out.append((ip, mp_, it))
    return out
