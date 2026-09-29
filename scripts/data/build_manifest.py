"""Write <root>/manifest.json and <root>/README.md from processed/{images,masks,labelinfo} and qa/*/rejects.json.
Splits are by source and tool (never by frame of one tool across splits), target_* is eval-only:
  syn    : render index % 10 == 0 -> val, else train (each render is its own random tool)
  mud    : tool T3 -> val, T10 -> test, others train
  matwi  : Set 3 -> val, Set 17 -> test (RVS304, 2-tooth), others train
  qit    : cutting edge 4 -> val, edges 1-3 train (one tool only; tool-only labels)
  aqifi  : train (2 images)
  xd     : ExtraDrey, split by insert (all edges of one CT0XX together): CT003+CT005 -> val, CT006+CT013 -> test (~72/14/14 %), new inserts train
  target : eval (the human's real photos; never train on them)
  qitw   : qit_w_* VBmax-guided wear labels on QIT side views (same frames as qit_*): edge 4 -> val, others train
  hum    : human USB-microscope photos, eval only; item 'fold' = tool (10Pi_1 / 10Pi_2 / 12Pi) for leave-one-tool-out
  python build_manifest.py <root>
"""
import glob, json, os, re, sys
from datetime import date
import cv2, numpy as np

CLASSES = {0: 'background', 1: 'tool', 2: 'flank wear (VB)', 3: 'chipping/breakage', 4: 'adhesion/BUE', 255: 'ignore (not supervised)'}
SOURCES = {
    'syn': dict(source='synth_endmill', name='Blender synthetic end mills (this project)', licence='project-internal (generated)',
                url='scripts/data/synth_endmill.py', toolType='solid end mill 2-6 flutes', view='side/end/oblique', labelQuality='rendered-exact'),
    'mud': dict(source='mudestreda', name='Mudestreda (Truchan et al., ICONIP 2023)', licence='GPL-3.0-or-later', url='https://doi.org/10.5281/zenodo.8238653',
                toolType='milling tool, flank face', view='side (flank, microscope 1550x500)', labelQuality='semi-auto (label_mudestreda.py v3), all graded zoomed'),
    'matwi': dict(source='matwi', name='MATWI (De Pauw, Jacobs, Goedeme)', licence='CC-BY-SA-4.0', url='https://doi.org/10.48804/GK6LHH',
                  toolType='15 mm indexable end mill insert', view='flank (microscope crop)', labelQuality='per image: wear-verified or tool-only'),
    'qit': dict(source='qit_cemc', name='QIT-CEMC (Qilu Institute of Technology)', licence='MIT (github.com/wwz456/QIT-CEMC-dataset)',
                url='https://ndownloader.figshare.com/files/50069727', toolType='coated 4-flute end mill', view='side + end per edge, 4.5X, green backdrop',
                labelQuality='tool-only'),
    'aqifi': dict(source='aqifi_endmill', name='Desktop-CNC end-mill wear (Zenodo 21845441)', licence='CC-BY-4.0', url='https://doi.org/10.5281/zenodo.21845441',
                  toolType='3.175 mm 2-flute end mill', view='end', labelQuality='semi-auto (SAM + manual band)'),
    'qitw': dict(source='qit_cemc_wear', name='QIT-CEMC side views, wear band guided by expert VBmax (this project)', licence='MIT (github.com/wwz456/QIT-CEMC-dataset)',
                 url='scripts/data/label_qit_wear.py', toolType='coated 4-flute end mill', view='side (peripheral edge), 4.5X, green backdrop',
                 labelQuality='VBmax-guided band'),
    'hum': dict(source='human_usb_microscope', name="Human's USB-microscope photos (10Pi_1, 10Pi_2, 12Pi)", licence='project-internal, eval only',
                url='datasets/human_samples/공구 이미지; reference/human_gt.json', toolType='solid end mill D10 / D12', view='side (tip up) + top',
                labelQuality='manual (hand ROIs/polygons, zoom-checked)'),
    'xd': dict(source='extradrey', name='ExtraDrey (Schibsdat, TUHH IPMT, 2026)', licence='Public Domain Mark 1.0', url='https://doi.org/10.15480/882.17237',
               toolType='TiAlN-coated turning insert CNMG (longitudinal turning, C45+N / X5CrNi18-10)', view='flank 150x/100x, rake face (microscope 2048x1536)',
               labelQuality='expert masks (dataset); rake face tool-only'),
    'target': dict(source='target', name="Human's real phone photos (repo test/wear/samples)", licence='project-internal, eval only', url='test/wear/samples',
                   toolType='end mill (target domain)', view='4 sides + top', labelQuality='manual polygons'),
}


