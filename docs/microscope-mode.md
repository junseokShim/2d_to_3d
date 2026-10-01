# Microscope input mode (현미경 입력)

Measures flank wear VB on microscope close-ups of one cutting edge (flank land in view, tool above the edge,
background below), like the MUDESTREDA images. Code: `www/js/micro/micro-core.js` (maths), `www/js/micro/micro-ui.js` (UI).
Test: `node test/micro/run.js`; E2E step "microscope" in `test/e2e/chrome-e2e.js`.

## Workflow
1. Step ① 입력 방식: choose **현미경**. Pick the magnification (배율: 10x-500x or 직접 입력).
2. Calibrate that magnification once (see below). The calibration is saved on the device per magnification.
3. Step ②: load one or more images per flute (F1..Fn). Several images of one flute are stacked in edge order.
4. Set 코너 위치 (corner at the start / end of the edge, or 영상에 없음) and the C zone length for VBC.
5. 3D 생성 runs the network, then the metrology panel (④) shows an edge-aligned strip per flute; drag the wear boundary to correct it.
   CSV / PDF / HTML reports carry `input_mode=microscope` and the magnification.

## Calibration (px/mm never comes from the tool diameter)
- **µm/px 입력**: type the microscope's own µm/px for this magnification. Assumed tolerance 1 % (rectangular).
- **기준 영상으로 교정** (stage micrometer or any known length): load an image of the reference, pick both ends of a line,
  enter its true length and tolerance. u_rel = hypot(tol/√3/L, √2·1 px/line px). Use the longest line that fits.
- Recalibrate when the objective, camera, zoom or image resolution changes. **교정 삭제** removes it.

## How VB is measured
1. The image is turned by 90° steps so the tool is on top (auto, from the network's tool/background probability).
2. The segmentation U-Net (seg-wear.js) runs on the whole image near native resolution (long side capped at 1600 px).
3. Cutting edge = robust straight-line fit to the tool/background boundary; chipped stretches (edge receded) are left out.
4. Wear = p(flank wear) + p(chipping) > **0.985** (`WEAR_THR`), keeping only wear connected to the edge. VB is measured normal to the edge line.
   ISO 8688-2: VBB (mean) and VBBmax in zone B, VBC in corner zone C.
5. U (k=2) combines scale (calibration), edge line fit, wear boundary (spread between thresholds 0.95 and 0.995) and one network pixel.

Why 0.985: the network was trained on MUDESTREDA with the unworn tool body *ignored*, so at argmax it spills wear into the
tool body (sharp tools read about 2× the label). The threshold was chosen on the validation tool (T3) only.

## Accuracy (MUDESTREDA test tool T10, 56 images, never used for tuning; lengths in image px because MUDESTREDA gives no px/mm)
| | argmax (before) | threshold 0.985 |
|---|---|---|
| VBmax mean abs. error | 32.2 px | 11.9 px |
| VBB mean abs. error | 11.7 px | 4.7 px |
| mean VBmax, sharp tools (label 19 px) | 54 px | 30 px |
| edge line vs label (median) | 0.74 px | 0.74 px |

Remaining bias: still about +12 px over-read on VBmax (≈ 0.015 mm at 800 px/mm). |net − label| ≤ U on 20/56 images, so U
under-states the real error; treat U as the measurement's internal spread, not a guarantee.

## Flags (shown next to each flute)
- `vb-uncertain` (VB 경계 불확실): threshold spread is large vs VB.
- `edge-ragged` / `edge-short`: edge line poorly fitted or only partly in view.
- `no-wear` (마모 밴드 없음): no land found.
- `review` (작업자 검토 필요): any of the first three; check and drag the boundary in the metrology panel.
  On the test split 28/56 images were flagged; flagged mean error 13.4 px vs 10.3 px unflagged (a weak gate).

## Limits
- Trained on one dataset (MUDESTREDA, one microscope and lighting). Other microscopes, coatings or lighting may read differently: check with the metrology panel.
- The edge must be roughly straight in the image; strong corner radii in view are fitted as one line.
- The tool must be on one side of the edge with background on the other (no silhouette/through-light images).
- Adhesion is not counted as wear. Very small lands (a few px) are below the network's resolution: use a higher magnification.
