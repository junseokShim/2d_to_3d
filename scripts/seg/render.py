"""Synthetic end-mill photos with exact wear masks (GPU ray casting of a parametric tool).

Classes: 0 background, 1 tool, 2 flank wear (VB), 3 chipping / breakage, 4 adhesion / built-up edge.

Geometry (tool coordinates, mm): axis +z from the tip (z = 0) into the shank, radius R, k flutes, helix beta.
A point (rho, theta, z) is inside the tool when F > 0, F = min of
  * cross-section:  r(psi) - rho, psi = angle behind the nearest cutting edge (helix-twisted), r = margin / clearance / flute
  * end face:       z - zEnd(rho, psi)  (dish + end clearance rising behind each end cutting edge)
  * corner radius / chamfer
minus chip ellipsoids (breakage), plus adhesion blobs.  Wear is a label on the surface (and a flat worn land for
shading): peripheral flank land within VB(z) of the edge for z < ap, end flank land within VBe of the end edge.

render(params) -> (rgb float [H,W,3] 0..1, label uint8 [H,W], alpha float [H,W], meta)
"""
import math
import numpy as np
import torch

DEV = 'cuda' if torch.cuda.is_available() else 'cpu'
TAU = 2 * math.pi


def _rand(rng, a, b):
    return a + (b - a) * rng.random()


class Tool:
    def __init__(self, rng, D=None):
        self.D = D or float(rng.choice([4, 5, 6, 8, 10, 12, 16])) * _rand(rng, .97, 1.03)
        self.R = R = self.D / 2
        self.k = int(rng.choice([2, 3, 4, 4, 4, 5, 6]))
        self.P = TAU / self.k
        self.hand = 1 if rng.random() < .85 else -1
        self.beta = math.radians(rng.choice([15, 25, 30, 35, 38, 40, 45, 50]) + _rand(rng, -2, 2))
        self.phi0 = _rand(rng, 0, TAU)
        self.core = R * _rand(rng, .55, .72)
        self.margin = _rand(rng, .02, .10) * self.P                      # land at full radius
        self.clear = _rand(rng, .05, .2)                                  # radial drop (rel. R) over the clearance
        self.fStart = _rand(rng, .30, .45) * self.P                       # where the flute starts
        self.fPeak = _rand(rng, .45, .7)                                  # deepest point in the flute (fraction)
        self.fPow = _rand(rng, .45, .9)
        corner = rng.random()
        self.cornerR = 0 if corner < .35 else (R * _rand(rng, .04, .25) if corner < .85 else 0)
        self.chamfer = R * _rand(rng, .03, .12) if corner >= .85 else 0
        self.dish = math.radians(_rand(rng, 1, 4))
        self.endClear = math.radians(_rand(rng, 5, 14))
        self.gash = _rand(rng, .15, .35) * R                               # flute opens to the centre near the tip
        self.fluteLen = self.D * _rand(rng, 1.5, 3.5)
        self.chips = []       # (centre xyz, radii abc)   removed
        self.blobs = []       # (centre xyz, radius, bump seed)   added
        self.wear = None

    # angle behind the edge (0..P) of points at (theta, z)
    def psi(self, th, z):
        tw = self.hand * z * math.tan(self.beta) / self.R
        return torch.remainder(-(th - tw - self.phi0), self.P)

    def edgeTheta(self, i, z):
        return self.phi0 + i * self.P + self.hand * z * math.tan(self.beta) / self.R

    def radius(self, psi, z):
        R, P = self.R, self.P
        r = torch.full_like(psi, R)
        cl = (psi > self.margin) & (psi <= self.fStart)
        r = torch.where(cl, R - self.clear * R * (psi - self.margin) / (self.fStart - self.margin), r)
        t = ((psi - self.fStart) / (P - self.fStart)).clamp(0, 1)
        q = math.log(.5) / math.log(self.fPeak)
        B = torch.sin(math.pi * t.clamp(1e-6, 1) ** q).clamp(min=0) ** self.fPow
        r0 = R - self.clear * R
        rl = r0 + (R - r0) * t
        rf = rl - (rl - self.core) * B
        r = torch.where(psi > self.fStart, rf, r)
        # near the tip the flute is gashed towards the centre
        g = (z < self.gash * 1.2) & (psi > self.fStart)
        rg = torch.minimum(r, self.core * (z / (self.gash * 1.2)).clamp(0, 1) ** .5 + (r - self.core) * 0)
        r = torch.where(g & (B > .35), torch.minimum(r, torch.maximum(rg, torch.zeros_like(rg))), r)
        # shank beyond the flute length: plain cylinder (with a short run-out)
        s = ((z - self.fluteLen) / (.3 * self.R)).clamp(0, 1)
        return r + (R - r) * s

    def field(self, p, want_parts=False):
        x, y, z = p[..., 0], p[..., 1], p[..., 2]
        rho = torch.sqrt(x * x + y * y) + 1e-9
        th = torch.atan2(y, x)
        ps = self.psi(th, z)
        r = self.radius(ps, z)
        fSide = r - rho
        # end face: dish (rises towards the centre) + end clearance behind each end edge (only on the land, not in the flute)
        arcBehind = rho * ps.clamp(max=self.fStart)
        zEnd = (self.R - rho) * math.tan(self.dish) + arcBehind * math.tan(self.endClear)
        fEnd = z - zEnd
        f = torch.minimum(fSide, fEnd)
        if self.cornerR > 0:
            c = self.cornerR
            dz = (c - z).clamp(min=0)
            rmax = self.R - c + torch.sqrt((c * c - dz * dz).clamp(min=0))
            f = torch.minimum(f, torch.where(z < c, rmax - rho, torch.full_like(z, 1e3)))
        if self.chamfer > 0:
            f = torch.minimum(f, (z + (self.R - rho) - self.chamfer) / math.sqrt(2))
        part = torch.zeros_like(f, dtype=torch.uint8)
        for (c, ab) in self.chips:
            d = torch.sqrt(((x - c[0]) / ab[0]) ** 2 + ((y - c[1]) / ab[1]) ** 2 + ((z - c[2]) / ab[2]) ** 2)
            fc = (d - 1) * min(ab)
            if want_parts:
                part = torch.where((fc < f) & (fc < .02 * self.R), torch.full_like(part, 3), part)
            f = torch.minimum(f, fc)
        for (c, rad, sd) in self.blobs:
            dx, dy, dz_ = x - c[0], y - c[1], z - c[2]
            d = torch.sqrt(dx * dx + dy * dy + dz_ * dz_)
            bump = 1 + .25 * torch.sin(sd[0] * dx / rad + sd[1]) * torch.sin(sd[2] * dy / rad + sd[3]) * torch.sin(sd[4] * dz_ / rad + sd[5])
            fb = rad * bump - d
            if want_parts:
                part = torch.where(fb > f - .01 * rad, torch.full_like(part, 4), part)
            f = torch.maximum(f, fb)
        if want_parts:
            return f, part, dict(rho=rho, th=th, psi=ps, z=z, fSide=fSide, fEnd=fEnd)
        return f


