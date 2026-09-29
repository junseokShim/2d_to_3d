# Phase 5 debug: camera-path measurement on the human's USB-microscope side views

Engine: `www/js/wear/wear-core.js` (alignment, tip damage, blob sorting), `www/js/wear/seg-wear.js` (U-Net path), `www/index.html` (analyze / camera path), `www/js/map3d`.
Benchmark: `node test/wear/human-run.js` (27 human photos: 10Pi_1, 10Pi_2 = D10, 12Pi = D12, 4 sides x 2 shots + top; labels `datasets/toolwear/reference/human_gt.json`). `12Pi+cal` = the 12Pi shots again with the per-shot microscope calibration (px/mm), as the microscope route (`window.runCameraPath(shots, pxPerMm)`) gives it.

## Root causes and fixes

| # | Symptom (main) | Root cause | Fix |
|---|---|---|---|
| 1 | Tilt -11..-16 deg, 12Pi px/mm 24-28 (true ~70-120), sides fail (10Pi_1 s4-1, 10Pi_2 s1-1/s2-1) -> VB 0 silently | Edge-pair alignment assumes the whole tool in frame with background on both sides; the close-ups fill the frame | Backdrop alignment for close-ups (backdrop colour from the top border, tip line from where the backdrop ends); a tool wider than the frame is kept with the `tool-cut-off` flag and borrows the scale of the whole sides or the calibration (`pxPerMm` arg) |
| 2 | App aborts ('공구 외곽을 찾지 못했습니다') or crashes (0-size strip) when the v0.1 outline fails; per-flute rows 0.000 | Legacy detectSide failure ended the run | Run continues; rows say not measured / operator instead of a silent 0; map3d per-tooth chip depth |
| 3 | 10Pi chips under-read, pale fracture facets lost | The backdrop flood took pale fracture facets at the tip line | tipDamage keeps rough (fracture) pixels inside the silhouette |
| 4 | False flank land 0.35-1.1 mm on 10Pi (no land labelled) | Specular streaks along the helix read as land | classifyBlobs: a blob whose highlight continues above/below along its slant is a streak; rough fracture face + smooth flank = chip |
| 5 | 12Pi-2 shot: tip line at the frame bottom (12-1-2), side measured upside down (12-3-2) | A tool wider than the frame has its axis outside the photo, so the frame-edge test (tip x near the frame side) rejected the right rotation; nothing required tool below the tip line | Tip line needs >= 1 mm of photo below it (sampled across the tool width); the frame-edge test uses only the tip row on a cut-off tool |
| 7 | e2e phone sample (4.6 px/mm): sides 3-4 flank band 0 -> post-processing (Keyence) drew no lines, e2e FAIL | Blob sorting (land / chip / streak) ran on the network path at every scale; at 0.6 mm resolution a land running into a chip all went to tip damage | Sorting only at >= MIN_PPM (15 px/mm); below, the flank band is the largest wear piece as on main |
| 6 | 12Pi+cal 12-4-2: confident 0 next to sides with 2-3 mm damage | `vb-low` compared only flank land | `vb-low` also on the total (land or tip) vs the other sides of the same tool |

## Results (human-run.js)

main 783a212: **10 passed, 11 failed**. This branch: **15 passed, 3 failed** (10Pi_1 5/5, 10Pi_2 5/5, 12Pi 3/3, 12Pi+cal 2/5).

| check | main | branch |
|---|---|---|
| 10Pi_1 silent misses | 10-4-1 | none |
| 10Pi_1 chip depth MAE | 0.601 mm | 0.287 mm |
| 10Pi_1 false land (no land labelled) | 4 sides 0.6-0.96 mm | none |
| 10Pi_2 silent misses | 10-1-1, 10-2-1 | none |
| 10Pi_2 chip depth MAE | 0.734 mm | 0.517 mm |
| 10Pi_2 false land | 4 sides 0.35-1.1 mm | none |
| 12Pi px/mm uncalibrated | 24-28 (label 67-123), not flagged | flagged `tool-cut-off` |
| 12Pi+cal chip depth MAE | 1.250 mm (calibration not accepted on main) | 1.122 mm (FAIL) |
| 12Pi+cal flank VB MAE | 0.994 mm | 0.930 mm (FAIL) |
| 12Pi+cal VBC reported on labelled sides | 7/8 | 3/8 (FAIL) |

## Known gaps (not fixed, on purpose)

