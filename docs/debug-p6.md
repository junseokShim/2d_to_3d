# Phase 6: one camera path, ft4 everywhere, flank land back (A/B vs 565a317)

Human report on 7cc8bfe: VB segmentation finds nothing; microscope photos through the plain camera path of 565a317 read best.
Decision: no camera / microscope distinction, one camera pipeline, ft4 (`models/wear-seg.onnx.js`) for every view.

## Test set and method
Camera path as the app runs it (`W.measureAsync` + `seg-wear`, no px/mm: scale from the silhouette and φ) on
- the human's 27 USB-microscope photos (`datasets/human_samples/png`: 3 tools x 4 sides x 2 shots + a top view per tool;
  the 24 side views are scored), labels `datasets/toolwear/reference/human_gt.json`;
- 10 QIT-CEMC close-ups (`qit_w_*`: the 7 val + 3 train images; expert VBmax; one flute, φ 10 assumed).
"Land found" = the side reports a flank land (vbFlankMaxMm > 0). Labels: 10Pi_1 / 10Pi_2 have no flank land (chipped
corners only, specular streaks on the flank are intact coating); 12Pi has a land (VB 1.06-1.35 mm) + chips; QIT all worn.

## Result
| build | 10Pi land (label: none) | 12Pi land | 12Pi VB err | 12Pi VBC err | 10Pi VBC err | QIT land | QIT VB err |
|---|---|---|---|---|---|---|---|
| 565a317 (a) | 13/16 false (3 sides not measured) | 7/8 | 0.99 | 1.25 | 0.66 | 4/10 | 0.31 |
| 7cc8bfe (fA side model) | 3/16 | 6/8 | 0.92 | 1.32 | 0.33 | 0/10 | 0.17 |
| 7cc8bfe with ft4 on sides | 4/16 | 2/8 | 1.06 | 0.90 | 0.40 | 0/10 | 0.17 |
| this build (b) | 4/16 | 7/8 | 0.84 | 1.11 | 0.40 | 4/10 | 0.30 |

Errors are mean |measured - label| in mm (VB vs flank land width, VBC vs chip depth). QIT "VB err" of a build that finds no
land is the labelled VB itself (reads 0). All 12Pi values are in camera mode: the D12 tool is wider than the frame, the
silhouette gives no scale (px/mm read 19-35 vs labelled 67-123), every side is flagged `tool-cut-off` and goes to the
operator; the land is found, its size in mm is not trustworthy without a known scale.

## Why 7cc8bfe found less land (ablation, same ft4 model)
- the fA side model: labels the land as chipping (flank IoU ~.01).
- blob sorting (camfix: land / chip / specular streak, `classifyBlobs` + band gate): the streak test (`continuesBelow`)
  also removes the land on cut-off close-ups (12Pi pieces classed as streaks). Off everywhere: 12Pi 4/8 but 10Pi false land
  15/16 (the streaks it was made for).
- close-up backdrop alignment (camfix `backdropAlign`): on a tool wider than the frame it frames the network window
  differently; ft4 then reads the 12Pi land as chipping, and on QIT the window holds only 35 % tool -> classic fallback, 0.
- both off = 565a317 exactly (24/34 sides with land).

Overlays (network window, green = flank land class 2, red = chipping, blue = adhesion, yellow = lower edge of the land per
column) and per-side rows: `datasets/toolwear/_debug_p6/{a565,main7cc,b3}` (b3 = this build); script `ab.js ROOT TAG OUT`.

## What changed (kept vs reverted)
- Kept for whole-tool views (10Pi): backdrop alignment, blob sorting, streak test, tip damage (human-run chip checks).
- Reverted for a tool wider than the frame without calibration (all camera photos now): edge-pair framing as 565a317
  (`al.cutOff`, flag `tool-cut-off` kept), such sides share the median scale of the tool's sides, and only chip blobs
  leave the flank band (no streak test).
- Removed: `wear-seg-side.onnx.js` (fA) and its parity fixture; the microscope input mode UI (`micro-ui.js`).