def _noise2(u, v, seed, freqs=(1, 2, 4, 8), amps=(1, .5, .25, .12)):
    """cheap smooth 2D value noise via random sinusoids (torch)"""
    g = torch.Generator(device='cpu').manual_seed(int(seed) % (2 ** 31))
    out = torch.zeros_like(u)
    for f, a in zip(freqs, amps):
        for _ in range(3):
            ang = torch.rand(1, generator=g).item() * TAU
            ph = torch.rand(1, generator=g).item() * TAU
            out = out + a * torch.sin(f * (u * math.cos(ang) + v * math.sin(ang)) + ph)
    return out / 3


def plan_wear(tool, rng, mode):
    """mode: 'none' | 'flank' | 'mixed' ... sets tool.wear, tool.chips, tool.blobs"""
    R, k = tool.R, tool.k
    W = dict(ap=0, vb=np.zeros(k), vbEnd=np.zeros(k), notch=[], cornerBoost=np.zeros(k), seed=rng.integers(1e9))
    if mode == 'none':
        tool.wear = W
        return
    W['ap'] = tool.D * _rand(rng, .15, 1.6)                 # axial depth of cut worn
    worn = rng.random(k) < _rand(rng, .5, 1.0)
    if not worn.any():
        worn[rng.integers(k)] = True
    base = math.exp(_rand(rng, math.log(.04), math.log(.7)))  # VB mm (0.04 .. 0.7)
    for i in range(k):
        if worn[i]:
            W['vb'][i] = base * _rand(rng, .5, 1.3)
            W['vbEnd'][i] = base * _rand(rng, .3, 1.2) if rng.random() < .8 else 0
            W['cornerBoost'][i] = _rand(rng, 1, 2.5) if rng.random() < .6 else 1
    tool.wear = W
    # chipping: small chips along the peripheral edge, or corner breakage
    if mode in ('mixed', 'chip') and rng.random() < (.9 if mode == 'chip' else .45):
        for _ in range(int(rng.integers(1, 5))):
            i = int(rng.integers(k))
            corner = rng.random() < .45
            z = _rand(rng, 0, .15 * R) if corner else _rand(rng, .05, 1.0) * max(W['ap'], .5 * R)
            th = tool.edgeTheta(i, z) - tool.hand * 0      # on the edge
            s = (_rand(rng, .1, .9) if corner else _rand(rng, .05, .45)) * min(1, R / 3) * _rand(rng, .6, 1.6)
            rr = R if not corner else R * _rand(rng, .85, 1)
            c = (rr * math.cos(th), rr * math.sin(th), z if not corner else z * .3)
            tool.chips.append((c, (s * _rand(rng, .6, 1.4), s * _rand(rng, .6, 1.4), s * _rand(rng, .7, 1.8))))
    if mode in ('mixed', 'bue') and rng.random() < (.9 if mode == 'bue' else .35):
        for _ in range(int(rng.integers(1, 4))):
            i = int(rng.integers(k))
            z = _rand(rng, 0, max(W['ap'], .4 * R))
            th = tool.edgeTheta(i, z) + tool.hand * 0 - _rand(rng, 0, .12)  # slightly on the rake side
            rad = _rand(rng, .04, .35) * min(1, R / 3)
            rr = R - rad * _rand(rng, .1, .6)
            c = (rr * math.cos(th), rr * math.sin(th), max(z, rad * .2))
            tool.blobs.append((c, rad, [_rand(rng, 2, 7), _rand(rng, 0, 6), _rand(rng, 2, 7), _rand(rng, 0, 6), _rand(rng, 2, 7), _rand(rng, 0, 6)]))


