"""Samples for the microscope variant of the wear segmentation model (train_micro.py).

Sources: MUDESTREDA (manifest split 'train' only; T3 val, T10 test stay out) through data.real_sample, and the labelled
Keyence VHX images (reference/keyence, 3 unique views; twins are the same view and never split) with heavy augmentation:
scale around the app's inference scale (micro-core runs the whole image near native resolution), edge angle +-40 deg with
the tool on top (the app turns the image by quarter turns) or any angle (1 in 4: tool / background must be told apart in
any orientation for the app's auto rotation), mirror, colour (hue / saturation / gains / gamma / contrast), blur, noise,
sharpening, JPEG.
"""
import os, math, json
import numpy as np, cv2
import augment, data

DS = data.DS_ROOT
KD = os.path.join(DS, 'reference', 'keyence')
VIEWS = {'x100': ['151425', '151443'], 'x300': ['151743', '152008'], 'x300s': ['152822']}


def keyence_items(views):
    out = []
    for v in views:
        for i in VIEWS[v]:
            info = json.load(open(os.path.join(KD, 'labelinfo', f'keyence_{i}.json'), encoding='utf-8'))
            out.append((os.path.join(KD, 'images', f'keyence_{i}.png'), os.path.join(KD, 'masks', f'keyence_{i}.png'), v, info.get('edge', '')))
    return out


def mud_items(split):
    m = json.load(open(os.path.join(DS, 'manifest.json'), encoding='utf-8'))
    return [(os.path.join(DS, i['image']), os.path.join(DS, i['mask']), i['id']) for i in m['items'] if i['id'].startswith('mud_') and i['split'] == split]


_cache = {}


def _load(ip, mp_):
    if ip not in _cache:
        img = cv2.imread(ip, cv2.IMREAD_COLOR)[..., ::-1]
        lab = cv2.imread(mp_, cv2.IMREAD_UNCHANGED)
        if lab.ndim == 3:
            lab = lab[..., 0]
        # edge angle of the view (tool on top): robust line through the lowest tool row per column
        tool = (lab == 1) | (lab == 2) | (lab == 3)
        xs, ys = [], []
        for x in range(0, lab.shape[1], 8):
            r = np.nonzero(tool[:, x])[0]
            if len(r):
                xs.append(x); ys.append(r.max())
        b = np.polyfit(xs, ys, 1)[0] if len(xs) > 10 else 0.
        _cache[ip] = (img, lab, math.degrees(math.atan(b)))
    return _cache[ip]


def keyence_sample(rng, ip, mp_, size):
    img, lab, ang = _load(ip, mp_)
    h, w = lab.shape
    U = augment.U
    wear = (lab == 2) | (lab == 3)
    r = rng.random()
    if r < .6 and wear.any():
        ys, xs = np.nonzero(wear)
    elif r < .85:                                       # along the edge (tool / background boundary, unworn parts too)
        t = (lab == 1).astype(np.uint8)
        e = cv2.dilate(t, np.ones((5, 5), np.uint8)) != cv2.erode(t, np.ones((5, 5), np.uint8))
        ys, xs = np.nonzero(e & (lab != 255))
    else:
        ys, xs = np.array([rng.integers(h)]), np.array([rng.integers(w)])
    j = rng.integers(len(xs))
    s = math.exp(U(rng, math.log(.35), math.log(1.4)))  # app: native working resolution (scale 1)
    # rotation (cv2: + = counter-clockwise): the view's edge (slope ang deg, y down) brought to +-40 deg, tool on top
    rot = ang + U(rng, -40, 40) if rng.random() < .75 else U(rng, 0, 360)
    M = cv2.getRotationMatrix2D((float(xs[j]), float(ys[j])), rot, s)
    M[0, 2] += size / 2 - xs[j] + U(rng, -.3, .3) * size
    M[1, 2] += size / 2 - ys[j] + U(rng, -.3, .3) * size
    im = cv2.warpAffine(np.ascontiguousarray(img), M, (size, size), flags=cv2.INTER_AREA if s < .7 else cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    lb = cv2.warpAffine(lab, M, (size, size), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_CONSTANT, borderValue=255)   # outside the image: unknown
    if rng.random() < .5:
        im, lb = im[:, ::-1], lb[:, ::-1]
    # colour: hue / saturation (the coating's interference colours vary with coating and lighting), gains, gamma, contrast
    hsv = cv2.cvtColor(np.ascontiguousarray(im), cv2.COLOR_RGB2HSV).astype(np.float32)
    hsv[..., 0] = (hsv[..., 0] + U(rng, -25, 25)) % 180
    hsv[..., 1] *= U(rng, 0, 1.6) if rng.random() < .8 else 0
    im = cv2.cvtColor(np.clip(hsv, 0, 255).astype(np.uint8), cv2.COLOR_HSV2RGB)
    f = im.astype(np.float32) / 255
    f = f * np.array([U(rng, .8, 1.2), U(rng, .9, 1.1), U(rng, .8, 1.2)], np.float32)
    f = np.clip(f, 0, 1) ** U(rng, .6, 1.6)
    m = f.mean()
    f = (f - m) * U(rng, .6, 1.4) + m * U(rng, .6, 1.3)
    if rng.random() < .4:
        f = cv2.GaussianBlur(f, (0, 0), U(rng, .4, 2.5))
    elif rng.random() < .3:                              # sharpening (VHX images are often processed)
        bl = cv2.GaussianBlur(f, (0, 0), 1.5)
        f = f + U(rng, .3, 1.2) * (f - bl)
    if rng.random() < .5:
        f = f + rng.normal(0, U(rng, .005, .04), f.shape).astype(np.float32)
    im = (np.clip(f, 0, 1) * 255).astype(np.uint8)
    if rng.random() < .4:
        ok, buf = cv2.imencode('.jpg', np.ascontiguousarray(im[..., ::-1]), [cv2.IMWRITE_JPEG_QUALITY, int(U(rng, 40, 95))])
        im = cv2.imdecode(buf, cv2.IMREAD_COLOR)[..., ::-1]
    return np.ascontiguousarray(im), np.ascontiguousarray(lb)


def make(task):
    """('keyence', seed, image, mask, size) | ('mud', seed, image, mask, size, ignore_tool)"""
    kind, seed = task[0], task[1]
    rng = np.random.default_rng(seed)
    try:
        if kind == 'keyence':
            return keyence_sample(rng, task[2], task[3], task[4])
        return data.real_sample(rng, task[2], task[3], task[4], ignore_tool=task[5])
    except Exception as e:
        print('sample error', task[:3], e, flush=True)
        s = task[4]
        return np.zeros((s, s, 3), np.uint8), np.zeros((s, s), np.uint8)


def _init():
    cv2.setNumThreads(1)


class Producer:
    def __init__(self, n):
        import multiprocessing as mp
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
