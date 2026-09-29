# Tool-wear segmentation model (AI (Seg) engine)

Model shipped: `www/models/wear-seg.onnx.js` (ONNX in base64, run by onnxruntime-web wasm in the app).
Checkpoint `.work/runs/ft3/best.pt` (= iteration 8000 of fine-tune 3), exported with `scripts/seg/export.py --cw .5,1,3,6,6`.
Status 2026-09-29: good at finding the tool and wear on synthetic and public data; VB (flank wear land width) accuracy is
about ±0.1 mm on synthetic tools; sides the engine cannot trust are sent to the operator. Not validated against a
reference instrument (Alicona / Keyence) on real tools: there are none yet.

## What it does

Per side photo, wear-core aligns the tool (axis, tip, px/mm). `seg-wear.js` cuts a window around the tip (0.3 D above the
tip to the end of the wear zone + 0.3 D, 1.6 D wide, scaled so D = 128-256 px), runs the network, and reads:

- classes: 0 background, 1 tool, 2 flank wear, 3 chipping / breakage, 4 adhesion / built-up edge;
- VB per row = the flank band's thickness normal to the cutting edge, corrected for the cylinder's foreshortening, running
  median over ±0.3 mm along the axis; VBmax per flute;
- chipping that reaches the tip → tip damage (VBC), counted in VBmax. The network's chipping class misses broken end
  teeth on real photos (the human's D10: chip area 0 on every side, VBmax ~0.2 mm), so wear-core's colour tip stage
  (`tipDamage`: bright fresh fracture faces in the tip zone) runs on the same strip and the deeper of the two is the VBC;
  a colour blob the network calls background is dropped. Any tip damage sends the side to the operator;
- areas per class (mm², projected).

## Architecture

U-Net, MobileNetV3-Large encoder (timm `mobilenetv3_large_100`, ImageNet-1k weights, Apache-2.0),
segmentation_models_pytorch decoder. 4.58 M parameters, ONNX 18.3 MB (24.5 MB as base64 JS). Input RGB 0..1, any size
that is a multiple of 32; ImageNet normalisation and a per-class logit bias are inside the graph; output softmax (5 classes).
Loss: class-weighted cross-entropy (bg .5, tool 1, flank 3, chip 6, adhesion 6) + Dice, label 255 ignored.
The export adds a logit bias of −log(w_c / w_tool), which undoes the class weights so thin lands are not painted too wide.
A pixel-count calibration (`--calib`) was tried: it hit its ±2 clamp and read VB worse on the engine validation sets
(14/23 vs 16/22 sides within tolerance), so it is not used.

## Data

| source | licence | images used (train/val) | labels |
|---|---|---|---|
| GPU synthetic pool (`scripts/seg/render.py`, this project) | project-internal | ~1940 renders, 1 in 20 held out | exact |
| Blender synthetic end mills `syn_` (this project) | project-internal | 1350 / 150 | exact |
| MUDESTREDA `mud_` (Truchan et al., ICONIP 2023, zenodo 8238653) | **GPL-3.0-or-later** | 301 / 51 (T3 val, T10 test) | semi-automatic (DP wear-land tracer v3), graded |
| QIT-CEMC `qit_` (github wwz456/QIT-CEMC-dataset) | MIT | 313 / 97 | tool only (wear zone ignored) |
| Desktop-CNC end mill `aqifi_` (zenodo 21845441) | CC-BY-4.0 | 2 / 0 | semi-automatic |
| human's phone photos `target_` (test/wear/samples) | project-internal | eval only (5) | tool polygons only |

MATWI (CC-BY-SA-4.0) was downloaded but dropped: its automatic wear bands did not track the expert VB.
Dataset card: `C:/agent_research_team/datasets/toolwear/README.md`.

**Licence note.** MUDESTREDA is GPL-3.0-or-later. The weights were trained on it (20-35 % of samples in the fine-tunes).
Whether trained weights are a derivative work of the data is legally unsettled. Before distributing the app commercially,
either get legal advice, or retrain without `mud_` (it contributes the only real adhesion labels). Credit the dataset in any
publication. The GPL data itself is not shipped with the app.

## Training chain

| run | from | iterations | mix (sampling weights) | notes |
|---|---|---|---|---|
| pre1 | ImageNet | 4500 used | pool 1 | synthetic pretraining |
| ft1 | pre1 | 8000 | pool .5, syn .4, mud .1 | |
| ft2 | ft1 | 6000 used | pool .45, syn .35, mud .2 | learned adhesion and chipping; target tool IoU fell (.91 → .33 on one side) |
| ft3 | ft2 it6000 | 8000 | pool .45, syn .35, mud .2, `--ignore_tool mud` | MUDESTREDA tool pixels ignored (its grey insert face looked like the grey mat in the human's photos) |

RTX 3060, bf16, batch 12, 384 px crops, ~0.23 s/iteration.

## Results (ft3 it8000)

Pixel IoU on the validation splits (160 samples each):

| val set | bg | tool | flank | chip | adhesion |
|---|---|---|---|---|---|
| synthetic pool | .983 | .932 | .373 | .538 | .186 |
| syn_ (Blender) | .989 | .957 | .327 | .240 | .575 |
| mud_ (real, semi-auto labels) | .941 | .894 | .515 | – (none in val) | .543 |

Human's photos (tool IoU in the network window; wear on the background with the app's baked-in yellow marks excluded):
side1 .91 / 0.01 mm², side2 .91 / 0.77, side3 .71 / 0.68, side4 .71 / 0.34, top .86 / 0.01. The background wear is on the
tool rim, not on the mat (overlay inspected). ft1 had .69-.91 tool IoU on the same photos.

Engine VB (test/wear/seg-run.js, full pipeline alignment → network → VB), three engine validation sets (`.work/valset1-3`,
`make_testset --seed_add`) used for all decisions, and the held-out set `test/wear/seg` (not tuned on):

| set | network reads side | VBmax within 0.1 mm (±35 %) of exact-label VBmax | mean abs error | worn sides: within 0.1 mm of rendered VB / flagged / silent-wrong | clean sides: < 0.1 / flagged / silent-wrong |
|---|---|---|---|---|---|
| valset1 | 9/11 | 5/7 | 0.081 mm | 1 / 8 / 0 | 2 / 0 / 0 |
| valset2 | 8/11 | 6/7 | 0.092 mm | 5 / 4 / 0 | 1 / 1 / 0 |
| valset3 | 9/11 | 5/8 | 0.196 mm | 4 / 5 / 0 | 1 / 1 / 0 |
| **held-out** | 10/11 | 5/8 | 0.085 mm | **1 / 5 / 3** | 1 / 1 / 0 |

Held-out silent-wrong sides: t4 side1 0.000 vs 0.200 mm, side2 0.428 vs 0.233, side4 0.429 vs 0.300.
Held-out mean wear IoU .240 (check wants ≥ .30, fails); seg-run.js totals: 9 passed, 3 failed.
Parity torch vs onnxruntime-web: argmax differs on 0.000 % of pixels.

## Operator flags (needsOperator reasons)

A side is sent to the operator (never a confident number) when:

- `low-resolution`: < 15 px/mm;
- `tip-damage`: chipping / broken tooth found at the tip;
- `tip-disagree` (seg-wear): the network's chips and the colour tip stage disagree (one ≥ 0.5 mm deep, the other < half
  of it). On the human's photos (sides 2-4: colour 2.56 / 1.33 / 2.68 mm, network 0) this fires; on synthetic renders
  the colour stage also fires on ~6 of 75 sides (specular streaks on the flute margins, VBC ~1.5-3 mm, all flagged);