def wear_label(tool, q):
    """surface points -> (flank wear mask, which edge) ; q = dict from field(want_parts)"""
    W = tool.wear
    if W is None or W['ap'] <= 0:
        return torch.zeros_like(q['z'], dtype=torch.bool), None
    R, P = tool.R, tool.P
    z, rho, ps, th = q['z'], q['rho'], q['psi'], q['th']
    # which edge is this point behind
    tw = tool.hand * z * math.tan(tool.beta) / R
    idx = torch.floor(-(th - tw - tool.phi0) / P).long() % tool.k
    vb = torch.tensor(W['vb'], device=z.device, dtype=z.dtype)[idx]
    vbe = torch.tensor(W['vbEnd'], device=z.device, dtype=z.dtype)[idx]
    cb = torch.tensor(W['cornerBoost'], device=z.device, dtype=z.dtype)[idx]
    ap = W['ap']
    n = _noise2(z * 6, idx.float() * 3.1, W['seed'], freqs=(1, 3, 9), amps=(1, .5, .3))
    # VB(z): larger at the corner, ragged, tapering out at ap
    prof = vb * (1 + .25 * n) * (1 + (cb - 1) * torch.exp(-z / (.12 * R))) * (1 - torch.sigmoid((z - ap) / (.04 * R + .02)))
    arc = R * ps                                   # distance behind the edge along the circumference (mm)
    onPeriph = (q['fSide'].abs() < .03 * R + .01) & (ps < tool.fStart) & (rho > R * (1 - tool.clear) - .02)
    periph = onPeriph & (arc * math.cos(tool.beta) < prof)
    # end flank: on the end face behind each end cutting edge
    onEnd = (q['fEnd'].abs() < .03 * R + .01) & (ps < tool.fStart)
    ne = _noise2(rho * 8, idx.float() * 2.3, W['seed'] + 7, freqs=(1, 3, 9), amps=(1, .5, .3))
    vbE = vbe * (1 + .3 * ne) * (rho / R).clamp(.2, 1) ** .5 * (1 + (cb - 1) * torch.exp(-(R - rho) / (.12 * R)))
    end = onEnd & (rho * ps < vbE) & (rho > .15 * R)
    # corner (radius / chamfer faces): treat like both
    corner = (~onPeriph) & (~onEnd) & (z < max(tool.cornerR, tool.chamfer) + .05 * R) & (ps < tool.fStart) & (R * ps < prof * 1.2)
    return periph | end | corner, idx


