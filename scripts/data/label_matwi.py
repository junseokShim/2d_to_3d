"""Semi-automatic masks for MATWI (milling insert flank face, microscope camera, expert VB in um per image).

Per image: work on the set's published crop (sets.csv) grown by PAD px. Cutting edge = strongest dark->bright step
(rake side/background above, lit flank below), robust line fit. Tool (1) = SAM2.1-small mask prompted with points on
the flank below the edge and negatives above it. Flank wear (2) = band hanging from the edge whose rows differ from
the intact flank further down (brighter/smoother land or darker groove), per column. Adhesion (4) = saturated metallic
deposits touching the edge (only when the expert type mentions adhesion). The measured VB (um) is the check: per set
px/mm = median(detected VBmax px / VB um); an image is kept only if its own ratio is within KEEP of the set median.
  python label_matwi.py <root> [--limit N] [--sets 2,3] [--dry]   (--dry: no writes, prints ratios)
"""
import argparse, csv, json, os, sys
import cv2, numpy as np

PAD = 150
IGN = 255  # ignore label: not supervised (defocused / uncertain)
KEEP = (0.6, 1.6)


def load_rows(raw):
    sets = {r[''].replace('Set ', ''): r for r in csv.DictReader(open(os.path.join(raw, 'sets.csv')))}
    out = []
    for r in csv.DictReader(open(os.path.join(raw, 'labels.csv'))):
        if not r['ImageFile'] or not r['wear']: continue
        p = os.path.join(raw, 'Set' + r['Set'], os.path.basename(r['ImageFile']))
        if os.path.isfile(p): out.append((r, p, sets[r['Set']]))
    return out


def crop(img, setrow):
    x0, y0, x1, y1 = [int(v) for v in setrow['crop'].split(',')]
    h, w = img.shape[:2]
    X0, Y0, X1, Y1 = max(0, x0 - PAD), max(0, y0 - PAD), min(w, x1 + PAD), min(h, y1 + PAD)
    return img[Y0:Y1, X0:X1].copy(), (X0, Y0)


def edge_line(g):
    """Per-column edge row (dark above -> bright below), robust line, local refinement."""
    h, w = g.shape
    s = cv2.GaussianBlur(g.astype(np.float32), (0, 0), 4)
    gy = cv2.Sobel(s, cv2.CV_32F, 0, 1, ksize=5)
    lo, hi = int(0.08 * h), int(0.75 * h)
    xs = np.arange(0, w, 4)
    e = np.array([lo + np.argmax(gy[lo:hi, x]) for x in xs], np.float32)
    st = np.array([gy[int(v), x] for v, x in zip(e, xs)])
    good = st > np.percentile(st, 30)
    p = np.polyfit(xs[good], e[good], 1)
    for _ in range(6):
        r = e - np.polyval(p, xs)
        good = (np.abs(r) < max(6, 2.5 * np.median(np.abs(r[good])) + 1)) & (st > 0)
        p = np.polyfit(xs[good], e[good], 1)
    X = np.arange(w)
    line = np.polyval(p, X)
    g2 = cv2.GaussianBlur(g.astype(np.float32), (0, 0), 1.5)
    gy2 = cv2.Sobel(g2, cv2.CV_32F, 0, 1, ksize=3)
    ref = np.array([max(0, int(line[x]) - 10) + np.argmax(gy2[max(0, int(line[x]) - 10):min(h, int(line[x]) + 11), x]) for x in X], np.float32)
    ref = cv2.medianBlur(ref.reshape(1, -1), 5).ravel()
    return line, ref, p, float(good.mean())


_PRED = None


def sam_predictor():
    global _PRED
    if _PRED is None:
        import torch
        from sam2.build_sam import build_sam2
        from sam2.sam2_image_predictor import SAM2ImagePredictor
        ck = os.environ.get('SAM2_CKPT', 'C:/agent_research_team/datasets/models/sam2/sam2.1_hiera_small.pt')
        _PRED = SAM2ImagePredictor(build_sam2('configs/sam2.1/sam2.1_hiera_s.yaml', ck, device='cuda' if torch.cuda.is_available() else 'cpu'))
    return _PRED


