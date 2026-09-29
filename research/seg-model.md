# Tool-wear segmentation model (AI (Seg) engine)

Model shipped: `www/models/wear-seg.onnx.js` (ONNX in base64, run by onnxruntime-web wasm in the app).
Checkpoint `.work/runs/ft4/it8000.pt` (fine-tune 4 = ft3 + app-window framing `--win .5` + boundary loss `--bw 2`), exported with
`scripts/seg/export.py --cw .5,1,3,6,6`. Before 2026-09-29 afternoon: ft3 it8000 (see the ft3 results below).
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

## Model choice ft3 vs ft4 vs ft5 (2026-09-29)

Fresh engine validation sets `.work/valset31-42` (`make_testset --seed_add i*1000+7`, made for this comparison, used for
nothing else), full engine (`.work/evalfresh.sh`), 108 worn + 24 clean sides:

| export | mean wear IoU | network ~ exact-label VBmax | worn: within 0.1 / flagged / silent-wrong | clean silent-wrong | target tool IoU s1-s4, top |
|---|---|---|---|---|---|
| ft3 it8000 (was shipped) | .286 | 53/85 | 31 / 71 / 6 | 0 | .91 .91 .71 .71 .86 |
| ft4 it7000 | .347 | 57/85 | 33 / 68 / 7 | 0 | .92 .91 .72 .72 .84 |
| **ft4 it8000 (shipped)** | **.361** | 55/85 | 32 / 72 / **4** | 0 | .92 .91 .73 .72 .84 |
| ft5 it6000 | .333 | 56/85 | 30 / 70 / 8 | 0 | .91 .90 .73 .66 .87 |
| ft5 it8000 | .333 | 56/85 | 31 / 73 / 4 | 0 | **.58** .89 .71 .70 .87 |

