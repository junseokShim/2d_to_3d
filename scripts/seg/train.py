"""Train the wear segmentation model (U-Net, ImageNet-pretrained MobileNetV3-Large encoder, 5 classes).

Data: synthetic pool (render.py -> gen_pool.py) composited on the fly (augment.py, data.py), plus labelled real images
from the shared dataset (C:/agent_research_team/datasets/toolwear, manifest.json, splits train/val/target) when present.

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
    return smp.Unet(encoder_name=encoder, encoder_weights=weights, classes=NC, decoder_channels=(256, 128, 64, 32, 16))


def to_input(im, dev):
    x = torch.from_numpy(im).to(dev, non_blocking=True).permute(0, 3, 1, 2).float()
    return (x - MEAN.to(dev)) / STD.to(dev)


def dice_loss(logits, y, eps=1.0):
    p = logits.float().softmax(1)
    oh = F.one_hot(y, NC).permute(0, 3, 1, 2).float()
    inter = (p * oh).sum((0, 2, 3))
    den = p.sum((0, 2, 3)) + oh.sum((0, 2, 3))
    return (1 - (2 * inter + eps) / (den + eps))[1:].mean()


def confusion(pred, y):
    return torch.bincount((y * NC + pred).flatten(), minlength=NC * NC).view(NC, NC)


def ious(cm):
    cm = cm.double()
    tp = cm.diag()
    return (tp / (cm.sum(0) + cm.sum(1) - tp).clamp(min=1)).tolist()


@torch.no_grad()
def evaluate(model, batches, dev):
    model.eval()
    cm = torch.zeros(NC, NC, dtype=torch.long, device=dev)
    for im, lb in batches:
        with torch.autocast('cuda', dtype=torch.float16):
            p = model(to_input(im, dev)).argmax(1)
        cm += confusion(p, torch.from_numpy(lb).long().to(dev))
    model.train()
    return ious(cm), cm


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pool', default='.work/pool')
    ap.add_argument('--out', default='.work/runs/r1')
    ap.add_argument('--iters', type=int, default=40000)
    ap.add_argument('--bs', type=int, default=16)
    ap.add_argument('--size', type=int, default=384)
    ap.add_argument('--lr', type=float, default=1e-3)
    ap.add_argument('--workers', type=int, default=10)
    ap.add_argument('--init', default='')
    ap.add_argument('--encoder', default='tu-mobilenetv3_large_100')
    ap.add_argument('--real_frac', type=float, default=0.25)
    ap.add_argument('--eval_every', type=int, default=2000)
    ap.add_argument('--nval', type=int, default=400)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    dev = 'cuda'
    torch.backends.cudnn.benchmark = True
    log = open(os.path.join(a.out, 'log.txt'), 'a')

    def P(*s):
        s = ' '.join(str(v) for v in s)
        print(s, flush=True)
        log.write(s + '\n'); log.flush()
    prod = data.Producer(a.workers)
    model = build(a.encoder).to(dev)
    if a.init:
        model.load_state_dict(torch.load(a.init, map_location=dev))
    metas = data.load_pool(a.pool)
    val_ids = sorted(i for i in metas if i % 20 == 0)
    # fixed validation set, generated once (same seeds every eval)
    vt = [('synth', 7_000_003 * k + 11, a.pool, metas[val_ids[k % len(val_ids)]], a.size) for k in range(a.nval)]
    val = list(prod.batches(vt, 16))
    real_va = data.load_real('val')
    rval = list(prod.batches([('real', 900 + k, ip, mp_, a.size) for k, (ip, mp_, _) in enumerate(real_va * 3)], 8)) if real_va else []
    P(f'pool {len(metas)} val ids {len(val_ids)} real val {len(real_va)}')
    opt = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=a.iters, pct_start=.05)
    scaler = torch.amp.GradScaler()
    cw = torch.tensor([.5, 1, 3, 3, 3], device=dev)
    it, t0, best, run = 0, time.time(), -1, None
    rs = np.random.default_rng(int(time.time()))
    while it < a.iters:
        metas = data.load_pool(a.pool)            # the generator keeps adding renders
        tr = [metas[i] for i in metas if i % 20 != 0]
        real_tr = data.load_real('train')
        n = a.bs * min(a.eval_every, a.iters - it)
        tasks = []
        for _ in range(n):
            if real_tr and rs.random() < a.real_frac:
                ip, mp_, _ = real_tr[rs.integers(len(real_tr))]
                tasks.append(('real', int(rs.integers(2 ** 62)), ip, mp_, a.size))
            else:
                tasks.append(('synth', int(rs.integers(2 ** 62)), a.pool, tr[rs.integers(len(tr))], a.size))
        for im, lb in prod.batches(tasks, a.bs):
            x, y = to_input(im, dev), torch.from_numpy(lb).long().to(dev)
            with torch.autocast('cuda', dtype=torch.float16):
                out = model(x)
            loss = F.cross_entropy(out.float(), y, weight=cw) + dice_loss(out, y)
            opt.zero_grad(set_to_none=True)
            scaler.scale(loss).backward()
            scaler.step(opt)
            scaler.update()
            sched.step()
            it += 1
            run = loss.item() if run is None else .98 * run + .02 * loss.item()
            if it % 200 == 0 or it in (1, 20):
                P(f'it {it} loss {run:.4f} lr {sched.get_last_lr()[0]:.2e} {time.time() - t0:.0f}s pool {len(tr)} real {len(real_tr)}')
        iou, cm = evaluate(model, val, dev)
        score = iou[2] * .5 + iou[3] * .25 + iou[4] * .25
        msg = f'EVAL it {it} synth IoU bg {iou[0]:.3f} tool {iou[1]:.3f} flank {iou[2]:.3f} chip {iou[3]:.3f} adh {iou[4]:.3f} score {score:.3f}'
        if rval:
            riou, _ = evaluate(model, rval, dev)
            msg += ' | real-val IoU ' + ' '.join(f'{v:.3f}' for v in riou)
        P(msg)
        torch.save(model.state_dict(), os.path.join(a.out, 'last.pt'))
        if score > best:
            best = score
            torch.save(model.state_dict(), os.path.join(a.out, 'best.pt'))
    P('done best', best)
    prod.close()


if __name__ == '__main__':
    main()