def split_of(pre, sid, info):
    if pre == 'syn': return 'val' if int(sid.rsplit('_', 1)[1]) % 10 == 0 else 'train'
    if pre == 'mud':
        t = re.match(r'mud_T(\d+)', sid).group(1)
        return {'3': 'val', '10': 'test'}.get(t, 'train')
    if pre == 'matwi':
        s = re.match(r'matwi_S(\d+)_', sid).group(1)
        return {'3': 'val', '17': 'test'}.get(s, 'train')
    if pre == 'qit': return 'val' if info.get('edge') == 4 else 'train'
    if pre == 'qitw': return 'val' if info.get('edge') == 4 else 'train'
    if pre in ('target', 'hum'): return 'eval'
    if pre == 'xd': return {3: 'val', 5: 'val', 6: 'test', 13: 'test'}.get(int(re.match(r'xd_CT(\d+)_', sid).group(1)), 'train')
    return 'train'


def tool_of(pre, sid, info):
    if pre == 'syn': return sid
    if pre == 'mud': return re.match(r'mud_(T\d+)', sid).group(1)
    if pre == 'matwi': return 'Set' + re.match(r'matwi_S(\d+)_', sid).group(1)
    if pre in ('qit', 'qitw'): return 'qit_tool'
    if pre == 'hum': return info.get('tool')
    if pre == 'xd': return info.get('toolId') or sid.split('_')[1]
    return sid