ft5 = ft3 + `--win .6`, pool .5 / syn .3 / mud .2, lr 2e-4 (its it8000 lost the human's side 1). Held-out `test/wear/seg`
with ft4 it8000: wear IoU .305 (passes), seg-run 13 passed / 2 failed (clean side 1 VBmax 0.245 flagged; t42 0.426 vs
0.289 silent-wrong). Parity torch vs wasm: argmax 0.000 % different.

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

## seg8 (2026-09-29): tip false fires, coverage gate, Keyence / Alicona post-processing

Fresh sets `.work/valset43-57` (tuning), `58-72` (check), `73-87` (final check); test/wear/seg never tuned on.

- **Colour tip false fires** (wear-core `tipDamage`, `continuesBelow`): a fracture face ends, a specular highlight runs on.
  Brightness of the 1.5 mm below the blob (window following the blob's slant) / blob brightness: human broken teeth
  .28-.36, synthetic false fires >= .60 -> blobs with ratio > .5 dropped. Fires on 45 fresh sets 18 -> 2; human sides 2-4
  keep 2.56 / 1.33 / 2.68 mm; held-out t41 / t44 VBC 2.97 false fires gone.
- **`seg-coverage` flag**: the network sees < 70 % of the silhouette as tool -> operator. 58-72: 12 of 18 silent-wrong
  caught, 1 of 14 confident-right sides flagged; 73-87: silent-wrong 8 -> 6, confident-right 20 -> 13.
- Tried and rejected: corner-zone exclusion from VBmax (zc .18 D): 43-57 silent 8 -> 4, but 58-72 14 -> 17.
- Remaining silent-wrong: t4 sides fully seen (toolFrac ~1) with the land boundary drawn 0.1-0.2 mm wrong (over near the
  corner, under on flute 4); held-out t42 is this type. Needs model work (boundary sharpness), not gating.
- **wear-post.js**: each segmented land also reported the way Keyence VHX (reference line on the unworn edge,
  perpendicular VB, edge recession) and Alicona EdgeQuality / WearMeasurementModule (Nd, L, Pd, Ddmax/mean, Ldmax/mean,
  Ldcmax/mean, VBmax/mean; no Ldr / volumes from one photo) report it. `wearResult.post`, metro panel card 후처리,
  test/wear/post-run.js.

## seg9 / seg10 (2026-09-29): thin-land fine-tunes ft6 / ft7, `vb-edge-on` flag, model kept at ft4

Fresh sets `.work/valset88-102` (tuning), `103-117` (check, then tuning of the flag), `118-132` (final check, run once).

- **ft6 / ft7** (seg9): ft4 + a second render pool of phone-like thin flank lands (`gen_pool_thin.py`, `--pool2/--win2`),
  boundary CE weight 4. it6000 exports: held-out `test/wear/seg` wear IoU ft4 .305, ft6 .375, ft7 .393; target tool IoU
  s1-s4, top ft4 .92 .91 .73 .72 .84, ft6 .93 .91 .72 .72 .90, ft7 .93 .91 .72 .72 .89.
- **`vb-edge-on` operator flag**: the land's widest rows (>= 90 % of VBmax, +-0.3 mm) have their ridge at |u| > .85 R on
  more than half of them -> a 1-3 px sliver multiplied by the foreshortening (x 1.9-3.5) sets VBmax (v113 t4: all four sides
  0.505). Tuned offline on 88-117 from per-side dumps (`SEG_DUMP=1` seg-run, `.work/edgesim.py`): any |u| .8-.92 / share
  .3-.7 gives the same result within 1 side. Env overrides `SEG_EDGE_ON`, `SEG_EDGE_SHARE` (experiments only).
- Silent-wrong sides (worn + clean, full engine, with the flag):

| export | 88-117 (flag off -> on) | confident-right 88-117 | **final 118-132** (off -> on) | confident-right 118-132 | mean val wear IoU 118-132 |
|---|---|---|---|---|---|
| **ft4 it8000 (kept)** | 13 -> 10 | 20 | **8 -> 7** | 8 (+3 sent to operator by the flag) | .387 |
| ft6 it6000 | 14 -> 10 | 27 | not run | | |
| ft7 it6000 (candidate) | 12 -> 8 | 25 | **11 -> 10** | 9 | .433 |

- Decision rule (set before the final check): switch only if silent-wrong goes down with held-out wear IoU and target tool
  IoU not down. ft7 lowered silent-wrong on 88-117 but not on the untouched 118-132 (7 -> 10), so **ft4 it8000 stays**;
  ft6/ft7 segment the land better (IoU) but the VBmax read from it is not more reliable.
- Remaining silent-wrong on 118-132 (ft4): t41/t42 sides read 0.1-0.2 mm over the rendered zone-B VBmax, t2chip read 0.
  As seg9 found, most of these the exact-label (oracle) pipeline also misses: VB maths, not the network.

## seg11 / seg13 (2026-09-29): real-domain retrain with human labels, model kept at ft4

Chain (all from ft4 it8000, `scripts/seg/train.py`, 3000-5000 it, bs 8, `--win .5 --bw 2`): m1 = + USB-microscope
renders (`gen_pool_micro.py`, mix key `micro`), m2 = m1 + ExtraDrey close-ups `xd_` + QIT wear `qit_w_` (tool pixels of
mud/qitw/xd ignored), no human labels. Folds v2 `g_<T>` = m2 + human labels `hum_` with tool T held out (`--exclude`);
fA = m2 + all human tools. Queues `.work/queue3.sh` (m2), `queue4.sh` (folds, fA), eval `.work/eval_v2.sh` -> `.work/ev2_*.txt`.
Eval: `fold_eval.py` whole frame, tool diameter 256 px. ft4 numbers from `.work/fold_ft4`.

Held-out human tool (each fold never saw that tool; fA row on the human tools is NOT held-out, shown for reference):

| tool | model | tool IoU | chip | damage | flank | chipDepth err | VBC err | VBmax err (mm) |
|---|---|---|---|---|---|---|---|---|
| 10Pi_1 | ft4 | .979 | .624 | .437 | | .779 | **.037** | .658 |
| | g_10Pi_1 | .980 | **.704** | .629 | 0 | **.157** | .090 | .182 |
| | fA (seen) | .981 | .845 | .652 | 0 | .136 | .090 | .213 |
| 10Pi_2 | ft4 | .978 | .674 | .351 | | .258 | .414 | .506 |
| | g_10Pi_2 | .980 | **.698** | .528 | 0 | **.101** | **.049** | .258 |
| 12Pi | ft4 | .609 | .149 | .220 | .033 | | 1.19 | **.891** |
| | g_12Pi | .928 | .177 | .546 | .011 | 2.75 | 2.63 | 1.050 |
| | fA (seen) | .884 | .182 | .553 | .168 | 2.18 | 3.32 | .592 |

Other sets (flank IoU unless noted): QIT wear val ft4 .105, m2 .149, g1/g2/g3 .144/.148/.123, fA .160.
Keyence (3) ft4 .253, m2 .232, g1/g2/g3 .183/.210/.204, fA .219 (tool IoU ft4 .553 -> fA .639).
ExtraDrey test FF / FFL: ft4 .222/.234, m2 .287/.106, g1 .292/.133, g2 .313/.149, g3 .235/.092, fA .305/.147.
Target (phone) tool IoU s1-s4, top: ft4 .92 .91 .73 .72 .84; g1 .88 .91 .73 .76 .85; g2 .93 .91 .73 .72 .83;
g3 .93 .91 .72 .76 .87; fA .88 .92 .73 .73 .77.

**Decision: not shipped, `www/models/wear-seg.onnx.js` stays ft4.** Ship rule (set before the eval): folds beat ft4 on
held-out chip and VBC for both 10Pi tools, 12Pi VBmax not worse, target tool IoU and seg-run held-out not down. Failed on:
10Pi_1 VBC .090 vs .037, 12Pi held-out VBmax 1.050 vs .891, fA target side1 .92 -> .88 and top .84 -> .77, and ExtraDrey
FFL flank .234 -> .147.

What the numbers say:
- Human labels are what helps on 10Pi: chip IoU up, chip depth error .78/.26 -> .16/.10 mm, 10Pi_2 VBC .41 -> .05 mm.
  m2 (no human labels) is not better than ft4 on 10Pi chip depth (.82/.80).
- 12Pi: the tool is found far better (.61 -> .93) but its worn flank land is painted as chip (the only chip examples come
  from 10Pi, and 12Pi's land at x2-3 zoom looks like a 10Pi chip), so VBC/VBmax get worse. Needs more human tools with
  labelled flank land (not chips) before a retrain can pass; 12Pi's px/mm is itself only +-15-25 %.
- Adding xd/qitw raises flank IoU on QIT wear and ExtraDrey FF but lowers it on FFL and Keyence.

## seg14 / seg15 (2026-09-30): land renders + retrain round, model kept at ft4

Change vs seg11/13: `gen_pool_micro.py land` adds worn peripheral-land renders (0.3-1.5 mm, matte grey, no fracture;
pool `.work/pool_micro14`, 2000 images, 961 land). Folds `g_<T>` and fA from ft4, 3000 it bs 8 lr 1e-4, mix
pool:.4,syn:.2,mud:.1,micro:.15,hum:.08,xd:.04,qitw:.03 (`.work/q14.sh`; extra sets `.work/ev14x.sh` -> `.work/ev14_*.txt`).

Held-out human tool (fA row on human tools is seen, reference only):

| tool | model | tool IoU | chip | damage | flank | chipDepth err | VBC err | VBmax err (mm) |
|---|---|---|---|---|---|---|---|---|
| 10Pi_1 | ft4 | .979 | .624 | .437 | 0 | .779 | .037 | .658 |
| | g_10Pi_1 | .981 | .700 | .592 | 0 | .139 | .070 | .329 |
| | fA (seen) | .981 | .749 | .706 | 0 | .152 | .080 | .188 |
| 10Pi_2 | ft4 | .978 | .674 | .351 | 0 | .258 | .414 | .506 |
| | g_10Pi_2 | .980 | .706 | .445 | 0 | .114 | .050 | .427 |
| | fA (seen) | .981 | .685 | .548 | 0 | .076 | .040 | .259 |
| 12Pi | ft4 | .609 | .149 | .220 | .033 | 1.283 | 1.194 | .891 |
| | g_12Pi | .803 | .160 | .541 | .010 | 2.656 | 2.659 | 1.082 |
| | fA (seen) | .958 | .186 | .601 | .117 | 2.313 | 3.210 | .682 |

Other sets, ft4 -> fA (flank IoU): QIT wear val .105 -> .162; Keyence (3) .253 -> .210 (tool .553 -> .579);
ExtraDrey FF .222 -> .259, FFL .234 -> .122 (tool .39/.60 -> .93/.94).
Target (phone) tool IoU s1-s4, top: ft4 .922 .909 .726 .720 .844; fA .929 .911 .724 .717 .771.

**Decision: not shipped, `www/models/wear-seg.onnx.js` stays ft4.** Gates: 10Pi held-out chipDepth/VBC not worse than
ft4 by > .05 mm (pass: VBC 10Pi_1 .070 vs .037), 12Pi held-out VBmax <= .891 (FAIL 1.082), target tool IoU within .02
on every view (FAIL top .844 -> .771). Tests on the merged branch (ft4): seg-run 14/1, ai-run 8/0, run 55/0,
human-run 15/3, same as main.

What the numbers say: land renders did not stop 12Pi's land being painted as chip (held-out VBC 2.66 mm, same as
seg13's 2.63); 10Pi gains from human labels repeat (chip depth .78/.26 -> .14/.11 mm). fA's top-view tool loss and
ExtraDrey FFL flank loss repeat seg13 exactly, so they come from the xd/qitw/hum mix, not from the land pool.
Next step needs labelled flank land on more human tools, not more renders.

## seg16 (2026-09-30): hybrid (fA for side views, ft4 for top), code kept, model not shipped

Code: `seg-wear.js` `createSegmenter` runs side views through `opts.sideProbs || runProbs.side` (the browser `run()` loads
`models/wear-seg-side.onnx.js`, `Tool3D.segSideModelB64`, once; without the file the sides use wear-seg). Top views and
the microscope close-up path always use `wear-seg.onnx.js`. `test/wear/ort-seg-node.js` attaches `run.side` from
`www/models/wear-seg-side.onnx.js`, or `SEG_SIDE_MODEL=<file.onnx.js>`, or `=none`. `export.py --var segSideModelB64
--parity test/wear/seg/parity-side.json` exports a side model (fA it3000: onnx 18.34 MB, .js 24.45 MB, torch/onnx max
diff 2e-6, wasm parity 0.000 %). The file is removed again in commit 5d79535; revert that commit to ship.

App-level human-run (checks passed / failed). Fold rows use the model that never saw that tool (`g_<T>` it3000 as the
side model); fA is in-sample on all three tools.

| tool | main (ft4) | held-out fold | fA (seen) |
|---|---|---|---|
| 10Pi_1 | 5/0, chip MAE .287 mm | 5/0, .194 | 5/0, .184 |
| 10Pi_2 | 5/0, chip MAE .517 mm | 5/0, .523 | 5/0, .471 |
| 12Pi + 12Pi+cal | 5/3 | 6/2: VBC now reported on 7/8 sides (was 3/8); chip MAE 1.12 -> 1.31 and VB MAE .93 -> .92 still fail | 6/2 |
| total | 15/3 | | 16/2 |

Other gates: target tool IoU sides fA .929 .911 .724 .717 vs ft4 .922 .909 .726 .720 (within .01), top stays ft4 .844.
seg-run 16/1 (the 2 new checks are side parity; the one fail is the same as main: t41-t44 silent-wrong); worn-side VBmax
mean error .068 -> .064 mm. run 55/0, ai-run 8/0, real-samples 13/0, post-run 17/0, post 50/0, metro 54/0, map3d 33/0,
capture 32/0, micro 38/0, route 5/0, keyence-run 6/0.

**Why not shipped: chrome-e2e FAIL** on the post-processing step. It needs a Keyence land line on every flute of the
sample tool (`test/wear/samples`, ~5 px/mm). With fA, flute 3 has no flank land (ft4: .067 mm flank, 1.33 mm tip damage
on both). All four sides go to the operator with both models, and nobody knows the true flank wear of that sample. To ship
anyway: revert 5d79535 and change the E2E post check to accept a flute where the network found no land. That is a gate
change, so god decides it. APK: the side model adds 24.45 MB of base64 JS (about 18 MB of weights), which roughly doubles
the seg model's share of the APK.