def tool_mask(img, line):
    import torch
    h, w = img.shape[:2]
    pos, neg = [], []
    for fx in (0.45, 0.65, 0.85):
        x = int(fx * w); y = line[x]
        pos += [(x, min(h - 5, y + 50)), (x, min(h - 5, y + 140))]
        if y - 60 > 5: neg.append((x, y - 60))
    pts = np.array(pos + neg, np.float32); lab = np.array([1] * len(pos) + [0] * len(neg), np.int32)
    pr = sam_predictor()
    with torch.inference_mode(), torch.autocast('cuda', dtype=torch.bfloat16):
        pr.set_image(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        ms, sc, _ = pr.predict(point_coords=pts, point_labels=lab, multimask_output=True)
    ms = ms.astype(bool)
    # prefer the mask that contains all positives, excludes negatives, and has the best score
    best, bs = None, -1
    for m, s in zip(ms, sc):
        okp = np.mean([m[int(y), int(x)] for x, y in pos]); okn = np.mean([not m[int(y), int(x)] for x, y in neg]) if neg else 1
        v = s + okp + okn
        if v > bs: best, bs = m, v
    m = best.astype(np.uint8)
    n, lb, stt, _ = cv2.connectedComponentsWithStats(m)
    if n > 1: m = (lb == 1 + np.argmax(stt[1:, cv2.CC_STAT_AREA])).astype(np.uint8)
    return m, float(bs)


def rectify(g, edge, d0=-20, d1=200):
    """Edge-straightened strip R[d - d0, x] = g[edge[x] + d, x] (NaN outside the image)."""
    h, w = g.shape
    D = np.arange(d0, d1)[:, None]
    Y = np.round(edge[None, :]).astype(int) + D
    R = np.full(Y.shape, np.nan, np.float32)
    ok = (Y >= 0) & (Y < h)
    X = np.broadcast_to(np.arange(w)[None, :], Y.shape)
    R[ok] = g[Y[ok], X[ok]]
    return R, d0


def wear_band(img, edge, tool, maxh=150):
    """Per-column wear-land height (px below the edge): rows contiguous from the edge whose intensity departs from the
    intact flank 70..140 px further down in the same neighbourhood (bright striated land or dark groove)."""
    g = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)[..., 0].astype(np.float32)
    h, w = g.shape
    R, d0 = rectify(g, edge)
    T, _ = rectify(tool.astype(np.float32), edge)
    Rs = cv2.blur(np.nan_to_num(R, nan=0), (9, 3))
    ref = Rs[70 - d0:140 - d0]
    tref = np.nan_to_num(T[70 - d0:140 - d0]) > 0.5
    mu = np.full(w, np.nan, np.float32); sd = np.full(w, np.nan, np.float32)
    for x in range(w):
        if tref[:, x].sum() > 20:
            v = ref[tref[:, x], x]; mu[x] = np.median(v); sd[x] = 1.4826 * np.median(np.abs(v - mu[x]))
    valid = ~np.isnan(mu)
    if valid.sum() < 50: return np.zeros(w, np.float32), None
    k = 41; X = np.arange(w)
    mu = np.interp(X, X[valid], mu[valid]); sd = np.interp(X, X[valid], sd[valid])
    mu = np.convolve(mu, np.ones(k) / k, 'same'); sd = np.maximum(np.convolve(sd, np.ones(k) / k, 'same'), 3.0)
    Z = (Rs - mu[None, :]) / sd[None, :]
    heights = np.zeros(w, np.float32)
    for x in range(w):
        if not valid[x]: continue
        run = 0; miss = 0
        for d in range(2, maxh):
            r = d - d0
            if np.isnan(R[r, x]) or not T[r, x] >= 0.5: break
            if abs(Z[r, x]) > 2.5: run = d; miss = 0
            else:
                miss += 1
                if miss > 4: break
        heights[x] = run
    hk = np.ones((1, 21), np.uint8)
    h1 = cv2.erode(cv2.dilate(heights.reshape(1, -1), hk), hk).ravel()
    heights = np.convolve(h1, np.ones(9) / 9, mode='same')
    heights[heights < 4] = 0
    return heights, (float(np.median(mu)), float(np.median(sd)))


