"""Export the trained wear segmentation model to ONNX for onnxruntime-web (wasm) and wrap it as base64 JS.

Graph: image (1,3,H,W) float RGB 0..1 (H, W multiples of 32; ImageNet normalisation inside) -> probs (1,5,H,W) softmax.
Writes www/models/wear-seg.onnx.js (Tool3D.segModelB64) and a parity fixture test/wear/seg/parity.json
(input = test/wear/seg/parity.png, torch argmax + class-probability sums) for test/wear/seg-run.js.
--calib N: fit a per-class logit bias on N exact-label validation samples (held-out pool renders + syn_ val) so that the
number of pixels predicted per wear class equals the number labelled. The class-weighted loss that makes the network find
thin, rare wear also makes it paint lands too wide (VB read ~2x); the bias removes that bias and is baked into the graph.
usage: export.py CKPT [--out www/models/wear-seg.onnx] [--calib 192]
"""
import os, sys, json, base64, argparse
import numpy as np, torch, torch.nn as nn, cv2
sys.path.insert(0, os.path.dirname(__file__))
import train

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')


class Wrap(nn.Module):
    def __init__(self, m, bias=None):
        super().__init__()
        self.m = m
        self.register_buffer('bias', torch.tensor(bias if bias is not None else [0.] * train.NC).view(1, -1, 1, 1))
        self.register_buffer('mean', torch.tensor([.485, .456, .406]).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor([.229, .224, .225]).view(1, 3, 1, 1))

    def forward(self, x):
        return (self.m((x - self.mean) / self.std) + self.bias).softmax(1)


