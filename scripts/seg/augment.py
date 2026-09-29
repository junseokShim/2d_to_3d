"""Turn a rendered tool (RGBA + label) into a phone-photo-like training sample.

compose(rng, rgba, lab, out) -> (img uint8 HxWx3 RGB, lab uint8 HxW)
  1. geometry: random scale / rotation / flip / translation into an out x out frame (tool diameter 60 .. 460 px)
  2. background: gradients, cloth / paper / wood / cutting-mat textures, bokeh blobs, desk edge
  3. occluders: fingers (skin capsules with nails) over the shank or around the tip; labelled background
  4. lighting: shadow, colour cast, exposure (incl. low light), vignetting, glare / veiling haze
  5. camera: low source resolution (4 .. 60 px/mm -> resample), defocus + motion blur, perspective,
     sensor noise (shot + read + chroma), ISP denoise + sharpening halos, JPEG
"""
import math
import numpy as np
import cv2

LIN = ((np.arange(256, dtype=np.float32) / 255) ** 2.2).astype(np.float32)
_GRID = {}


def mgrid(h, w):
    if (h, w) not in _GRID:
        _GRID[(h, w)] = np.mgrid[0:h, 0:w].astype(np.float32)
    return _GRID[(h, w)]


def U(rng, a, b):
    return a + (b - a) * rng.random()


