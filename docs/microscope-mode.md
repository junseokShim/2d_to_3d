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

## View routing: flank close-up vs side view of the whole tool
Step ① **영상 종류** (default 자동 감지) decides where the images go; each flute slot shows the detected view.
- **절삭날 근접 (여유면)**: one cutting edge fills the frame (Keyence VHX, MUDESTREDA) -> measured here (below).
- **공구 전체 측면**: a low-magnification USB-microscope photo of the whole tool side (tip at the top, silhouette, like a phone
  photo) -> the camera side-view pipeline (wear-core alignment -> seg-wear -> VB / VBC at the tip) at the magnification's
  calibrated px/mm (`window.runCameraPath`). Before this, micro-core turned these photos 180°, fitted the tip line as the
  cutting edge and reported VB 0 (no-wear) on all.
- Auto detection uses the field of view in tool diameters: long image side / calibrated px/mm >= 0.4 x D -> side view
  (`VIEW_FOV`, micro-core `detectView`). Human USB photos 0.43-2.07 D (27/27 side), Keyence 0.1-0.3 D at D 10 (5/5 close-up),
  MUDESTREDA <= 0.19 D (408/408). A small tool at low magnification near the boundary: set the view by hand.
  Mixed views on one run are all measured as close-ups (message shown).
- Human USB side views (`node test/micro/route.js`, report vs human_gt): labelled damage read as a silent 0 on 22/24 sides
  before, 3/24 after; |VB - labelled max(VBC, VBmax)| mean 1.74 mm before, 0.86 mm after.

## Photo quality check (never blocks)
The quality badge (js/enhance/quality.js) advises only: verdict pass | warn (`severe` marks a check at fail level) and the
measurement always runs. A known px/mm (microscope calibration) replaces the silhouette estimate; close-ups skip the
whole-tool silhouette check instead of asking for a re-shoot.

## Calibration (px/mm never comes from the tool diameter)
- **µm/px 입력**: type the microscope's own µm/px for this magnification. Assumed tolerance 1 % (rectangular).
- **기준 영상으로 교정** (stage micrometer or any known length): load an image of the reference, pick both ends of a line,
  enter its true length and tolerance. u_rel = hypot(tol/√3/L, √2·1 px/line px). Use the longest line that fits.
- Recalibrate when the objective, camera, zoom or image resolution changes. **교정 삭제** removes it.

## How VB is measured
1. The image is turned by 90° steps so the tool is on top (auto, from the network's tool/background probability).
2. The segmentation U-Net (seg-wear.js) runs on the whole image near native resolution (long side capped at 1600 px).
3. Cutting edge = robust straight-line fit to the tool/background boundary; chipped stretches (edge receded) are left out.
   **VB reference (`vbRef`, default `reference`, Keyence style):** the edge is refitted on the unworn stretches only (land <= max(3 px, 15% of the widest land)) and VB is measured from that line, but only when the worn edge lies outside it by more than max(3 px, 2 sigma); otherwise the fitted edge is used (`edge`). Both methods are reported (`alt` rows, `ref.source`). On the Keyence VHX masks VB at the arrow is +0.7/+1.4/+4.2 % from Keyence with `reference` versus +0.7/+20.5/+33.1 % with `edge`; MUDESTREDA results are unchanged (the reference line never triggers there).
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
- The network is the phone model (MUDESTREDA fine-tune ft4). On Keyence VHX colour images of a coated insert it finds no wear (flag `no-wear`): measure those from a hand mask or the metrology panel. A microscope fine-tune was tried and not shipped (research/keyence-reference.md, 'Microscope fine-tune'); the app looks for `models/wear-seg-micro.onnx.js` and falls back to the phone model.
- Trained on one dataset (MUDESTREDA, one microscope and lighting). Other microscopes, coatings or lighting may read differently: check with the metrology panel.
- The edge must be roughly straight in the image; strong corner radii in view are fitted as one line.
- Close-ups: the tool must be on one side of the edge with background on the other (whole-tool side views are routed to the camera pipeline).
- Adhesion is not counted as wear. Very small lands (a few px) are below the network's resolution: use a higher magnification.
