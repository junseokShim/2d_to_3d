"""Fine-tune the wear segmentation model for microscope mode (Keyence VHX-like close-ups of one cutting edge).

Init: the shipped phone model (ft4 it8000). Data: MUDESTREDA train split + heavily augmented Keyence crops of the training
views (micro_data.py). Leave-one-view-out: --test x100|x300|x300s holds that view out (both twins); the checkpoint is the
LAST one (no selection on the held-out view). Evaluation as the app runs it: whole image at working resolution (micro-core
NET_LONG 1600), tool on top, class-weight logit bias of the export, wear = p(flank) + p(chip) > WEAR_THR, tool = not
background; IoU against the mask, 255 ignored.

usage: train_micro.py --test x300 --out .work/runs/lovo_x300 [--iters 3000] [--bs 8]
       train_micro.py --test none --out .work/runs/micro_all          (all three views: the shipped microscope model)
       train_micro.py --eval CKPT [--test x300]                         (evaluation only)
"""
import argparse, os, sys, time, json
import numpy as np, torch, torch.nn.functional as F, cv2
sys.path.insert(0, os.path.dirname(__file__))
import train, micro_data

WEAR_THR = .985
CW = '.5,1,3,6,6'


def bias_of(cw=CW):
    w = [float(v) for v in cw.split(',')]
    return torch.tensor([-np.log(v / w[1]) for v in w]).view(1, -1, 1, 1)


@torch.no_grad()
def full_probs(model, img, dev, long_cap=1600):
    """whole image, scaled so the long side <= long_cap, padded to /32 (like seg-wear.js segmentImageProbs) -> probs [5,h,w]
    at the image's resolution"""
    h, w = img.shape[:2]
    s = min(1., long_cap / max(h, w))
    Wn, Hn = int(np.ceil(w * s / 32) * 32), int(np.ceil(h * s / 32) * 32)
    x = cv2.resize(img, (Wn, Hn), interpolation=cv2.INTER_AREA if s < 1 else cv2.INTER_LINEAR)
    model.eval()
    with torch.autocast('cuda', dtype=torch.bfloat16):
        lo = model(train.to_input(x[None], dev)).float()
    p = (lo + bias_of().to(dev)).softmax(1)[0]
    p = F.interpolate(p[None], size=(h, w), mode='bilinear', align_corners=False)[0]
    model.train()
    return p


def ious(p, lab):
    k = lab != 255
    wear_p = ((p[2] + p[3]) > WEAR_THR).cpu().numpy()
    tool_p = ~(p[0] > .5).cpu().numpy() | wear_p
    wear_t = (lab == 2) | (lab == 3)
    tool_t = (lab >= 1) & (lab <= 4)
    am = p.argmax(0).cpu().numpy()
    wa = (am == 2) | (am == 3)
    f = lambda a, b: float((a & b & k).sum() / max(1, ((a | b) & k).sum()))
    return {'wear': f(wear_p, wear_t), 'tool': f(tool_p, tool_t), 'wearArgmax': f(wa, wear_t)}


