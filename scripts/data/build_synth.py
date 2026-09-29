"""Convert Blender synthetic end-mill renders (raw/synth_endmill/{img,mask,meta}) into processed/{images,masks,labelinfo}.
Mask pngs store class*50 (synth_endmill.py MASK_STEP); decoded with round(v/50). Idempotent: skips items already converted,
and items whose meta is missing (render still running). Rejects masks with no tool pixels or off-grid values (>0.5%).
  python build_synth.py <root>
"""
import glob, json, os, shutil, sys
import cv2, numpy as np

if __name__ == '__main__':
    root = sys.argv[1]
    raw = os.path.join(root, 'raw/synth_endmill')
    out = {d: os.path.join(root, 'processed', d) for d in ('images', 'masks', 'labelinfo')}
    for d in out.values(): os.makedirs(d, exist_ok=True)
    n = skip = bad = 0
    for mp in sorted(glob.glob(os.path.join(raw, 'meta/*.json'))):
        name = os.path.basename(mp)[:-5]
        sid = 'syn_' + name[len('synth_'):]
        if os.path.exists(os.path.join(out['masks'], sid + '.png')): skip += 1; continue
        ip, kp = os.path.join(raw, 'img', name + '.png'), os.path.join(raw, 'mask', name + '.png')
        img, k = cv2.imread(ip), cv2.imread(kp, cv2.IMREAD_GRAYSCALE)
        if img is None or k is None or img.shape[:2] != k.shape: bad += 1; print('unreadable', name); continue
        m = np.clip(np.round(k / 50.0), 0, 4).astype(np.uint8)
        offgrid = float((np.abs(k.astype(np.int16) - m.astype(np.int16) * 50) > 10).mean())
        if offgrid > 0.005 or (m == 1).sum() < 500: bad += 1; print('reject', name, offgrid); continue
        meta = json.load(open(mp))
        shutil.copyfile(ip, os.path.join(out['images'], sid + '.png'))
        cv2.imwrite(os.path.join(out['masks'], sid + '.png'), m)
        meta.update(source='synth_endmill', rawImage=os.path.relpath(ip, root).replace('\\', '/'))
        json.dump(meta, open(os.path.join(out['labelinfo'], sid + '.json'), 'w'))
        n += 1
    print(f'synth converted {n}, already {skip}, rejected {bad}')
