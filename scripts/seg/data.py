"""Light-weight sample producer (numpy + cv2 only; no torch in the worker processes, which keeps Windows' commit
charge low).  Producer(n).batches(task_iter, bs) yields (uint8 images [B,H,W,3], uint8 labels [B,H,W])."""
import os, re, math, json, multiprocessing as mp
import numpy as np, cv2
import augment

DS_ROOT = 'C:/agent_research_team/datasets/toolwear'


def _init():
    cv2.setNumThreads(1)


def real_sample(rng, ip, mp_, size, strength=1.0, ignore_tool=False):
    img = cv2.imread(ip, cv2.IMREAD_COLOR)[..., ::-1]
    lab = cv2.imread(mp_, cv2.IMREAD_UNCHANGED)
    if lab.ndim == 3:
        lab = lab[..., 0]
    if ignore_tool:          # the source's tool surface does not look like an end mill in a photo: learn only its wear
        lab = np.where(lab == 1, 255, lab).astype(np.uint8)
    h, w = lab.shape
    s = size / max(h, w) * math.exp(augment.U(rng, math.log(.8), math.log(2.5)))
    fg = lab != 255
    rare = (lab == 3) | (lab == 4)
    if rare.any() and rng.random() < .5:                    # chipping/adhesion are rare: centre half of such crops on them
        sel = rare
    else:
        sel = (lab > 1) & fg if ((lab > 1) & fg).any() else (lab > 0) & fg if ((lab > 0) & fg).any() else None
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
    if rng.random() < .5 * strength:                        # low source resolution (phone at 4 .. 20 px/mm)
        r = augment.U(rng, .12, .7)
        small = cv2.resize(f, (max(8, int(size * r)), max(8, int(size * r))), interpolation=cv2.INTER_AREA)
        f = cv2.resize(small, (size, size), interpolation=cv2.INTER_LINEAR if rng.random() < .5 else cv2.INTER_CUBIC)
    f = f * np.array([augment.U(rng, .8, 1.2), augment.U(rng, .9, 1.1), augment.U(rng, .8, 1.2)], np.float32) * augment.U(rng, .6, 1.3)
    if rng.random() < .4 * strength:
        f = cv2.GaussianBlur(f, (0, 0), augment.U(rng, .3, 1.5))
    if rng.random() < .4 * strength:
        f = f + rng.normal(0, augment.U(rng, .005, .04), f.shape).astype(np.float32)
    im = (np.clip(f, 0, 1) * 255).astype(np.uint8)
    if rng.random() < .15:
        im = augment.overlay_marks(rng, np.ascontiguousarray(im))
    if rng.random() < .5:
        ok, buf = cv2.imencode('.jpg', np.ascontiguousarray(im[..., ::-1]), [cv2.IMWRITE_JPEG_QUALITY, int(augment.U(rng, 35, 95))])
        im = cv2.imdecode(buf, cv2.IMREAD_COLOR)[..., ::-1]
    return np.ascontiguousarray(im), np.ascontiguousarray(lb)


def make(task):
    """task = ('synth' | 'micro', seed, pool, meta, size[, win]) | ('real', seed, image, mask, size[, ignore_tool])
    'micro': a USB-microscope pool render composited on a coloured backlight (augment.compose_micro)"""
    kind, seed = task[0], task[1]
    rng = np.random.default_rng(seed)
    try:
        if kind == 'real':
            return real_sample(rng, task[2], task[3], task[4], ignore_tool=len(task) > 5 and task[5])
        pool, meta, size = task[2], task[3], task[4]
        win = len(task) > 5 and task[5]
        i = meta['id']
        rgba = cv2.imread(os.path.join(pool, f'{i:06d}_rgba.png'), cv2.IMREAD_UNCHANGED)
        lab = cv2.imread(os.path.join(pool, f'{i:06d}_lab.png'), cv2.IMREAD_UNCHANGED)
        if kind == 'micro':
            return augment.compose_micro(rng, rgba, lab, size, meta, win=win)
        return augment.compose(rng, rgba, lab, size, meta, win=win)
    except Exception as e:   # a bad file must not kill training
        print('sample error', task[:2], e, flush=True)
        s = task[4]
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


_MVAL = None


def _manifest_val(root=DS_ROOT):
    """ids the dataset manifest puts in 'val' (qit_w_: 7 held-out side views)"""
    global _MVAL
    if _MVAL is None:
        try:
            _MVAL = {x['id'] for x in json.load(open(os.path.join(root, 'manifest.json'), encoding='utf-8'))['items'] if x.get('split') == 'val'}
        except Exception:
            _MVAL = set()
    return _MVAL


def split_of(name):
    """processed/ file stem -> (source, split). syn_*: every 10th render is val; mud_*: tool T3 held out (val);
    target_*: the human's photos, eval only (never trained on)."""
    src = name.split('_', 1)[0]
    if name.startswith('qit_w_'):      # QIT-CEMC with wear labels (worker-hlabel2), kept apart from the tool-only qit_
        return 'qitw', 'val' if name in _manifest_val() else 'train'
    if src == 'target':
        return src, 'target'
    if src == 'mud':
        m = re.match(r'mud_(T\d+)', name)
        return src, 'val' if m and m.group(1) == 'T3' else 'train'
    if src == 'syn':
        d = re.findall(r'\d+', name)
        return src, 'val' if d and int(d[-1]) % 10 == 0 else 'train'
    return src, 'train'


def load_real(split, root=DS_ROOT, sources=None, exclude=None):
    """labelled images of the shared dataset (processed/{images,masks}/<source>_*.png) for a split:
    {source: [(image, mask, stem)]}; exclude: regex on the stem (leave-one-tool-out folds)"""
    out = {}
    d = os.path.join(root, 'processed')
    if not os.path.isdir(os.path.join(d, 'images')):
        return out
    for f in sorted(os.listdir(os.path.join(d, 'images'))):
        stem, ext = os.path.splitext(f)
        mp_ = os.path.join(d, 'masks', stem + '.png')
        if ext.lower() not in ('.png', '.jpg') or not os.path.exists(mp_):
            continue
        src, sp = split_of(stem)
        if sp != split or (sources and src not in sources) or (exclude and re.search(exclude, stem)):
            continue
        out.setdefault(src, []).append((os.path.join(d, 'images', f), mp_, stem))
    return out
