"""Export the wear-detection feature backbone to ONNX (www/models/wear-backbone.onnx).

ResNet-18, torchvision ImageNet-1k weights (BSD-3-Clause), truncated after layer3.
Output = PatchCore-style locally aware patch features at stride 8:
  concat(layer2, upsample2x(layer3)) -> 3x3 average pool  => (1, 384, H/8, W/8)
Input: (1, 3, H, W) float RGB in 0..1 (ImageNet normalisation is inside the graph). H, W multiples of 16.
Run: .work/venv/Scripts/python scripts/ai/export_backbone.py
"""
import os, torch, torch.nn as nn, torch.nn.functional as F, torchvision

class Backbone(nn.Module):
    def __init__(self):
        super().__init__()
        m = torchvision.models.resnet18(weights=torchvision.models.ResNet18_Weights.IMAGENET1K_V1).eval()
        self.stem = nn.Sequential(m.conv1, m.bn1, m.relu, m.maxpool)
        self.l1, self.l2, self.l3 = m.layer1, m.layer2, m.layer3
        self.register_buffer('mean', torch.tensor([.485, .456, .406]).view(1, 3, 1, 1))
        self.register_buffer('std', torch.tensor([.229, .224, .225]).view(1, 3, 1, 1))
    def forward(self, x):
        x = (x - self.mean) / self.std
        f2 = self.l2(self.l1(self.stem(x)))
        f3 = self.l3(f2)
        f = torch.cat([f2, F.interpolate(f3, size=f2.shape[-2:], mode='bilinear', align_corners=False)], 1)
        return F.avg_pool2d(f, 3, 1, 1, count_include_pad=False)

out = os.path.join(os.path.dirname(__file__), '..', '..', 'www', 'models', 'wear-backbone.onnx')
net = Backbone().eval()
x = torch.rand(1, 3, 256, 320)
torch.onnx.export(net, x, out, input_names=['image'], output_names=['features'], opset_version=17, dynamo=False,
                  dynamic_axes={'image': {2: 'h', 3: 'w'}, 'features': {2: 'fh', 3: 'fw'}})
import onnx, onnxruntime as ort, numpy as np
onnx.checker.check_model(out)
y = ort.InferenceSession(out).run(None, {'image': x.numpy()})[0]
print('saved', out, os.path.getsize(out), 'bytes; out', y.shape, 'max abs diff vs torch', float(np.abs(y - net(x).detach().numpy()).max()))
# the app loads the model as a <script> (works from file:// and Capacitor): wrap it as base64 and drop the raw .onnx
import base64
with open(out, 'rb') as f: b = base64.b64encode(f.read()).decode()
with open(out + '.js', 'w') as f:
    f.write('/* Tool3D wear backbone: ResNet-18 (torchvision ImageNet-1k, BSD-3-Clause) up to layer3, PatchCore features. ONNX, base64. Built by scripts/ai/export_backbone.py */\n')
    f.write('(self.Tool3D=self.Tool3D||{}).aiModelB64="' + b + '";\n')
os.remove(out)
print('wrote', out + '.js')