def _lowfreq(rng, h, w, cells, ch=1):
    n = rng.random((max(2, h // cells), max(2, w // cells), ch)).astype(np.float32)
    return cv2.resize(n, (w, h), interpolation=cv2.INTER_CUBIC).reshape(h, w, ch)


def background(rng, h, w):
    kind = rng.choice(['grad', 'cloth', 'wood', 'mat', 'bokeh', 'dark', 'paper', 'desk'], p=[.14, .14, .1, .08, .18, .18, .08, .1])
    base = np.array([U(rng, .05, .9)] * 3, np.float32) * np.array([U(rng, .8, 1.2), U(rng, .85, 1.15), U(rng, .8, 1.25)], np.float32)
    if kind == 'dark':
        base = base * U(rng, .08, .4)
    img = np.ones((h, w, 3), np.float32) * base
    yy, xx = mgrid(h, w)
    a = U(rng, 0, 2 * math.pi)
    g = (np.cos(a) * xx + np.sin(a) * yy) / max(h, w)
    img *= (1 + U(rng, -.6, .6) * (g - g.mean()))[..., None]
    img *= (.75 + .5 * _lowfreq(rng, h, w, int(U(rng, 40, 200)), 1))
    if kind == 'cloth':
        t = cv2.randn(np.empty((h, w), np.float32), 0, 1)
        t = cv2.GaussianBlur(t, (0, 0), U(rng, .6, 1.5))
        img *= (1 + U(rng, .05, .2) * t)[..., None]
        f = U(rng, .3, 1.2)
        img *= (1 + .06 * np.sin(xx * f) * np.sin(yy * f))[..., None]
    elif kind == 'wood':
        n = _lowfreq(rng, h, w, 30, 1)[..., 0]
        ph = (yy if rng.random() < .5 else xx) / U(rng, 6, 25) + 6 * n
        img *= (1 + U(rng, .08, .3) * np.sin(ph))[..., None]
        img *= np.array([1.15, .95, .7], np.float32)
    elif kind == 'mat':
        img *= np.array([U(rng, .3, .8), U(rng, .6, 1.2), U(rng, .4, .9)], np.float32)
        s = U(rng, 20, 70)
        grid = ((np.mod(xx, s) < 1.5) | (np.mod(yy, s) < 1.5)).astype(np.float32)
        img = img * (1 - .3 * grid[..., None]) + .3 * grid[..., None] * U(rng, .5, 1)
    elif kind == 'bokeh':
        for _ in range(int(rng.integers(3, 25))):
            c = rng.random(3).astype(np.float32) * U(rng, .2, 1.2)
            cv2.circle(img, (int(rng.integers(w)), int(rng.integers(h))), int(U(rng, 10, max(h, w) / 3)), c.tolist(), -1)
        img = cv2.GaussianBlur(img, (0, 0), U(rng, 8, 30))
    elif kind == 'paper':
        img = img * .3 + .7 * U(rng, .6, 1)
        img *= (1 + .03 * rng.normal(0, 1, (h, w, 1)).astype(np.float32))
    elif kind == 'desk':
        e = int(U(rng, .2, .8) * h)
        img[e:] *= U(rng, .3, 1.8)
        img = cv2.GaussianBlur(img, (0, 0), U(rng, 1, 6))
    if rng.random() < .5:
        img = cv2.GaussianBlur(img, (0, 0), U(rng, 1, 12))   # out of focus
    return np.clip(img, 0, 1.5)


def finger_layer(rng, h, w, tool_mask, tip_xy, axis_dir, dpx, view):
    """skin-coloured fingers (RGB, alpha) holding the tool: over the shank (side) or around the tip (top)"""
    skin = np.array([U(rng, .75, 1.0), U(rng, .55, .78), U(rng, .42, .62)], np.float32) * U(rng, .5, 1.1)
    col = np.zeros((h, w, 3), np.float32)
    al = np.zeros((h, w), np.float32)
    n = int(rng.integers(1, 4))
    tx, ty = tip_xy
    ax, ay = axis_dir
    for i in range(n):
        if view == 'side':
            s = U(rng, 1.2, 4.5) * dpx                       # along the axis from the tip, below the wear zone
            side = rng.choice([-1, 1])
            cx = tx + ax * s + (-ay) * side * U(rng, .3, 1.2) * dpx
            cy = ty + ay * s + (ax) * side * U(rng, .3, 1.2) * dpx
        else:
            ang = U(rng, 0, 2 * math.pi)
            r = U(rng, .7, 1.4) * dpx
            cx, cy = tx + r * math.cos(ang), ty + r * math.sin(ang)
        L = U(rng, 1.5, 4) * dpx
        W = U(rng, .7, 1.3) * dpx
        a = U(rng, 0, 180)
        m = np.zeros((h, w), np.uint8)
        box = ((float(cx), float(cy)), (float(L), float(W)), float(a))
        cv2.ellipse(m, box, 255, -1)
        mf = m.astype(np.float32) / 255
        # shading across the finger
        d = cv2.distanceTransform(m, cv2.DIST_L2, 5)
        sh = np.clip(d / (W / 2 + 1e-6), 0, 1) ** .5
        c = skin * (.55 + .45 * sh)[..., None] * (1 + .05 * _lowfreq(rng, h, w, 20, 1) - .025)
        col = col * (1 - mf[..., None]) + c * mf[..., None]
        al = np.maximum(al, mf)
    al = cv2.GaussianBlur(al, (0, 0), U(rng, .6, 2))
    return col, al


def perspective(rng, h, w, strength):
    d = strength * min(h, w)
    src = np.float32([[0, 0], [w, 0], [w, h], [0, h]])
    dst = src + rng.uniform(-d, d, (4, 2)).astype(np.float32)
    return cv2.getPerspectiveTransform(src, dst)


def overlay_marks(rng, im8):
    """UI marks some photos carry (screenshots of the app: yellow / olive dashed guide lines, dots). Drawn on the
    uint8 RGB image; the label keeps whatever lies under them."""
    h, w = im8.shape[:2]
    im = im8.copy()
    for _ in range(int(rng.integers(1, 6))):
        col = (int(U(rng, 150, 255)), int(U(rng, 140, 230)), int(U(rng, 0, 90)))      # yellow .. olive
        t = int(rng.integers(1, 4))
        vert = rng.random() < .6
        c0 = int(rng.integers(w if vert else h))
        a, b = sorted(rng.integers(0, h if vert else w, 2))
        dash, gap = int(U(rng, 3, 14)), int(U(rng, 3, 12))
        if rng.random() < .3:
            dash = t                                                                    # dotted
        for q in range(int(a), int(b), dash + gap):
            p0, p1 = (c0, q), (c0, min(int(b), q + dash))
            if not vert:
                p0, p1 = p0[::-1], p1[::-1]
            cv2.line(im, p0, p1, col, t)
    al = U(rng, .5, 1)
    return (al * im + (1 - al) * im8).astype(np.uint8)


def compose(rng, rgba, lab, out=384, meta=None, strength=1.0):
    h0, w0 = lab.shape
    rgb = rgba[..., :3]                                    # BGR uint8, gamma encoded; linearised after the warp
    a = rgba[..., 3]
    # ---- geometry: similarity transform into the output frame ----
    ys, xs = np.nonzero(lab > 0)
    Dpx = meta['D'] * meta['ppm'] if meta else 200
    target = math.exp(U(rng, math.log(60), math.log(460))) if rng.random() < .45 else U(rng, 150, 400)
    s = target / Dpx
    view = meta['view'] if meta else 'side'
    if view == 'side':
        rot = U(rng, -18, 18) if rng.random() < .8 else U(rng, -180, 180)
    else:
        rot = U(rng, -180, 180)
    # keep the tip area in view: anchor on a random tool pixel, preferring wear / near-tip pixels
    wear = np.nonzero(lab.ravel() >= 2)[0]
    if len(wear) and rng.random() < .7:
        k = wear[rng.integers(len(wear))]
        py, px = divmod(int(k), w0)
    else:
        j = rng.integers(len(xs))
        px, py = xs[j], ys[j]
    M = cv2.getRotationMatrix2D((float(px), float(py)), rot, s)
    M[0, 2] += out / 2 - px + U(rng, -.35, .35) * out
    M[1, 2] += out / 2 - py + U(rng, -.35, .35) * out
    if rng.random() < .5:
        M = np.array([[-1, 0, out], [0, 1, 0]], np.float64) @ np.vstack([M, [0, 0, 1]])
    interp = cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR
    rgb_t = LIN[cv2.warpAffine(rgb, M, (out, out), flags=interp, borderValue=0)][..., ::-1]
    rgb_t = rgb_t * np.array([U(rng, .85, 1.15), U(rng, .9, 1.1), U(rng, .85, 1.15)], np.float32)   # tint of the tool itself
    a_t = cv2.warpAffine(a, M, (out, out), flags=interp, borderValue=0).astype(np.float32) / 255
    lab_t = cv2.warpAffine(lab, M, (out, out), flags=cv2.INTER_NEAREST, borderValue=0)
    # tip / axis in output space (approx: topmost tool pixel, axis = image down rotated)
    tip = M @ np.array([xs.mean(), ys.min(), 1.0])
    ang = math.radians(rot)
    axis = (math.sin(-ang) * np.sign(M[0, 0] if M[0, 0] != 0 else 1), math.cos(ang))
    dpx = Dpx * s
    # ---- background + composite ----
    bg = background(rng, out, out)
    # contact shadow of the tool on the background
    if rng.random() < .5:
        sh = cv2.GaussianBlur(a_t, (0, 0), U(rng, 3, 20))
        sh = np.roll(sh, (int(U(rng, -15, 15)), int(U(rng, -15, 15))), (0, 1))
        bg *= (1 - U(rng, .2, .6) * sh)[..., None]
    img = rgb_t * a_t[..., None] + bg * (1 - a_t[..., None])
    labo = lab_t.copy()
    # ---- fingers ----
    if rng.random() < .55 * strength:
        fc, fa = finger_layer(rng, out, out, a_t, tip, axis, dpx, view)
        img = img * (1 - fa[..., None]) + fc * fa[..., None]
        labo[fa > .5] = 0
    # ---- lighting ----
    img *= np.array([U(rng, .75, 1.25), U(rng, .85, 1.15), U(rng, .7, 1.3)], np.float32)   # white balance / colour cast
    yy, xx = mgrid(out, out)
    if rng.random() < .5:                                                                 # uneven light
        a2 = U(rng, 0, 2 * math.pi)
        g = (np.cos(a2) * xx + np.sin(a2) * yy) / out
        img *= (1 + U(rng, -.5, .5) * (g - .5))[..., None]
    if rng.random() < .4:                                                                 # vignetting
        r2 = ((xx - out / 2 + U(rng, -80, 80)) ** 2 + (yy - out / 2 + U(rng, -80, 80)) ** 2) / (out * out / 2)
        img *= (1 - U(rng, .1, .6) * r2)[..., None].clip(0, 1)
    if rng.random() < .25 * strength:                                                     # glare spots / streaks
        for _ in range(int(rng.integers(1, 4))):
            gm = np.zeros((out, out), np.float32)
            c = (int(rng.integers(out)), int(rng.integers(out)))
            if rng.random() < .5:
                cv2.circle(gm, c, int(U(rng, 3, 40)), 1, -1)
            else:
                cv2.line(gm, c, (int(rng.integers(out)), int(rng.integers(out))), 1, int(U(rng, 2, 12)))
            gm = cv2.GaussianBlur(gm, (0, 0), U(rng, 2, 25))
            img += U(rng, .3, 2.0) * gm[..., None]
    if rng.random() < .2 * strength:                                                      # veiling haze
        img = img * U(rng, .6, .9) + U(rng, .05, .3)
    expo = math.exp(U(rng, math.log(.12), math.log(1.8))) if rng.random() < .35 * strength else U(rng, .7, 1.3)
    img = img * expo
    # ---- low source resolution (emulate 4 .. 60 px/mm): down then up ----
    if rng.random() < .6 * strength:
        f = U(rng, .15, .9) if rng.random() < .7 else U(rng, .08, .2)
        small = cv2.resize(img, (max(8, int(out * f)), max(8, int(out * f))), interpolation=cv2.INTER_AREA)
        img = cv2.resize(small, (out, out), interpolation=rng.choice([cv2.INTER_LINEAR, cv2.INTER_CUBIC]))
    # ---- blur ----
    if rng.random() < .5 * strength:
        img = cv2.GaussianBlur(img, (0, 0), U(rng, .4, 2.5))
    if rng.random() < .15 * strength:
        L = int(U(rng, 3, 15))
        k = np.zeros((L, L), np.float32)
        a3 = U(rng, 0, math.pi)
        cv2.line(k, (int(L / 2 - L / 2 * math.cos(a3)), int(L / 2 - L / 2 * math.sin(a3))), (int(L / 2 + L / 2 * math.cos(a3)), int(L / 2 + L / 2 * math.sin(a3))), 1, 1)
        img = cv2.filter2D(img, -1, k / max(k.sum(), 1))
    # ---- perspective (image + label) ----
    if rng.random() < .5:
        Mp = perspective(rng, out, out, U(rng, .02, .12))
        img = cv2.warpPerspective(img, Mp, (out, out), borderMode=cv2.BORDER_REFLECT)
        labo = cv2.warpPerspective(labo, Mp, (out, out), flags=cv2.INTER_NEAREST, borderMode=cv2.BORDER_REFLECT)
    # ---- sensor: gamma encode + noise (shot/read in linear, stronger when dark) ----
    img = np.clip(img, 0, 1)
    if rng.random() < .8:
        gain = 1 / max(expo, .12)
        shot = U(rng, .0005, .006) * gain
        read = U(rng, .0005, .01) * gain
        noise = cv2.randn(np.empty(img.shape, np.float32), 0, 1) * np.sqrt(shot * img + read ** 2)
        if rng.random() < .5:
            noise = cv2.GaussianBlur(noise, (0, 0), U(rng, .5, 1.2)) * 1.6            # correlated (demosaic)
        img = np.clip(img + noise, 0, 1)
        if expo < .5 and rng.random() < .7:                                               # phone brightens dark shots
            img = np.clip(img * U(rng, 1.5, 1 / max(expo, .2)), 0, 1)
    img = img ** (1 / U(rng, 1.9, 2.5))
    im8 = (img * 255 + .5).astype(np.uint8)
    # ---- ISP: denoise / sharpen ----
    if rng.random() < .3:
        im8 = cv2.bilateralFilter(im8, 5, U(rng, 10, 40), 5)
    if rng.random() < .4:
        bl = cv2.GaussianBlur(im8, (0, 0), U(rng, 1, 3))
        im8 = cv2.addWeighted(im8, 1 + U(rng, .3, 1.5), bl, -U(rng, .3, 1.5), 0)
    if rng.random() < .15:
        im8 = overlay_marks(rng, im8)
    # ---- JPEG ----
    if rng.random() < .75:
        q = int(U(rng, 25, 95))
        ok, buf = cv2.imencode('.jpg', im8[..., ::-1], [cv2.IMWRITE_JPEG_QUALITY, q])
        im8 = cv2.imdecode(buf, cv2.IMREAD_COLOR)[..., ::-1]
    return np.ascontiguousarray(im8), labo