def evaluate(model, dev, items):
    out = {}
    for ip, mp_, name in items:
        img = cv2.imread(ip, cv2.IMREAD_COLOR)[..., ::-1].copy()
        lab = cv2.imread(mp_, cv2.IMREAD_UNCHANGED)
        lab = lab[..., 0] if lab.ndim == 3 else lab
        out[name] = ious(full_probs(model, img, dev), lab)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--test', default='none', help='held-out Keyence view: x100 | x300 | x300s | none')
    ap.add_argument('--out', default='.work/runs/micro')
    ap.add_argument('--init', default='.work/init/ft4_it8000.pt')
    ap.add_argument('--iters', type=int, default=3000)
    ap.add_argument('--bs', type=int, default=8)
    ap.add_argument('--size', type=int, default=384)
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--warm', type=float, default=.03)
    ap.add_argument('--workers', type=int, default=6)
    ap.add_argument('--mix', default='mud:.5,keyence:.5')
    ap.add_argument('--bw', type=float, default=2)
    ap.add_argument('--eval_every', type=int, default=1000)
    ap.add_argument('--eval', default='', help='evaluate this checkpoint only')
    ap.add_argument('--seed', type=int, default=1)
    a = ap.parse_args()
    dev = 'cuda'
    torch.backends.cudnn.benchmark = True
    views = [v for v in micro_data.VIEWS if v != a.test]
    test_items = [(ip, mp_, os.path.basename(ip)[:-4]) for ip, mp_, v, _ in micro_data.keyence_items([a.test])] if a.test != 'none' else []
    train_k = [(ip, mp_, os.path.basename(ip)[:-4]) for ip, mp_, v, _ in micro_data.keyence_items(views)]
    mud_val = micro_data.mud_items('val')[::5]
    model = train.build(weights=None).to(dev)
    model.load_state_dict(torch.load(a.eval or a.init, map_location=dev))
    if a.eval:
        r = {'test': evaluate(model, dev, test_items), 'train_views': evaluate(model, dev, train_k), 'mud_val': evaluate(model, dev, mud_val)}
        agg = lambda d: {k: round(float(np.mean([v[k] for v in d.values()])), 4) for k in ('wear', 'tool', 'wearArgmax')} if d else {}
        print(json.dumps({k: {'mean': agg(v), 'per': {n: {kk: round(vv, 4) for kk, vv in x.items()} for n, x in v.items()}} if k != 'mud_val' else {'mean': agg(v)} for k, v in r.items()}, indent=1))
        return
    os.makedirs(a.out, exist_ok=True)
    log = open(os.path.join(a.out, 'log.txt'), 'a')

    def P(*s):
        s = ' '.join(str(v) for v in s)
        print(s, flush=True)
        log.write(s + '\n'); log.flush()
    P('args', vars(a), 'train views', views)
    mud = micro_data.mud_items('train')
    mix = {k: float(v) for k, v in (t.split(':') for t in a.mix.split(','))}
    prod = micro_data.Producer(a.workers)
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4, fused=True)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.iters, pct_start=a.warm)
    cw = torch.tensor([float(v) for v in CW.split(',')], device=dev)
    rs = np.random.default_rng(a.seed)
    agg = lambda d: {k: round(float(np.mean([v[k] for v in d.values()])), 4) for k in ('wear', 'tool', 'wearArgmax')} if d else {}

    def ev(it):
        te, tr, mv = evaluate(model, dev, test_items), evaluate(model, dev, train_k), evaluate(model, dev, mud_val)
        P(f'EVAL it {it} heldout {a.test} {agg(te)} ' + ' '.join(f'{n}:{v["wear"]:.3f}/{v["tool"]:.3f}' for n, v in te.items()))
        P(f'EVAL it {it} trainviews {agg(tr)} mud_val {agg(mv)}')
    ev(0)
    it, t0, run = 0, time.time(), None
    ks = list(mix)
    pw = np.array([mix[k] for k in ks]); pw /= pw.sum()
    while it < a.iters:
        n = a.bs * min(a.eval_every, a.iters - it)
        tasks = []
        for _ in range(n):
            k = ks[rs.choice(len(ks), p=pw)]
            if k == 'keyence':
                ip, mp_, _ = train_k[rs.integers(len(train_k))]
                tasks.append(('keyence', int(rs.integers(2 ** 62)), ip, mp_, a.size))
            else:
                ip, mp_, _ = mud[rs.integers(len(mud))]
                tasks.append(('mud', int(rs.integers(2 ** 62)), ip, mp_, a.size, True))
        if it == 0:
            train.preview(prod.batches(tasks[:12], 12), os.path.join(a.out, 'train_preview.jpg'))
        for im, lb in prod.batches(tasks, a.bs):
            x, y = train.to_input(im, dev), torch.from_numpy(lb).long().to(dev)
            with torch.autocast('cuda', dtype=torch.bfloat16):
                out = model(x)
            loss = train.boundary_ce(out.float(), y, cw, a.bw) + train.dice_loss(out, y)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            it += 1
            run = loss.item() if run is None else .98 * run + .02 * loss.item()
            if it % 200 == 0:
                P(f'it {it} loss {run:.4f} lr {sched.get_last_lr()[0]:.2e} {time.time() - t0:.0f}s')
        torch.save(model.state_dict(), os.path.join(a.out, 'last.pt'))
        ev(it)
    P('done')
    prod.close()


if __name__ == '__main__':
    main()