- **12Pi worn land under-measured (shot 1: 0.07-0.61 mm vs label 1.06-1.35 mm).** The U-Net marks only a small patch of the rough bright band along the peripheral edge. This needs model work (worker-seg13, hum_ fold), not a rule.
- **12Pi shot 2 corner wear (VBC) read high (2.3-2.9 mm vs label 0.46-0.71 mm).** At 110-123 px/mm the worn land (rough, bright, coating lost, touching the tip line) is classed as a chip. Colour, roughness, silhouette notch depth and frame-edge contact were measured per blob on all three tools: none separates this land from the 10Pi fracture faces (same roughness 1.0, same brightness vs body, notch 0.3-0.5 mm on real 10Pi chips too). Tightening the "touches the tip line" limit would cut correct 10Pi readings. All these sides go to the operator (`tip-damage`), none is confident.
- Label definition differs: the label VB is the land width across a peripheral band 3.5-5.6 mm long, the engine VB is the depth below the tip line.

## Per image (before = main 783a212, after = this branch; op = operator review)

| set / image | label chip / VB mm | before (main 783a212) | after (camfix) |
|---|---|---|---|
| 10Pi_1 10Pi_1/10-1-1 | 2.423 / - | 1.901 (fl 0.960 / tip 1.901) op tip-disagree,tip-damage | 2.574 (fl 0.000 / tip 2.574) op tip-damage |
| 10Pi_1 10Pi_1/10-2-1 | 2.327 / - | 1.302 (fl 0.613 / tip 1.302) op tip-disagree,tip-damage | 2.314 (fl 0.000 / tip 2.314) op tip-damage |
| 10Pi_1 10Pi_1/10-3-1 | 2.252 / - | 1.667 (fl 0.933 / tip 1.667) op tip-disagree,tip-damage | 1.270 (fl 0.000 / tip 1.270) op tip-damage |
| 10Pi_1 10Pi_1/10-4-1 | 2.425 / - | not measured | 2.394 (fl 0.000 / tip 2.394) op tip-damage |
| 10Pi_1 10Pi_1/10-1-2 | 2.129 / - | 1.797 (fl 0.545 / tip 1.797) op vb-uncertain,tip-disagree,tip-damage | 2.437 (fl 0.000 / tip 2.437) op tip-damage |
| 10Pi_1 10Pi_1/10-2-2 | 2.007 / - | 1.458 (fl 0.872 / tip 1.458) op tip-disagree,tip-damage | 2.013 (fl 0.000 / tip 2.013) op tip-damage |
| 10Pi_1 10Pi_1/10-3-2 | 2.051 / - | 1.276 (fl 0.509 / tip 1.276) op vb-uncertain,tip-disagree,tip-damage | 1.755 (fl 0.000 / tip 1.755) op tip-damage |
| 10Pi_1 10Pi_1/10-4-2 | 2.530 / - | 2.109 (fl 1.029 / tip 2.109) op tip-disagree,tip-damage | 2.019 (fl 0.000 / tip 2.019) op tip-damage |
| 10Pi_2 10Pi_2/10-1-1 | 1.719 / - | not measured | 2.552 (fl 0.000 / tip 2.552) op tip-damage |
| 10Pi_2 10Pi_2/10-2-1 | 2.094 / - | not measured | 1.041 (fl 0.000 / tip 1.041) op tip-disagree,tip-damage |
| 10Pi_2 10Pi_2/10-3-1 | 1.490 / - | 0.938 (fl 0.676 / tip 0.938) op vb-uncertain,tip-disagree,tip-damage | 1.943 (fl 0.000 / tip 1.943) op tip-damage |
| 10Pi_2 10Pi_2/10-4-1 | 1.791 / - | 1.103 (fl 1.103 / tip 1.094) op vb-uncertain,tip-disagree,tip-damage | 2.111 (fl 0.057 / tip 2.111) op tip-damage |
| 10Pi_2 10Pi_2/10-1-2 | 2.004 / - | 0.703 (fl 0.352 / tip 0.703) op tip-disagree,tip-damage | 2.306 (fl 0.000 / tip 2.306) op tip-damage |
| 10Pi_2 10Pi_2/10-2-2 | 1.787 / - | 1.068 (fl 0.613 / tip 1.068) op vb-uncertain,tip-disagree,tip-damage | 1.087 (fl 0.109 / tip 1.087) op vb-uncertain,tip-damage |
| 10Pi_2 10Pi_2/10-3-2 | 1.750 / - | 0.781 (fl 0.337 / tip 0.781) op tip-disagree,tip-damage | 1.286 (fl 0.178 / tip 1.286) op vb-uncertain,tip-disagree,tip-damage |
| 10Pi_2 10Pi_2/10-4-2 | 1.934 / - | 1.771 (fl 0.692 / tip 1.771) op vb-uncertain,tip-disagree,tip-damage | 1.922 (fl 0.196 / tip 1.922) op vb-uncertain,tip-damage |
| 12Pi 12Pi/12-1-1 | 0.621 / 1.156 | 3.476 (fl 1.714 / tip 3.476) op vb-edge-on,vb-uncertain,tip-disagree,tip-damage | 0.056 (fl 0.056 / tip 0.000) op tool-cut-off |
| 12Pi 12Pi/12-2-1 | 0.790 / 1.139 | 2.006 (fl 0.157 / tip 2.006) op vb-uncertain,tip-disagree,tip-damage | 0.000 (fl 0.000 / tip 0.000) op tool-cut-off |
| 12Pi 12Pi/12-3-1 | 0.598 / 1.351 | 0.000 (fl 0.000 / tip 0.000) op tip-misplaced | 0.000 (fl 0.000 / tip 0.000) op tool-cut-off |
| 12Pi 12Pi/12-4-1 | 0.446 / 1.058 | 3.263 (fl 3.102 / tip 3.263) op tip-disagree,tip-damage | 0.000 (fl 0.000 / tip 0.000) op tool-cut-off |
| 12Pi 12Pi/12-1-2 | 0.711 / 1.135 | 0.238 (fl 0.074 / tip 0.238) op vb-uncertain,tip-damage | 2.791 (fl 0.969 / tip 2.791) op vb-uncertain,tool-cut-off,tip-damage |
| 12Pi 12Pi/12-2-2 | 0.619 / 1.149 | 1.983 (fl 0.735 / tip 1.983) op vb-edge-on,tip-disagree,tip-damage | 0.000 (fl 0.000 / tip 0.000) op tool-cut-off |
| 12Pi 12Pi/12-3-2 | 0.455 / 1.340 | 0.854 (fl 0.317 / tip 0.854) op vb-uncertain,tip-disagree,tip-damage | 1.501 (fl 0.000 / tip 1.501) op tool-cut-off,tip-damage |
| 12Pi 12Pi/12-4-2 | 0.500 / 1.167 | 0.781 (fl 0.651 / tip 0.781) op vb-uncertain,tip-disagree,tip-damage | 1.540 (fl 0.000 / tip 1.540) op tool-cut-off,tip-damage |
| 12Pi+cal 12Pi/12-1-1 | 0.621 / 1.156 | 3.476 (fl 1.714 / tip 3.476) op vb-edge-on,vb-uncertain,tip-disagree,tip-damage | 0.068 (fl 0.068 / tip 0.000) op vb-low |
| 12Pi+cal 12Pi/12-2-1 | 0.790 / 1.139 | 2.006 (fl 0.157 / tip 2.006) op vb-uncertain,tip-disagree,tip-damage | 0.437 (fl 0.437 / tip 0.000) op vb-uncertain |
| 12Pi+cal 12Pi/12-3-1 | 0.598 / 1.351 | 0.000 (fl 0.000 / tip 0.000) op tip-misplaced | 0.610 (fl 0.610 / tip 0.000) op vb-uncertain |
| 12Pi+cal 12Pi/12-4-1 | 0.446 / 1.058 | 3.263 (fl 3.102 / tip 3.263) op tip-disagree,tip-damage | 0.508 (fl 0.508 / tip 0.000) op vb-uncertain |
| 12Pi+cal 12Pi/12-1-2 | 0.711 / 1.135 | 0.238 (fl 0.074 / tip 0.238) op vb-uncertain,tip-damage | 2.639 (fl 0.360 / tip 2.639) op vb-uncertain,tip-damage |
| 12Pi+cal 12Pi/12-2-2 | 0.619 / 1.149 | 1.983 (fl 0.735 / tip 1.983) op vb-edge-on,tip-disagree,tip-damage | 2.316 (fl 0.000 / tip 2.316) op tip-disagree,tip-damage |
| 12Pi+cal 12Pi/12-3-2 | 0.455 / 1.340 | 0.854 (fl 0.317 / tip 0.854) op vb-uncertain,tip-disagree,tip-damage | 2.854 (fl 0.074 / tip 2.854) op tip-damage |
| 12Pi+cal 12Pi/12-4-2 | 0.500 / 1.167 | 0.781 (fl 0.651 / tip 0.781) op vb-uncertain,tip-disagree,tip-damage | 0.000 (fl 0.000 / tip 0.000) op vb-low |