@torch.no_grad()
def calibrate(m, n, b0=None, size=384, workers=6):
    """-> per-class logit bias (bg, tool = 0) so that predicted wear-class pixel counts match the labels on n val samples"""
    import data
    dev = 'cpu'          # the GPU is usually busy training
    pool = os.path.join(ROOT, '.work', 'pool')
    metas = data.load_pool(pool)
    vid = sorted(i for i in metas if i % 20 == 0)
    tasks = [('synth', 7_000_003 * k + 11, pool, metas[vid[k % len(vid)]], size) for k in range(n // 2)]
    syn = data.load_real('val').get('syn', [])
    tasks += [('real', 900 + k, ip, mp_, size) for k, (ip, mp_, _) in enumerate((syn * 4)[:n - len(tasks)])]
    prod = data.Producer(workers)
    L, Y = [], []
    m = m.to(dev).eval()
    for im, lb in prod.batches(tasks, 8):
        L.append(m(train.to_input(im, dev)).float() + torch.tensor(b0 or [0.] * train.NC).view(1, -1, 1, 1)); Y.append(torch.from_numpy(lb).long())
    prod.close()
    L, Y = torch.cat(L), torch.cat(Y)
    keep = Y != train.IGNORE
    L, Y = L.permute(0, 2, 3, 1)[keep], Y[keep]                 # [P, NC], [P]
    want = torch.bincount(Y, minlength=train.NC).float()
    b = torch.zeros(train.NC)

    def counts(b):
        return torch.bincount((L + b).argmax(1), minlength=train.NC).float()
    before = counts(b)
    for _ in range(4):                                          # coordinate bisection, rare classes last
        for c in (2, 4, 3):
            if want[c] == 0:
                continue
            lo, hi = -2., 2.            # a small correction only
            for _ in range(30):
                mid = (lo + hi) / 2; b[c] = mid
                if counts(b)[c] > want[c]: hi = mid
                else: lo = mid
            b[c] = (lo + hi) / 2
    after = counts(b)

    def iou(b):
        p = (L + b).argmax(1)
        return [float(((p == c) & (Y == c)).sum() / (((p == c) | (Y == c)).sum()).clamp(min=1)) for c in range(train.NC)]
    print('calib labelled px', want.long().tolist())
    print('  predicted before', before.long().tolist(), 'IoU', [round(v, 3) for v in iou(torch.zeros(train.NC))])
    print('  predicted after ', after.long().tolist(), 'IoU', [round(v, 3) for v in iou(b)])
    print('  bias', [round(float(v), 3) for v in b])
    m.cpu()
    return b.tolist()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ckpt')
    ap.add_argument('--out', default=os.path.join(ROOT, 'www', 'models', 'wear-seg.onnx'))
    ap.add_argument('--encoder', default='tu-mobilenetv3_large_100')
    ap.add_argument('--fixture', default=os.path.join(ROOT, 'test', 'wear', 'seg', 'parity.png'))
    ap.add_argument('--cw', default='', help='class weights used in training, e.g. .5,1,3,3,3 (bias = -log w)')
    ap.add_argument('--var', default='segModelB64', help='JS global (Tool3D.<var>); segSideModelB64 for the side-view model')
    ap.add_argument('--parity', default='', help='parity json out (default parity.json next to the fixture; none = skip)')
    ap.add_argument('--calib', type=int, default=0, help='fit the per-class logit bias on this many val samples (0 = none)')
    a = ap.parse_args()
    m = train.build(a.encoder, weights=None)
    m.load_state_dict(torch.load(a.ckpt, map_location='cpu'))
    # --cw: the class weights the checkpoint was trained with. Weighted cross-entropy learns q_c ~ w_c p_c, so -log w_c
    # (tool = 0) restores the posterior; without it thin lands come out too wide (VB read ~2x on held-out photos)
    bias = [-float(np.log(float(v) / float(a.cw.split(',')[1]))) for v in a.cw.split(',')] if a.cw else [0.] * train.NC
    if a.calib:
        bias = [u + v for u, v in zip(bias, calibrate(m, a.calib, bias))]
    print('logit bias', [round(v, 3) for v in bias])
    net = Wrap(m, bias).eval()
    x = torch.rand(1, 3, 256, 320)
    torch.onnx.export(net, x, a.out, input_names=['image'], output_names=['probs'], opset_version=17, dynamo=False,
                      dynamic_axes={'image': {2: 'h', 3: 'w'}, 'probs': {2: 'h', 3: 'w'}})
    import onnx, onnxruntime as ort
    onnx.checker.check_model(a.out)
    sess = ort.InferenceSession(a.out)
    y = sess.run(None, {'image': x.numpy()})[0]
    with torch.no_grad():
        yt = net(x).numpy()
    print('onnx', os.path.getsize(a.out), 'bytes; max |p_onnx - p_torch| =', float(np.abs(y - yt).max()))
    # parity fixture for the wasm runtime (node): a real-looking input and the torch result
    if os.path.exists(a.fixture) and a.parity != 'none':
        im = cv2.imread(a.fixture, cv2.IMREAD_COLOR)[..., ::-1]
        h, w = im.shape[:2]
        xi = torch.from_numpy(np.ascontiguousarray(im).astype(np.float32) / 255).permute(2, 0, 1)[None]
        with torch.no_grad():
            p = net(xi)[0].numpy()
        am = p.argmax(0)
        fx = {'w': w, 'h': h, 'counts': np.bincount(am.ravel(), minlength=5).tolist(), 'probSums': p.reshape(5, -1).sum(1).tolist(),
              'argmaxHash': int((am.ravel().astype(np.int64) * (np.arange(am.size) % 9973 + 1)).sum())}
        json.dump(fx, open(a.parity or os.path.join(os.path.dirname(a.fixture), 'parity.json'), 'w'), indent=1)
        print('fixture', fx['counts'])
    with open(a.out, 'rb') as f:
        b = base64.b64encode(f.read()).decode()
    with open(a.out + '.js', 'w') as f:
        f.write('/* Tool3D wear segmentation: U-Net, MobileNetV3-Large encoder (timm ImageNet-1k weights, Apache-2.0), trained on synthetic '
                'phone photos of worn end mills (scripts/seg). Classes 0 bg, 1 tool, 2 flank wear, 3 chipping, 4 adhesion. ONNX, base64. '
                'Built by scripts/seg/export.py */\n')
        f.write('(self.Tool3D=self.Tool3D||{}).' + a.var + '="' + b + '";\n')
    print('wrote', a.out + '.js', os.path.getsize(a.out + '.js'), 'bytes')


if __name__ == '__main__':
    main()