- `tip-misplaced` (seg-wear): the strip above the detected tip line is > 50 % tool, meaning the alignment put the tip too low
  and the worn corner is outside the window (valset1 t4 read 0 on every side because of this);
- `ai-fallback` (wear-core): the network could not read the side (it saw < 50 % of the tool) and the classic colour engine
  measured it; that engine read 1.1-4.9 mm on clean and worn validation sides;
- `vb-outlier` (wear-core): a side's flank VB is > 1.6× and > 0.1 mm above the median of the tool's other sides.

## Limits

- No real tool with a reference measurement: all VB accuracy numbers are on synthetic renders. Real-photo evidence is
  qualitative (the human's worn D10: damage found on all 4 sides, tool read on 4/4).
- Flank IoU is .33-.52: land edges are soft at 13-20 px/mm; VB can be off by 0.1-0.2 mm on single sides, and a wrong side is not always flagged (held-out t4).
- Alignment faults upstream (tip misplaced, silhouette lost) are the main cause of wrong VB; the flags catch the tip case
  only when the window still contains the image area above the tip.
- Chipping in val: synthetic only; MUDESTREDA val has no chipping pixels.
- Adhesion on real photos comes only from MUDESTREDA (flat inserts, not end mills).

## Reproduce

```
.work/venv/Scripts/python.exe scripts/seg/train.py --init .work/runs/ft2/it6000.pt --out .work/runs/ft3 --iters 8000 --bs 12 --lr 3e-4 --warm .03 --workers 8 --mix pool:.45,syn:.35,mud:.2 --ignore_tool mud
.work/venv/Scripts/python.exe scripts/seg/export.py .work/runs/ft3/best.pt --cw .5,1,3,6,6
node test/wear/seg-run.js                       # held-out set; SEG_SET=.work/valset1 for another set, SEG_MODEL=<file.onnx.js> for another export
node test/wear/seg-diag.js <outdir>             # overlays per side
```
