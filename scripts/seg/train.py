"""Train the wear segmentation model (U-Net, ImageNet-pretrained MobileNetV3-Large encoder, 5 classes).

Data: synthetic pool (render.py -> gen_pool.py) composited on the fly (augment.py, data.py), plus the labelled images of
the shared dataset (processed/<source>_*.png; data.split_of: syn_ every 10th + mud_ tool T3 = val, target_ eval only).

usage: train.py --pool .work/pool --out .work/runs/r1 [--iters 40000] [--bs 16] [--size 384] [--init ckpt]
"""
import argparse, os, sys, time
import numpy as np, torch, torch.nn.functional as F
sys.path.insert(0, os.path.dirname(__file__))
import data

NC = 5
MEAN = torch.tensor([0.485, 0.456, 0.406]).view(1, 3, 1, 1) * 255
STD = torch.tensor([0.229, 0.224, 0.225]).view(1, 3, 1, 1) * 255


def build(encoder='tu-mobilenetv3_large_100', weights='imagenet'):
    import segmentation_models_pytorch as smp
    # decoder kept slim so the fp32 ONNX stays < 20 MB (4.58 M params; (256,128,64,32,16) was 6.7 M = 27 MB)
    return smp.Unet(encoder_name=encoder, encoder_weights=weights, classes=NC, decoder_channels=(128, 64, 48, 32, 16))


def to_input(im, dev):
    x = torch.from_numpy(im).to(dev, non_blocking=True).permute(0, 3, 1, 2).float()
    return (x - MEAN.to(dev)) / STD.to(dev)


IGNORE = 255      # label 255 = uncertain (defocused / unsure), excluded from loss and metrics


def dice_loss(logits, y, eps=1.0):
    p = logits.float().softmax(1)
    v = (y != IGNORE).unsqueeze(1).float()
    oh = F.one_hot(torch.where(y == IGNORE, 0, y), NC).permute(0, 3, 1, 2).float() * v
    p = p * v
    inter = (p * oh).sum((0, 2, 3))
    den = p.sum((0, 2, 3)) + oh.sum((0, 2, 3))
    return (1 - (2 * inter + eps) / (den + eps))[1:].mean()


def boundary_ce(logits, y, cw, bw):
    """class-weighted cross-entropy, pixels within 2 px of a wear-class (>= 2) boundary weighted (1 + bw): the land's
    edges decide VB, and they are a thin share of its pixels"""
    ce = F.cross_entropy(logits, y, reduction='none', ignore_index=IGNORE)
    yv = torch.where(y == IGNORE, 0, y)
    w = cw[yv] * (y != IGNORE)
    wear = (yv >= 2).float().unsqueeze(1)
    edge = (F.max_pool2d(wear, 5, 1, 2) - (-F.max_pool2d(-wear, 5, 1, 2))).squeeze(1)
    w = w * (1 + bw * edge)
    return (ce * w).sum() / w.sum().clamp(min=1e-6)


def confusion(pred, y):
    k = y != IGNORE
    return torch.bincount((y[k] * NC + pred[k]).flatten(), minlength=NC * NC).view(NC, NC)


def ious(cm):
    cm = cm.double()
    tp = cm.diag()
    return (tp / (cm.sum(0) + cm.sum(1) - tp).clamp(min=1)).tolist()


@torch.no_grad()
def evaluate(model, batches, dev):
    model.eval()
    cm = torch.zeros(NC, NC, dtype=torch.long, device=dev)
    for im, lb in batches:
        with torch.autocast('cuda', dtype=torch.bfloat16):
            p = model(to_input(im, dev)).argmax(1)
        cm += confusion(p, torch.from_numpy(lb).long().to(dev))
    model.train()
    return ious(cm), cm


