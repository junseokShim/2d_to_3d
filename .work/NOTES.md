# vbdetect2 running log (VB close-up detection, req261002)
- Merged agent/worker-vbdetect (edge-vb.js WIP).
- Ground truth check: VB = normal distance from the operator's marker to the dotted reference line, scale = on-image bar
  (77.60 image: bar 71 px = 100 um, marker->line 53.6 px = 75.5 um, consistent). Arrow tips overshoot (arrowheads).
- Baseline (predecessor edge-vb, edge rms gate 2.5 px): 77.60 -> not-detected (edge rms 2.64 px); with gate 6 um: 84 um.
  90.34 -> 127.5 um (+41 %), front too short at the operator spot, too long on the right.
- Tried: cumulative-evidence change point + DP along edge (TAU 1.3, INTACT_UM 25): overshoots into flank (S of
  near-edge flank elevated; ref band 150-300 um is lit differently). Brightness-free features: still ~150-180 um.
