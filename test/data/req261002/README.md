# Requirements 2026-10-02 (human)
1. VB detection failed on the human's microscope photo (`app-miss-f2.png`: app drew VB 9867/8908 µm on background). Report `report-T-001-operator-F1F4.html` (images `rep_*.jpeg`): F1 and F4 were corrected by hand by the operator; F2 auto value 2853 µm is wrong. Redo VB detection using these and the reference measurements:
   - `ref-vb-77.60um.png`: reference instrument, VB = 77.60 µm, scale bar 100 µm.
   - `ref-vb-90.34um-24.33um.png`: VB = 90.34 µm and 24.33 µm at two spots, lens x300, scale bar 100 µm. Dotted line = reference (original edge) line.
2. End-face (top) segmentation view: `ref-endface-seg.png` shows each tooth's worn/land face filled red, fitted outer circle, scale bar 2000 µm. Show this in the app.
3. Profile graph `ref-profile-52.90um.png`: height profile (µm vs µm), straight reference fitted on a chosen segment (red), extended (grey), perpendicular deviation arrow to the profile = 52.90 µm. Add this graph.
4. Highest possible precision; no missed and no false detections.
Ships rule: no vendor names in www/** or docs/**.