# ---------------- camera + ray march ----------------

def _cam(elev, roll=0.0):
    e = math.radians(elev)
    Dv = torch.tensor([0, math.cos(e), math.sin(e)], dtype=torch.float32)   # view direction (camera on the -y / tip side)
    U = torch.tensor([0, math.sin(e), -math.cos(e)], dtype=torch.float32)   # image up = towards the tip
    Rv = torch.linalg.cross(U, Dv)
    return Dv, U, Rv


@torch.no_grad()
def raycast(tool, elev, H, W, ppm, centre, zmax, steps=128, chunk=1 << 20):
    """orthographic camera; centre = tool point (mm) at the image centre; ppm = pixels per mm.
    returns hit mask, points, normals, parts (all [H*W])"""
    Dv, U, Rv = [t.to(DEV) for t in _cam(elev)]
    ys, xs = torch.meshgrid(torch.arange(H, device=DEV, dtype=torch.float32), torch.arange(W, device=DEV, dtype=torch.float32), indexing='ij')
    u = (xs.flatten() + .5 - W / 2) / ppm
    v = -(ys.flatten() + .5 - H / 2) / ppm
    c = torch.tensor(centre, device=DEV, dtype=torch.float32)
    O = c[None] + u[:, None] * Rv[None] + v[:, None] * U[None]
    Rb = tool.R * 1.03 + .45
    # t-range: bounding cylinder rho <= Rb, z in [-Rb, zmax]
    T = 4 * (Rb + zmax)
    O = O - Dv[None] * T / 2
    N = O.shape[0]
    hit = torch.zeros(N, dtype=torch.bool, device=DEV)
    P = torch.zeros(N, 3, device=DEV)
    for s0 in range(0, N, chunk):
        o = O[s0:s0 + chunk]
        # analytic interval with the bounding cylinder (x^2 + y^2 <= Rb^2)
        a = Dv[0] ** 2 + Dv[1] ** 2
        b = 2 * (o[:, 0] * Dv[0] + o[:, 1] * Dv[1])
        cc = o[:, 0] ** 2 + o[:, 1] ** 2 - Rb * Rb
        if a > 1e-6:
            disc = b * b - 4 * a * cc
            ok = disc > 0
            sq = torch.sqrt(disc.clamp(min=0))
            t0 = (-b - sq) / (2 * a)
            t1 = (-b + sq) / (2 * a)
        else:
            ok = cc < 0
            t0 = torch.zeros_like(cc)
            t1 = torch.full_like(cc, T)
        # z slab
        if abs(Dv[2]) > 1e-6:
            za = (-Rb - o[:, 2]) / Dv[2]
            zb = (zmax - o[:, 2]) / Dv[2]
            t0 = torch.maximum(t0, torch.minimum(za, zb))
            t1 = torch.minimum(t1, torch.maximum(za, zb))
        else:
            ok = ok & (o[:, 2] > -Rb) & (o[:, 2] < zmax)
        ok = ok & (t1 > t0)
        idx = torch.nonzero(ok).flatten()
        if idx.numel() == 0:
            continue
        oo, a0, a1 = o[idx], t0[idx], t1[idx]
        found = torch.zeros(idx.numel(), dtype=torch.bool, device=DEV)
        tl = a0.clone()
        th_ = a1.clone()
        act = torch.arange(idx.numel(), device=DEV)       # rays still marching (compacted every 8 steps)
        for i in range(1, steps + 1):
            t = a0[act] + (a1[act] - a0[act]) * i / steps
            f = tool.field(oo[act] + t[:, None] * Dv[None])
            new = (f > 0) & ~found[act]
            th_[act] = torch.where(new, t, th_[act])
            tl[act] = torch.where(new, a0[act] + (a1[act] - a0[act]) * (i - 1) / steps, tl[act])
            found[act] = found[act] | new
            if i % 8 == 0:
                act = act[~found[act]]
                if act.numel() == 0:
                    break
        # bisection
        for _ in range(10):
            m = (tl + th_) / 2
            f = tool.field(oo + m[:, None] * Dv[None])
            th_ = torch.where(f > 0, m, th_)
            tl = torch.where(f > 0, tl, m)
        gi = idx[found]
        hit[s0 + gi] = True
        P[s0 + gi] = oo[found] + th_[found][:, None] * Dv[None]
    return hit, P, Dv, (u, v)


