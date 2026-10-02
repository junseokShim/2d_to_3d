# vbdetect2 running log (VB close-up detection, req261002)
- Merged agent/worker-vbdetect (edge-vb.js WIP).
- Ground truth check: VB = normal distance from the operator's marker to the dotted reference line, scale = on-image bar
  (77.60 image: bar 71 px = 100 um, marker->line 53.6 px = 75.5 um, consistent). Arrow tips overshoot (arrowheads).
- Baseline (predecessor edge-vb, edge rms gate 2.5 px): 77.60 -> not-detected (edge rms 2.64 px); with gate 6 um: 84 um.
  90.34 -> 127.5 um (+41 %), front too short at the operator spot, too long on the right.
- Tried: cumulative-evidence change point + DP along edge (TAU 1.3, INTACT_UM 25): overshoots into flank (S of
  near-edge flank elevated; ref band 150-300 um is lit differently). Brightness-free features: still ~150-180 um.
# vbdetect3
- 90.34 marker profile: grey rises in two steps (85->94 um, 100->106 um, coating rim); step detector peaked on the 2nd.
  Fix: front = half-rise crossing between land min (15 um back) and max (15 um ahead) -> 90.34: 102 -> 95.5 um, 77.60: 78 -> 81.1 um. 19/0.
- 24.33 um spot: operator marker 2 (853.8,607.6) is at the SAME along-edge position as marker 1, 23 um on the BACKGROUND side
  of the dotted line: it is the real tool edge protruding beyond the reference line (edge deviation), not a land width.
- Edge deviation profile (devUm per position, edgeDevOutUm/InUm): first departure from background level (15 % of bg->tool) with no gaps to the line. Spot [2]: 21.8 um vs 24.33 (ok +-5). Unworn p90 2.3 um. req261002 21/0.
- Wired: www/js/metro/metro-cu-ui.js = section 4 card 'close-up VB' (#mtCU: upload, scale bar um, um/px, n lines; dotted
  reference line, yellow front, VB dimension lines + VBmax, edge deviation; not-detected/no-scale -> 'operator needed', no number).
  Wear flow: on tool3d:metro, the first run side photo with a scale bar is measured (upload wins). Report: Tool3D.closeupReport
  csv/html/pdf page (metro-report). E2E: closeupVb check (77.60 photo: marker 81.1 um, VBmax 90.7, bar 71 px); PDF now /Count 5.
- All suites green; E2E PASS 23/23 (screenshot metro-closeup-vb.png).
