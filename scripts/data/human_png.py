"""JPG -> PNG cache of the human's USB-microscope samples (Node tests read PNG only).
Usage: python scripts/data/human_png.py [SRC] [DST]
SRC default C:/agent_research_team/datasets/human_samples/공구 이미지, DST default C:/agent_research_team/datasets/human_samples/png
Names: <tool>/<file stem>.png (e.g. 10Pi_1/10-1-1.png)."""
import os, sys
from PIL import Image
src = sys.argv[1] if len(sys.argv) > 1 else 'C:/agent_research_team/datasets/human_samples/공구 이미지'
dst = sys.argv[2] if len(sys.argv) > 2 else 'C:/agent_research_team/datasets/human_samples/png'
n = 0
for tool in sorted(os.listdir(src)):
    d = os.path.join(src, tool)
    if not os.path.isdir(d): continue
    os.makedirs(os.path.join(dst, tool), exist_ok=True)
    for f in sorted(os.listdir(d)):
        if not f.lower().endswith(('.jpg', '.jpeg')): continue
        Image.open(os.path.join(d, f)).convert('RGB').save(os.path.join(dst, tool, os.path.splitext(f)[0] + '.png'))
        n += 1
print(n, 'images ->', dst)
