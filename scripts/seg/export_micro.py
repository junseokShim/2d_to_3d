"""Export the microscope variant (train_micro.py) to ONNX + base64 JS for onnxruntime-web, loaded only in microscope mode.

Same graph as export.py (ImageNet normalisation inside, class-weight logit bias -log(w_c / w_tool), softmax), but its own
file and global (Tool3D.segMicroModelB64) and its own parity fixture (test/micro/seg-micro/parity.json, input =
test/wear/seg/parity.png), so the phone model and its fixture are untouched.
usage: export_micro.py CKPT [--out .work/wear-seg-micro.onnx] [--js www/models/wear-seg-micro.onnx.js] [--no_js]
"""
import os, sys, json, base64, argparse
import numpy as np, torch, cv2
sys.path.insert(0, os.path.dirname(__file__))
import train, export

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('ckpt')
    ap.add_argument('--out', default=os.path.join(ROOT, '.work', 'wear-seg-micro.onnx'), help='ONNX file (not shipped; .work is not in git)')
    ap.add_argument('--js', default=os.path.join(ROOT, 'www', 'models', 'wear-seg-micro.onnx.js'))
    ap.add_argument('--cw', default='.5,1,3,6,6')
    ap.add_argument('--fixture', default=os.path.join(ROOT, 'test', 'wear', 'seg', 'parity.png'))
    ap.add_argument('--fixture_out', default=os.path.join(ROOT, 'test', 'micro', 'seg-micro', 'parity.json'))
    ap.add_argument('--no_js', action='store_true', help='ONNX only (fold models for the tests)')
    a = ap.parse_args()
    m = train.build(weights=None)
    m.load_state_dict(torch.load(a.ckpt, map_location='cpu'))
    w = [float(v) for v in a.cw.split(',')]
    bias = [-float(np.log(v / w[1])) for v in w]
    net = export.Wrap(m, bias).eval()
    x = torch.rand(1, 3, 256, 320)
    torch.onnx.export(net, x, a.out, input_names=['image'], output_names=['probs'], opset_version=17, dynamo=False,
                      dynamic_axes={'image': {2: 'h', 3: 'w'}, 'probs': {2: 'h', 3: 'w'}})
    import onnx, onnxruntime as ort
    onnx.checker.check_model(a.out)
    y = ort.InferenceSession(a.out).run(None, {'image': x.numpy()})[0]
    with torch.no_grad():
        yt = net(x).numpy()
    print('onnx', os.path.getsize(a.out), 'bytes; max |p_onnx - p_torch| =', float(np.abs(y - yt).max()))
    if not a.no_js:
        im = cv2.imread(a.fixture, cv2.IMREAD_COLOR)[..., ::-1]
        h, wd = im.shape[:2]
        xi = torch.from_numpy(np.ascontiguousarray(im).astype(np.float32) / 255).permute(2, 0, 1)[None]
        with torch.no_grad():
            p = net(xi)[0].numpy()
        am = p.argmax(0)
        fx = {'w': wd, 'h': h, 'counts': np.bincount(am.ravel(), minlength=5).tolist(), 'probSums': p.reshape(5, -1).sum(1).tolist(),
              'argmaxHash': int((am.ravel().astype(np.int64) * (np.arange(am.size) % 9973 + 1)).sum()), 'ckpt': os.path.basename(os.path.dirname(a.ckpt)) + '/' + os.path.basename(a.ckpt)}
        os.makedirs(os.path.dirname(a.fixture_out), exist_ok=True)
        json.dump(fx, open(a.fixture_out, 'w'), indent=1)
        print('fixture', fx['counts'])
    if a.no_js:
        return
    with open(a.out, 'rb') as f:
        b = base64.b64encode(f.read()).decode()
    with open(a.js, 'w') as f:
        f.write('/* Tool3D wear segmentation, microscope variant: U-Net, MobileNetV3-Large encoder (timm ImageNet-1k weights, Apache-2.0), '
                'fine-tuned from the phone model on MUDESTREDA (GPL-3.0 data) + Keyence VHX close-ups (scripts/seg/train_micro.py). '
                'Classes 0 bg, 1 tool, 2 flank wear, 3 chipping, 4 adhesion. ONNX, base64. Built by scripts/seg/export_micro.py */\n')
        f.write('(self.Tool3D=self.Tool3D||{}).segMicroModelB64="' + b + '";\n')
    print('wrote', a.js, os.path.getsize(a.js), 'bytes')


if __name__ == '__main__':
    main()