if __name__ == '__main__':
    root = sys.argv[1]
    P = os.path.join(root, 'processed')
    items, per = [], {}
    for mp in sorted(glob.glob(os.path.join(P, 'masks/*.png'))):
        sid = os.path.basename(mp)[:-4]; pre = 'qitw' if sid.startswith('qit_w_') else sid.split('_')[0]
        if pre not in SOURCES: continue
        lp = os.path.join(P, 'labelinfo', sid + '.json')
        info = json.load(open(lp)) if os.path.exists(lp) else {}
        m = cv2.imread(mp, cv2.IMREAD_GRAYSCALE)
        vals, cnt = np.unique(m, return_counts=True); px = {int(v): int(c) for v, c in zip(vals, cnt)}
        sp = split_of(pre, sid, info)
        lq = info.get('labelQuality') or SOURCES[pre]['labelQuality']
        pxmm = info.get('pxPerMm') or info.get('pxPerMmEst')
        it = dict(id=sid, image='processed/images/%s.png' % sid, mask='processed/masks/%s.png' % sid, source=SOURCES[pre]['source'], tool=tool_of(pre, sid, info),
                  split=sp, labelQuality=lq, view=info.get('view'), pxPerMm=pxmm, h=int(m.shape[0]), w=int(m.shape[1]), pixels={str(k): v for k, v in px.items()})
        for k in ('vbUm', 'vbMm', 'vbMaxMm', 'wearType', 'state', 'wearState', 'cycle', 'edge', 'set', 'timeS', 'magnification', 'material'):
            if info.get(k) is not None: it[k] = info[k]
        if pre == 'hum': it['fold'] = info.get('tool')
        if pre == 'qitw': it['toolOnlyId'] = info.get('toolOnlyId')
        items.append(it)
        s = per.setdefault(pre, dict(n=0, splits={}, quality={}, pixels={}))
        s['n'] += 1; s['splits'][sp] = s['splits'].get(sp, 0) + 1; s['quality'][lq] = s['quality'].get(lq, 0) + 1
        for k, v in px.items(): s['pixels'][str(k)] = s['pixels'].get(str(k), 0) + v
    qa = {}
    for pre, meta in SOURCES.items():
        rj = os.path.join(root, 'qa', meta['source'], 'rejects.json')
        if os.path.exists(rj):
            r = json.load(open(rj)); n = r.get('sampled', 0); k = len(r.get('rejected', []))
            qa[pre] = dict(sampled=n, rejected=k, rate=round(k / n, 3) if n else None, notes=r.get('notes', ''))
    sources = {pre: dict(SOURCES[pre], **per.get(pre, {}), qa=qa.get(pre)) for pre in SOURCES if pre in per}
    man = dict(name='toolwear-seg', created=str(date.today()), classes={str(k): v for k, v in CLASSES.items()},
               notes='255 = ignore: exclude from loss and metrics. target_* is eval only. Splits are by tool/set (see scripts/data/build_manifest.py).',
               sources=sources, items=items)
    json.dump(man, open(os.path.join(root, 'manifest.json'), 'w'), indent=1)

    L = ['# Tool-wear segmentation dataset', '', 'Root: `%s`. Built %s by `scripts/data/build_manifest.py` (repo 2d_to_3d).' % (root.replace('\\', '/'), date.today()), '',
         '## Classes', '', '| value | class |', '|---|---|'] + ['| %d | %s |' % (k, v) for k, v in CLASSES.items()] + [
         '', '`255` pixels carry no label (uncertain wear boundary, glare, defocus, edges of SAM masks, wear zones of tool-only images). Mask them out of loss and metrics.', '',
         '## Sources', '', '| prefix | source | licence | images | train/val/test/eval | label quality | QA 10% sample: rejected |', '|---|---|---|---|---|---|---|']
    for pre, s in sources.items():
        sp = '/'.join(str(s['splits'].get(k, 0)) for k in ('train', 'val', 'test', 'eval'))
        q = s.get('qa'); qs = '%d/%d (%.1f%%)' % (q['rejected'], q['sampled'], 100 * q['rate']) if q and q['sampled'] else 'n/a'
        L.append('| `%s_` | [%s](%s) | %s | %d | %s | %s | %s |' % (pre, s['name'], s['url'], s['licence'], s['n'], sp, '; '.join('%s %d' % kv for kv in s['quality'].items()), qs))
    L += ['', '## Pixel counts per class', '', '| prefix | ' + ' | '.join(CLASSES[k] for k in CLASSES) + ' |', '|---|' + '---|' * len(CLASSES)]
    tot = {}
    for pre, s in sources.items():
        L.append('| `%s_` | ' % pre + ' | '.join('{:,}'.format(s['pixels'].get(str(k), 0)) for k in CLASSES) + ' |')
        for k in CLASSES: tot[k] = tot.get(k, 0) + s['pixels'].get(str(k), 0)
    L.append('| **all** | ' + ' | '.join('{:,}'.format(tot[k]) for k in CLASSES) + ' |')
    L += ['', '## Notes per source', '',
          '- **syn**: Blender renders, masks exact. QA flagged a few unrealistic tool shapes (kept; labels still exact). Chipping (3) and adhesion (4) exist only here and in mud/target.',
          '- **mud**: flank wear bands by DP wear-land tracer (v3); tools T1/T2 skipped (land not visible), 8 manual drops; T8R13B1-4 breakage = class 3; adhesion on worn span = 4.',
          '- **matwi**: automatic band did not track the expert VB (per-set Pearson r mostly < 0.6), so images of failing sets are **tool-only**: wear zone below the edge = 255, no class 2. Only images in sets with r >= 0.6 and a consistent px/um ratio keep class 2 (`wear-verified`, band regularised). Expert VB (um) and type are in each item.',
          '- **qit**: green backdrop, 640x480. Wear land not reliably visible, so **tool-only**: 90 px band along every tool edge = 255. QMS3D software screenshots skipped. Expert VBmax / area per edge in each item.',
          '- **qitw**: 72 QIT side views (frames also in `qit_` as tool-only): class 2 = band of 0.8 x VBmax x 95 px/mm along the lower cutting edge (px/mm estimated by hand, +-20 %), 0.8-1.25 x and unverified edge stretches = 255.',
          '- **hum**: the human USB-microscope photos, eval only; per-image VBC / chip depth / VBmax in `reference/human_gt.json`; leave-one-tool-out by item `fold`.',
          '- **aqifi**: two end-view photos (new/worn).',
          '- **xd**: ExtraDrey expert masks (TUHH): flank face FF 150x / FFL 100x fully labelled (85 wear -> 2, 170 tool -> 1, 255 adhesion -> 4); rake face RF only marks the tool area, so after 0 s the tool within 0.5 mm of its outline = 255 (crater not labelled). px/mm from the 100 um scale bar (bar area = 255). VB_Max (um) per edge/time in each item. Split by insert.',
          '- **target**: the real photos the app must work on. Eval only.',
          '', 'Licences: ExtraDrey is Public Domain Mark 1.0 (no restrictions). MATWI is CC-BY-SA (derived masks share-alike), Mudestreda is GPL-3.0-or-later (copyleft; keep masks/data separate from app code and credit the source). Cite the papers above when publishing.',
          '', 'Per-item metadata: `manifest.json` -> `items[]` (id, image, mask, source, tool, split, labelQuality, view, pxPerMm, pixels per class, expert wear values).',
          'QA sheets and reject lists: `qa/<source>/`. Scripts: `scripts/data/label_*.py`, `qa_sample.py`, `overlay.py`, `build_synth.py`.']
    open(os.path.join(root, 'README.md'), 'w', encoding='utf-8').write('\n'.join(L) + '\n')
    print(json.dumps({p: dict(n=s['n'], splits=s['splits'], quality=s['quality']) for p, s in sources.items()}, indent=0))
