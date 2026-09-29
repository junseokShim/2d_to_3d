"""Export the trained wear segmentation model to ONNX for onnxruntime-web (wasm) and wrap it as base64 JS.

Graph: image (1,3,H,W) float RGB 0..1 (H, W multiples of 32; ImageNet normalisation inside) -> probs (1,5,H,W) softmax.
Writes www/models/wear-seg.onnx.js (Tool3D.segModelB64) and a parity fixture test/wear/seg/parity.json
(input = test/wear/seg/parity.png, torch argmax + class-probability sums) for test/wear/seg-run.js.
usage: export.py CKPT [--out www/models/wear-seg.onnx]
"""
import os, sys, json, base64, argparse
import numpy as np, torch, torch.nn as nn, cv2
sys.path.insert(0, os.path.dirname(__file__))
import train

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')


class Wrap(nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m
        self.register_buffer('mean', torch.tensor([.485, .456, .406]).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor([.229, .224, .225]).view(1, 3, 1, 1))

    def forward(self, x):
        return self.m((x - self.mean) / self.std).softmax(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ckpt')
    ap.add_argument('--out', default=os.path.join(ROOT, 'www', 'models', 'wear-seg.onnx'))
    ap.add_argument('--encoder', default='tu-mobilenetv3_large_100')
    ap.add_argument('--fixture', default=os.path.join(ROOT, 'test', 'wear', 'seg', 'parity.png'))
    a = ap.parse_args()
    m = train.build(a.encoder, weights=None)
    m.load_state_dict(torch.load(a.ckpt, map_location='cpu'))
    net = Wrap(m).eval()
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
    if os.path.exists(a.fixture):
        im = cv2.imread(a.fixture, cv2.IMREAD_COLOR)[..., ::-1]
        h, w = im.shape[:2]
        xi = torch.from_numpy(np.ascontiguousarray(im).astype(np.float32) / 255).permute(2, 0, 1)[None]
        with torch.no_grad():
            p = net(xi)[0].numpy()
        am = p.argmax(0)
        fx = {'w': w, 'h': h, 'counts': np.bincount(am.ravel(), minlength=5).tolist(), 'probSums': p.reshape(5, -1).sum(1).tolist(),
              'argmaxHash': int((am.ravel().astype(np.int64) * (np.arange(am.size) % 9973 + 1)).sum())}
        json.dump(fx, open(os.path.join(os.path.dirname(a.fixture), 'parity.json'), 'w'), indent=1)
        print('fixture', fx['counts'])
    with open(a.out, 'rb') as f:
        b = base64.b64encode(f.read()).decode()
    with open(a.out + '.js', 'w') as f:
        f.write('/* Tool3D wear segmentation: U-Net, MobileNetV3-Large encoder (timm ImageNet-1k weights, Apache-2.0), trained on synthetic '
                'phone photos of worn end mills (scripts/seg). Classes 0 bg, 1 tool, 2 flank wear, 3 chipping, 4 adhesion. ONNX, base64. '
                'Built by scripts/seg/export.py */\n')
        f.write('(self.Tool3D=self.Tool3D||{}).segModelB64="' + b + '";\n')
    print('wrote', a.out + '.js', os.path.getsize(a.out + '.js'), 'bytes')


if __name__ == '__main__':
    main()