def normals(tool, p, eps=None):
    eps = eps or tool.R * 2e-3
    e = torch.eye(3, device=p.device) * eps
    g = torch.stack([tool.field(p + e[i]) - tool.field(p - e[i]) for i in range(3)], -1)
    return -g / (g.norm(dim=-1, keepdim=True) + 1e-12)     # F > 0 inside -> outward normal = -grad


COATS = [((.12, .12, .14), 1.6), ((.18, .16, .2), 1.2), ((.1, .1, .12), 1.0), ((.28, .22, .32), .6), ((.62, .48, .2), .5), ((.42, .34, .3), .5),
         ((.55, .56, .58), .7), ((.3, .33, .38), .6), ((.08, .08, .09), .6), ((.45, .45, .5), .5)]


def shade(tool, rng, p, n, Dv, parts, wear, H, W, hitmask, lights):
    """returns rgb for hit points"""
    x, y, z = p[:, 0], p[:, 1], p[:, 2]
    base, w = COATS[rng.choice(len(COATS), p=np.array([c[1] for c in COATS]) / sum(c[1] for c in COATS))]
    coat = torch.tensor(base, device=DEV) * _rand(rng, .75, 1.3)
    carb = torch.tensor([_rand(rng, .45, .8)] * 3, device=DEV) * torch.tensor([_rand(rng, .95, 1.05), 1, _rand(rng, .95, 1.08)], device=DEV)
    # wear appearance: exposed carbide, mostly brighter than the coat; sometimes oxidised / dark / low contrast
    wr = rng.random()
    if wr < .6:
        wcol = carb * _rand(rng, .8, 1.3)
    elif wr < .75:
        wcol = torch.tensor([_rand(rng, .35, .6), _rand(rng, .28, .45), _rand(rng, .2, .35)], device=DEV)   # brown / oxidised
    elif wr < .87:
        wcol = coat * _rand(rng, 1.2, 1.8) + .05                                                          # low contrast
    else:
        wcol = torch.tensor([_rand(rng, .3, .5), _rand(rng, .3, .5), _rand(rng, .45, .7)], device=DEV)    # bluish temper
    LL = getattr(tool, 'landLook', None)   # seg14: matte grey worn peripheral land (gen_pool_micro 'land' mode)
    if LL:
        wcol = torch.tensor(LL['col'], device=DEV)
    adh = torch.tensor([[.75, .75, .74], [.5, .42, .35], [.6, .5, .38], [.35, .33, .3], [.7, .45, .3]][rng.integers(5)], device=DEV) * _rand(rng, .8, 1.15)
    rho = torch.sqrt(x * x + y * y)
    th = torch.atan2(y, x)
    alb = coat[None].repeat(p.shape[0], 1)
    rough = torch.full_like(x, _rand(rng, .15, .45))
    spec = torch.full_like(x, _rand(rng, .5, 1.0))
    # grinding marks (tool class): fine streaks along the helix on lands, radial on the end face
    gm = torch.sin(z * _rand(rng, 40, 120) + th * 3) * _rand(rng, .02, .08)
    alb = alb * (1 + gm[:, None])
    # dust / residue on the tool body (still tool)
    if rng.random() < .4:
        dn = _noise2(th * 5, z * 2, rng.integers(1e9), freqs=(2, 5, 11), amps=(1, .6, .4))
        alb = alb * (1 + .25 * (dn > .7).float()[:, None])
    # honed edge glint on intact edges (a thin bright line that is NOT wear): hard negative
    if rng.random() < .5:
        ps_ = tool.psi(th, z)
        hone = (ps_ * rho < _rand(rng, .01, .04)) & ~wear
        alb = torch.where(hone[:, None], alb * _rand(rng, 1.5, 3.0), alb)
    isW = wear.clone()
    isC = parts == 3
    isA = parts == 4
    isW = isW & ~isC & ~isA
    # worn land: flat -> normal = radial (peripheral) or -z (end); scratches along the cutting direction
    radial = torch.stack([x / (rho + 1e-9), y / (rho + 1e-9), torch.zeros_like(x)], -1)
    n2 = n.clone()
    wn = torch.where((z < tool.R * .05)[:, None] & (rho < tool.R * .97)[:, None], torch.tensor([0., 0, -1], device=DEV)[None].expand_as(n), radial)
    tilt = _rand(rng, 0, .6)
    n2 = torch.where(isW[:, None], torch.nn.functional.normalize(wn * (1 - tilt) + n * tilt, dim=-1), n2)
    sc = torch.sin(z * _rand(rng, 150, 400) + _noise2(th * 20, z * 20, rng.integers(1e9)) * 3)
    alb = torch.where(isW[:, None], wcol[None] * (1 + .12 * sc[:, None]), alb)
    rough = torch.where(isW, torch.full_like(rough, LL['rough'] if LL else _rand(rng, .1, .5)), rough)
    spec = torch.where(isW, torch.full_like(spec, LL['spec'] if LL else _rand(rng, .5, 1.3)), spec)
    # fracture: rough grey carbide, random normals
    if isC.any():
        rn = torch.randn_like(n) * .45
        n2 = torch.where(isC[:, None], torch.nn.functional.normalize(n + rn, dim=-1), n2)
        alb = torch.where(isC[:, None], carb[None] * _rand(rng, .6, 1.2) * (1 + .3 * torch.randn_like(x))[:, None], alb)
        rough = torch.where(isC, torch.full_like(rough, .7), rough)
    if isA.any():
        rn = torch.randn_like(n) * .25
        n2 = torch.where(isA[:, None], torch.nn.functional.normalize(n + rn, dim=-1), n2)
        alb = torch.where(isA[:, None], adh[None] * (1 + .15 * torch.randn_like(x))[:, None], alb)
        rough = torch.where(isA, torch.full_like(rough, .85), rough)
        spec = torch.where(isA, torch.full_like(spec, .2), spec)
    V = -Dv[None]
    col = alb * lights['amb']
    Rr = 2 * (n2 * V).sum(-1, keepdim=True) * n2 - V
    for (L, Lc) in lights['dirs']:
        L = L.to(DEV)
        nd = (n2 * L[None]).sum(-1).clamp(min=0)
        rl = (Rr * L[None]).sum(-1).clamp(min=0)
        sh = 2 / (rough ** 2 + 1e-3)
        col = col + alb * nd[:, None] * Lc[None].to(DEV) * .6 + (spec * rl ** sh * (sh + 2) / 8)[:, None] * Lc[None].to(DEV) * (alb * .5 + .5 * lights['specTint'])
    # environment reflection: soft boxes on the sphere
    env = lights['env'](Rr)
    col = col + (spec * (1 - rough * .8))[:, None] * env * (alb * .6 + .4)
    return col.clamp(0, 4)


