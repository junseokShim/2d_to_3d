# Microscope photos: use the normal camera flow

There is no separate microscope input mode any more (removed after release 7cc8bfe, at the human's request).
Every photo, from a phone camera or a USB / bench microscope, goes through the same camera pipeline:

1. Step ①: flutes and tool diameter φ. There is no input-mode, magnification or image-type choice.
2. Step ②: one side photo per flute (tip up) and optionally a top view, as for phone photos.
3. 3D 생성: wear-core alignment -> seg-wear (U-Net `models/wear-seg.onnx.js`, ft4, the one model for side and top views)
   -> VB / VBC / tip damage per flute -> the metrology panel (④) and post-processing (⑤ Keyence / Alicona style).

The scale (px/mm) comes from the tool silhouette and the diameter φ, like a phone photo. A tool wider than the frame
(the tool's two edges not both in view) has no silhouette scale: its sides are flagged `tool-cut-off` and go to the
operator; the numbers in mm are then a lower bound.

## What was removed and why
- `www/js/micro/micro-ui.js` + `css/micro.css` (step ① 입력 방식 스마트폰/현미경, 배율 + µm/px calibration, 영상 종류
  override, per-flute image stacks) and `window.runCameraPath`. The human found the plain camera path of 565a317 read their
  microscope photos best; the microscope routing added a second way to get different numbers from the same photo.
- `models/wear-seg-side.onnx.js` (seg14 fA, side views only): on the human's photos it labelled the worn land as chipping
  (flank IoU ~.01) and left the flank land empty. ft4 (`wear-seg.onnx.js`) is used for every view.

`www/js/micro/micro-core.js` stays as a library (close-up edge maths, Keyence reference-line VB, calibration store) for the
tests in `test/micro/` (Keyence / MUDESTREDA regression); nothing in the UI calls it.

The A/B check of this change (565a317 camera path vs this build on the human's 27 photos + 10 QIT side views) is in
`docs/debug-p6.md`.