def glare(img, edge, m):
    """Saturated blobs near the edge (adhesion, chips, specular flare): not labelled with certainty -> ignore."""
    v = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[..., 2]
    h, w = m.shape
    yy = np.arange(h)[:, None]
    cand = ((v > 235) & (np.abs(yy - edge[None, :]) < 160)).astype(np.uint8)
    cand = cv2.dilate(cv2.morphologyEx(cand, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8)), np.ones((9, 9), np.uint8))
    n, lb, st, _ = cv2.connectedComponentsWithStats(cand)
    for i in range(1, n):
        if st[i, cv2.CC_STAT_AREA] >= 300: m[lb == i] = IGN
    return m


def label(p, setrow, typ):
    img, off = crop(cv2.imread(p), setrow)
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    line, edge, pl, inl = edge_line(g)
    tool, ssc = tool_mask(img, line)
    h, w = g.shape
    yy = np.arange(h)[:, None]
    above = yy < edge[None, :] - 3          # the flank lies below the cutting edge; chips/deposits above it are not tool
    tool[above] = 0
    hts, ref = wear_band(img, edge, tool)
    # no band where the tool below the edge is shorter than 60 px (flank side walls, crop borders)
    depth = np.array([tool[int(edge[x]) + 1:, x].sum() if int(edge[x]) + 1 < h else 0 for x in range(w)])
    hts[depth < 60] = 0; hts[:12] = 0; hts[-12:] = 0
    m = np.where(tool > 0, 1, IGN).astype(np.uint8)
    m[above & (m == IGN)] = IGN
    band = (yy >= edge[None, :]) & (yy < edge[None, :] + hts[None, :]) & (tool > 0)
    m[band] = 2
    # ignore ring around the band's lower boundary (+-25 %) and around the tool outline (SAM edge uncertainty)
    lo = (yy >= edge[None, :] + 0.75 * hts[None, :]) & (yy < edge[None, :] + 1.25 * hts[None, :] + 2) & (hts[None, :] > 0) & (tool > 0)
    m[lo & (m == 1)] = IGN
    ring = cv2.dilate(tool, np.ones((7, 7), np.uint8)) - cv2.erode(tool, np.ones((7, 7), np.uint8))
    m[(ring > 0) & (m != 2)] = IGN
    m = glare(img, edge, m)
    info = dict(cropOffset=off, edgeSlope=float(pl[0]), edgeInliers=inl, samScore=ssc, toolFrac=float(tool.mean()), ignoreFrac=float((m == IGN).mean()),
                vbPxMax=float(hts.max()), vbPxP90=float(np.percentile(hts[hts > 0], 90)) if (hts > 0).any() else 0.0, vbPxMean=float(hts[hts > 0].mean()) if (hts > 0).any() else 0.0, wearCols=float((hts > 0).mean()))
    return img, m, info

SET_MIN_CORR = 0.6      # a set's detected band height must track the expert VB (Pearson r over the set) ...
RATIO_BAND = (0.7, 1.4)  # ... and an image's px-per-um ratio must lie within this factor of its set's median