def make_lights(rng):
    dirs = []
    for _ in range(int(rng.integers(1, 4))):
        v = torch.tensor([_rand(rng, -1, 1), _rand(rng, -1.2, .3), _rand(rng, -1, .6)])
        v = v / v.norm()
        c = torch.tensor([_rand(rng, .8, 1.1), _rand(rng, .8, 1.05), _rand(rng, .75, 1.1)]) * _rand(rng, .3, 1.4)
        dirs.append((v, c))
    boxes = []
    for _ in range(int(rng.integers(1, 5))):
        v = torch.tensor([_rand(rng, -1, 1), _rand(rng, -1.3, .5), _rand(rng, -1, 1)])
        boxes.append((v / v.norm(), _rand(rng, .1, .5), _rand(rng, .3, 1.5)))
    amb = _rand(rng, .05, .35)

    def env(r):
        e = torch.zeros(r.shape[0], 1, device=r.device) + _rand(rng, .02, .1)
        for (v, w, a) in boxes:
            d = (r * v.to(r.device)[None]).sum(-1)
            e = e + a * torch.exp(-(1 - d).clamp(min=0) / (w * w))[:, None]
        return e.expand(-1, 3)
    return dict(dirs=dirs, amb=amb, env=env, specTint=torch.tensor([1., 1, 1], device=DEV))