def preview(batches, path, n=12):
    """montage of training samples with the label overlaid (sanity check of the data pipeline)"""
    import cv2
    from target_eval import COL
    tiles = []
    for im, lb in batches:
        for i in range(len(im)):
            o = im[i].copy(); m = (lb[i] >= 2) & (lb[i] < NC)
            o[m] = (.4 * o[m] + .6 * COL[lb[i][m]]).astype(np.uint8)
            c, _ = cv2.findContours((lb[i] > 0).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(o, c, -1, (0, 255, 0), 1)
            tiles.append(cv2.resize(np.hstack([im[i], o]), None, fx=.5, fy=.5))
            if len(tiles) == n:
                rows = [np.hstack(tiles[j:j + 3]) for j in range(0, n, 3)]
                cv2.imwrite(path, np.vstack(rows)[..., ::-1])
                return


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pool', default='.work/pool')
    ap.add_argument('--out', default='.work/runs/r1')
    ap.add_argument('--iters', type=int, default=40000)
    ap.add_argument('--bs', type=int, default=16)
    ap.add_argument('--size', type=int, default=384)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--warm', type=float, default=.05)
    ap.add_argument('--workers', type=int, default=10)
    ap.add_argument('--init', default='')
    ap.add_argument('--encoder', default='tu-mobilenetv3_large_100')
    ap.add_argument('--mix', default='pool:1', help='sampling weights per source, e.g. pool:.5,syn:.25,mud:.25')
    ap.add_argument('--eval_every', type=int, default=2000)
    ap.add_argument('--nval', type=int, default=400)
    ap.add_argument('--ignore_tool', default='mud', help='sources whose tool pixels are not trained on (close-ups of flat inserts: '
                    'their granular grey rake face looks like the grey mat behind the photos, the network learned it as tool)')
    ap.add_argument('--cw', default='.5,1,3,6,6', help='cross-entropy class weights bg,tool,flank,chip,adhesion (chip/adhesion are rare)')
    ap.add_argument('--win', type=float, default=0, help='share of pool samples framed like the app side window (augment.compose win)')
    ap.add_argument('--bw', type=float, default=0, help='extra cross-entropy weight on pixels within 2 px of a wear-class boundary (thin lands)')
    ap.add_argument('--pool2', default='', help='second render pool (mix key pool2), e.g. gen_pool_thin.py phone-like thin lands')
    ap.add_argument('--win2', type=float, default=.8, help='share of pool2 samples framed like the app side window')
    ap.add_argument('--pool3', default='', help='USB-microscope render pool (gen_pool_micro.py), mix key micro, composited by augment.compose_micro')
    ap.add_argument('--win3', type=float, default=.4, help='share of micro samples framed like the app side window')
    ap.add_argument('--exclude', default='', help='regex on real stems never trained on (held-out tool of a fold)')
    ap.add_argument('--save_every', action='store_true', help='keep a checkpoint per eval (it<N>.pt)')
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    dev = 'cuda'
    torch.backends.cudnn.benchmark = True
    if os.name == 'nt':        # the CPU is shared with renders: keep the thread that launches GPU kernels responsive
        import ctypes
        ctypes.windll.kernel32.SetPriorityClass(ctypes.windll.kernel32.GetCurrentProcess(), 0x8000)   # ABOVE_NORMAL
    log = open(os.path.join(a.out, 'log.txt'), 'a')

    def P(*s):
        s = ' '.join(str(v) for v in s)
        print(s, flush=True)
        log.write(s + '\n'); log.flush()
    P('args', vars(a))
    import target_eval
    prod = data.Producer(a.workers)
    model = build(a.encoder).to(dev)
    if a.init:
        model.load_state_dict(torch.load(a.init, map_location=dev))
    mix = {k: float(v) for k, v in (t.split(':') for t in a.mix.split(','))}
    no_tool = set(filter(None, a.ignore_tool.split(',')))
    metas = data.load_pool(a.pool)
    val_ids = sorted(i for i in metas if i % 20 == 0)
    # fixed validation sets, generated once (same seeds every eval), one per source
    vals = {'pool': list(prod.batches([('synth', 7_000_003 * k + 11, a.pool, metas[val_ids[k % len(val_ids)]], a.size)
                                       for k in range(a.nval)], 16))}
    if a.pool2:                # fixed val set of the second pool, framed like the app side window
        m2 = data.load_pool(a.pool2)
        v2 = sorted(i for i in m2 if i % 20 == 0)
        vals['pool2'] = list(prod.batches([('synth', 7_000_003 * k + 13, a.pool2, m2[v2[k % len(v2)]], a.size, True)
                                           for k in range(min(a.nval, 3 * len(v2)))], 16))
    if a.pool3:                # fixed val set of the microscope pool
        m3 = data.load_pool(a.pool3)
        v3 = sorted(i for i in m3 if i % 20 == 0)
        vals['micro'] = list(prod.batches([('micro', 7_000_003 * k + 17, a.pool3, m3[v3[k % len(v3)]], a.size, k % 3 == 0)
                                           for k in range(min(a.nval, 3 * len(v3)))], 16))
    real_va = data.load_real('val')
    for src, items in real_va.items():
        n = min(a.nval, 3 * len(items))
        vals[src] = list(prod.batches([('real', 900 + k, ip, mp_, a.size) for k, (ip, mp_, _) in enumerate((items * 3)[:n])], 16))
    P(f'pool {len(metas)} val ids {len(val_ids)} real val ' + ' '.join(f'{k} {len(v)}' for k, v in real_va.items()))
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4, fused=True)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.iters, pct_start=a.warm)
    cw = torch.tensor([float(v) for v in a.cw.split(',')], device=dev)
    it, t0, best, run = 0, time.time(), -1, None
    rs = np.random.default_rng(int(time.time()))
    first = True
    while it < a.iters:
        metas = data.load_pool(a.pool)            # the generator keeps adding renders
        tr = [metas[i] for i in metas if i % 20 != 0]
        real_tr = data.load_real('train', exclude=a.exclude or None)
        m2 = data.load_pool(a.pool2) if a.pool2 else {}
        tr2 = [m2[i] for i in m2 if i % 20 != 0]
        m3 = data.load_pool(a.pool3) if a.pool3 else {}
        tr3 = [m3[i] for i in m3 if i % 20 != 0]
        srcs = [k for k in mix if (k == 'pool' and tr) or (k == 'pool2' and tr2) or (k == 'micro' and tr3) or real_tr.get(k)]
        pw = np.array([mix[k] for k in srcs]); pw /= pw.sum()
        n = a.bs * min(a.eval_every, a.iters - it)
        tasks = []
        for _ in range(n):
            k = srcs[rs.choice(len(srcs), p=pw)]
            if k == 'pool':
                tasks.append(('synth', int(rs.integers(2 ** 62)), a.pool, tr[rs.integers(len(tr))], a.size, bool(rs.random() < a.win)))
            elif k == 'pool2':
                tasks.append(('synth', int(rs.integers(2 ** 62)), a.pool2, tr2[rs.integers(len(tr2))], a.size, bool(rs.random() < a.win2)))
            elif k == 'micro':
                tasks.append(('micro', int(rs.integers(2 ** 62)), a.pool3, tr3[rs.integers(len(tr3))], a.size, bool(rs.random() < a.win3)))
            else:
                ip, mp_, _ = real_tr[k][rs.integers(len(real_tr[k]))]
                tasks.append(('real', int(rs.integers(2 ** 62)), ip, mp_, a.size, k in no_tool))
        if first:
            preview(prod.batches(tasks[:12], 12), os.path.join(a.out, 'train_preview.jpg'))
            first = False
        for im, lb in prod.batches(tasks, a.bs):
            x, y = to_input(im, dev), torch.from_numpy(lb).long().to(dev)
            with torch.autocast('cuda', dtype=torch.bfloat16):     # bf16: no loss scaler; fp16 + GradScaler was ~7x slower here
                out = model(x)
            if a.bw > 0:
                loss = boundary_ce(out.float(), y, cw, a.bw) + dice_loss(out, y)
            else:
                loss = F.cross_entropy(out.float(), y, weight=cw, ignore_index=IGNORE) + dice_loss(out, y)
            opt.zero_grad(set_to_none=True)
            loss.backward()
            opt.step()
            sched.step()
            it += 1
            run = loss.item() if run is None else .98 * run + .02 * loss.item()
            if it % 200 == 0 or it in (1, 20):
                P(f'it {it} loss {run:.4f} lr {sched.get_last_lr()[0]:.2e} {time.time() - t0:.0f}s pool {len(tr)} real ' +
                  ' '.join(f'{k} {len(v)}' for k, v in real_tr.items()))
        score, ws = 0, 0
        for src, vb in vals.items():
            iou, cm = evaluate(model, vb, dev)
            P(f'EVAL it {it} {src:5s} IoU bg {iou[0]:.3f} tool {iou[1]:.3f} flank {iou[2]:.3f} chip {iou[3]:.3f} adh {iou[4]:.3f}')
            w = mix.get(src, .25)
            has = [c for c in (2, 3, 4) if cm[c].sum() > 0]      # score only the wear classes this val set labels
            sc = np.mean([iou[c] for c in has])
            if src in ('pool', 'pool2', 'micro', 'syn'):                            # exact tool masks: reading tool vs background counts too
                sc = .75 * sc + .25 * iou[1]
            score += w * sc; ws += w
        score /= max(ws, 1e-9)
        tr_res = target_eval.evaluate(model, a.out, f'_{it:06d}', dev)
        P(f'TARGET it {it} ' + target_eval.fmt(tr_res))
        P(f'SCORE it {it} {score:.4f}')
        torch.save(model.state_dict(), os.path.join(a.out, 'last.pt'))
        if a.save_every:
            torch.save(model.state_dict(), os.path.join(a.out, f'it{it}.pt'))
        if score > best:
            best = score
            torch.save(model.state_dict(), os.path.join(a.out, 'best.pt'))
    P('done best', best)
    prod.close()


if __name__ == '__main__':
    main()