def finalize(root):
    """Stage -> processed/. Sets whose detected band tracks VB (r >= SET_MIN_CORR) keep class 2 on images whose ratio is
    consistent; every other image keeps tool (1) but its wear zone (edge .. edge + 1.5 x the set's VB-predicted height, or
    the detected band) becomes 255 ignore -> labelQuality 'tool-only'. Images with a failed tool mask are dropped."""
    import shutil
    stage = os.path.join(root, 'work/matwi')
    info = json.load(open(os.path.join(stage, 'stage_info.json')))
    out = {d: os.path.join(root, 'processed', d) for d in ('images', 'masks', 'labelinfo')}
    for d in out.values(): os.makedirs(d, exist_ok=True)
    bys = {}
    for k, v in info.items(): bys.setdefault(v['set'], []).append(k)
    stats = {}; counts = dict(verified=0, toolonly=0, dropped=0)
    for s_, ks in sorted(bys.items()):
        vb = np.array([info[k]['vbUm'] for k in ks]); p90 = np.array([info[k]['vbPxP90'] for k in ks])
        r = float(np.corrcoef(vb, p90)[0, 1]) if len(ks) > 5 and vb.std() > 0 and p90.std() > 0 else float('nan')
        ratio = p90 / np.maximum(vb, 1); med = float(np.median(ratio[p90 > 0])) if (p90 > 0).any() else 0.0
        stats[s_] = dict(n=len(ks), corr=r, pxPerUmMedian=med)
        for k, v, rt in zip(ks, vb, ratio):
            it = info[k]
            m = cv2.imread(os.path.join(stage, k + '_mask.png'), cv2.IMREAD_GRAYSCALE)
            if m is None or it['toolFrac'] < 0.05 or it['edgeInliers'] < 0.4: counts['dropped'] += 1; it['status'] = 'dropped'; continue
            ok = (r >= SET_MIN_CORR) and med > 0 and RATIO_BAND[0] * med <= rt <= RATIO_BAND[1] * med and 'adhesion' not in it['wearType']
            if not ok:
                # wear zone -> ignore: every pixel within 1.5x of max(detected band, VB-predicted band) under the edge
                hgt = max(it['vbPxP90'], v * (med if med > 0 else 0.5)) * 1.5 + 10
                wear = m == 2
                m[wear] = IGN
                img = cv2.imread(os.path.join(stage, k + '_img.png'))
                g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
                _, edge, _, _ = edge_line(g)
                yy = np.arange(m.shape[0])[:, None]
                zone = (yy >= edge[None, :] - 3) & (yy < edge[None, :] + hgt)
                m[zone & (m == 1)] = IGN
                it['labelQuality'] = 'tool-only'; counts['toolonly'] += 1
            else:
                it['labelQuality'] = 'wear-verified'; counts['verified'] += 1
            it['pxPerMmEst'] = med * 1000 if med > 0 and r >= SET_MIN_CORR else None
            it['status'] = 'kept'
            shutil.copyfile(os.path.join(stage, k + '_img.png'), os.path.join(out['images'], k + '.png'))
            cv2.imwrite(os.path.join(out['masks'], k + '.png'), m)
            json.dump(it, open(os.path.join(out['labelinfo'], k + '.json'), 'w'))
    json.dump(dict(sets=stats, counts=counts, policy=dict(SET_MIN_CORR=SET_MIN_CORR, RATIO_BAND=RATIO_BAND)),
              open(os.path.join(stage, 'finalize_report.json'), 'w'), indent=1)
    print(json.dumps(stats, indent=0)); print(counts)


if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('root'); ap.add_argument('--limit', type=int, default=0)
    ap.add_argument('--sets', default=''); ap.add_argument('--dry', action='store_true'); ap.add_argument('--every', type=int, default=1); ap.add_argument('--finalize', action='store_true')
    a = ap.parse_args()
    raw = os.path.join(a.root, 'raw/matwi')
    rows = load_rows(raw)
    if a.sets: rows = [r for r in rows if r[0]['Set'] in a.sets.split(',')]
    rows = rows[::a.every]
    if a.limit: rows = rows[:a.limit]
    stage = os.path.join(a.root, 'work/matwi'); os.makedirs(stage, exist_ok=True)
    if a.finalize: finalize(a.root); sys.exit(0)
    sfile = os.path.join(stage, 'stage_info%s.json' % ('_dry' if a.dry else ''))
    done = json.load(open(sfile)) if os.path.exists(sfile) else {}
    recs = list(done.items())
    for r, p, sr in rows:
        sid = 'matwi_S%s_%03d' % (r['Set'], int(float(r['ImageID'])))
        if sid in done: continue
        img, m, info = label(p, sr, r['type'])
        info.update(source='matwi', set=r['Set'], vbUm=float(r['wear']), wearType=r['type'], rawImage=os.path.relpath(p, a.root).replace('\\', '/'))
        if not a.dry:
            cv2.imwrite(os.path.join(stage, sid + '_img.png'), img); cv2.imwrite(os.path.join(stage, sid + '_mask.png'), m)
        recs.append((sid, info))
        if len(recs) % 20 == 0: json.dump(dict(recs), open(sfile, 'w'), indent=0)
        print(sid, r['wear'], r['type'], 'vbPx %.0f p90 %.0f mean %.0f cols %.2f' % (info['vbPxMax'], info['vbPxP90'], info['vbPxMean'], info['wearCols']), 'tool %.2f' % info['toolFrac'], 'sam %.2f' % info['samScore'], flush=True)
    json.dump(dict(recs), open(sfile, 'w'), indent=0)