def render(rng, H=512, W=512, view=None, ppm=None, ss=2, mode=None, tool=None, fixed=None):
    """one synthetic tool image. view: 'side' | 'top'. ppm: output pixels per mm."""
    tool = tool or Tool(rng)
    view = view or ('side' if rng.random() < .78 else 'top')
    mode = mode or rng.choice(['none', 'flank', 'mixed', 'chip', 'bue'], p=[.12, .38, .3, .12, .08])
    if mode != 'keep':
        plan_wear(tool, rng, mode)
    fx = fixed or {}
    if ppm is None:
        # tool diameter on the output: 70 .. 460 px, biased to 180..400
        dpx = math.exp(_rand(rng, math.log(70), math.log(460))) if rng.random() < .4 else _rand(rng, 180, 420)
        ppm = dpx / tool.D
    Dv, U, Rv = _cam(0)
    if view == 'side':
        elev = _rand(rng, -20, 35) if rng.random() < .85 else _rand(rng, -35, 50)
        elev = fx.get('elev', elev)
        ce = math.cos(math.radians(elev))
        f = fx.get('tipFrac', _rand(rng, .06, .55))              # tip row as a fraction of the height
        zc = (H / 2 - f * H) / ppm * ce
        xo = fx.get('xo', _rand(rng, -.25, .25)) * W / ppm
        cpt = [xo, 0.0, zc]
        zmax = zc + H / ppm / max(ce, .3) + tool.R * 2
    else:
        elev = fx.get('elev', _rand(rng, 58, 90))
        cpt = [_rand(rng, -.2, .2) * W / ppm, _rand(rng, -.2, .2) * W / ppm, 0.0] if 'elev' not in fx else [0.0, 0.0, 0.0]
        zmax = max(tool.D * 2.5, H / ppm * 1.2)
    hs, ws, pps = H * ss, W * ss, ppm * ss
    hit, P, Dvd, _ = raycast(tool, elev, hs, ws, pps, cpt, zmax)
    rgb = torch.zeros(hs * ws, 3, device=DEV)
    lab = torch.zeros(hs * ws, dtype=torch.uint8, device=DEV)
    hi = torch.nonzero(hit).flatten()
    if hi.numel():
        p = P[hi]
        f, parts, q = tool.field(p, want_parts=True)
        n = normals(tool, p)
        wmask, _ = wear_label(tool, q)
        lights = make_lights(rng)
        rgb[hi] = shade(tool, rng, p, n, Dvd, parts, wmask, hs, ws, hit, lights)
        l = torch.ones_like(parts)
        l = torch.where(wmask, torch.full_like(l, 2), l)
        l = torch.where(parts == 3, torch.full_like(l, 3), l)
        l = torch.where(parts == 4, torch.full_like(l, 4), l)
        lab[hi] = l
    rgb = rgb.view(hs, ws, 3)
    lab = lab.view(hs, ws)
    alpha = hit.view(hs, ws).float()
    # downsample: colour + alpha box filter; label = majority with wear classes winning at >= 1/4 coverage
    rgb_d = torch.nn.functional.avg_pool2d((rgb * alpha[..., None]).permute(2, 0, 1)[None], ss)[0].permute(1, 2, 0)
    a_d = torch.nn.functional.avg_pool2d(alpha[None, None], ss)[0, 0]
    rgb_d = rgb_d / a_d.clamp(min=1e-6)[..., None]
    oh = torch.nn.functional.one_hot(lab.long(), 5).permute(2, 0, 1).float()[None]
    cov = torch.nn.functional.avg_pool2d(oh, ss)[0]
    lab_d = cov.argmax(0)
    for c in (2, 3, 4):
        lab_d = torch.where((cov[c] >= .25) & (cov[c] >= cov[1] * .5), torch.full_like(lab_d, c), lab_d)
    lab_d = torch.where(a_d < .5, torch.zeros_like(lab_d), lab_d)
    meta = dict(view=view, elev=elev, ppm=ppm, D=tool.D, k=tool.k, mode=str(mode), vbMax=float(np.max(tool.wear['vb'])) if tool.wear else 0,
                helix=math.degrees(tool.beta), chips=len(tool.chips), blobs=len(tool.blobs))
    return rgb_d.cpu().numpy(), lab_d.to(torch.uint8).cpu().numpy(), a_d.cpu().numpy(), meta
