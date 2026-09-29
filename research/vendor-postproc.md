# Vendor post-processing: Keyence VHX and Alicona, and what Tool3D reproduces

Inputs: `datasets/키엔스자료/*.tif` (13 Keyence VHX screenshots, 2026-08-28) and `datasets/알리코나 자료/`
(EdgeQuality.pdf, WearMeasurementModule 1.3 flyer). The third Alicona file is a price quote and is not used.
Ground truth extracted from the Keyence images: `datasets/toolwear/reference/keyence.json`.

## 1. Keyence VHX (what the 13 images show)

| image | lens / mag | view | scale bar | measured |
|---|---|---|---|---|
| 151425 | E100 X100 | worn + chipped peripheral edge | 250 µm = 245 px | — |
| 151443 | E100 X100 | same field | 250 µm = 245 px | **[1] 123.51 µm** point-to-line: reference edge line → wear boundary (VB) |
| 151743 | E100 X300 | close-up of the chipped zone | 100 µm = 294 px | — |
| 152008 | E100 X300 | same field | 100 µm = 294 px | **[1] 90.34 µm** VB, **[2] 24.33 µm** edge offset (chip) |
| 152822 | X300 stitched 8011×3426 | panorama along the edge | 100 µm = 296 px | **[1] 77.60 µm** VB |
| 151813 / 151922 | 3D (depth composition) | height map + profile along the edge (876 µm) | axes in µm | **[1] 52.90 µm** edge recession below a line fitted on the unworn part |
| 151925 (=151926) | 3D | height map 0–754 µm | — | — |
| 152728 | 3D | profile along 1749 µm of edge | — | — |
| 152735 | 3D | height map 0–1705 µm | — | — |
| 153706 | E20 X20 | end face, 4 flutes, circle fit | 2000 µm = 384 px | — |
| 153803 | E500 X1000 | coating texture | 25 µm = 240 px | — |

Overlay style (what the app copies): lens/magnification label top-left (`렌즈 E100: X300`), blue scale bar with a
white µm label bottom-right, the reference cutting-edge line as a dotted cyan/green line fitted on the unworn part,
red double arrows perpendicular to it with bracketed labels `[n]value µm`, and for 3D a height profile along the edge
with the fitted reference line and the deviation arrow.
Scale: 0.98 px/µm at X100, 2.94 px/µm at X300. The magnification number is a display magnification: X ≈ 297 mm /
field-of-view width holds within 1 % for X20, X100, X300 and X1000. The TIF makernote (`KmsFile`) is binary and was
not decoded; the scale comes from the bar.

Keyence post-processing = manual: operator places the reference line and point-to-line / perpendicular measurements;
optional 3D profile with line fit. Output is a screenshot plus numbers.

## 2. Alicona

**WearMeasurementModule 1.3** (with Sandvik Coromant, ISO 8688): compares the worn 3D dataset with the original
(unworn) dataset / reference surface. Parameters: Dmin / Dmax / Dmean (max deviation below / above reference, mean),
Vp / Vv (volume of peaks above / valleys below reference), Vdp / Vdv (volume of peak / valley *defects beyond the
tolerance*), VBmax / VBmean / VB at a position. Visualises original and worn profiles and 3D datasets, animates the
wear over tool life, exports CSV.

**EdgeQuality** (EdgeMaster module): surface profile extracted along the cutting edge, defects = parts below the
reference beyond a tolerance, pseudo-colour deviation on the 3D dataset, result table:
Nd (number of defects), L (evaluated length), Pd = ΣLi / L, Vdrel (defect volume per length, µm²), Ddmax / Ddmean
(max / mean defect depth along the profile), Vdmax / Vdmean (defect volume), Ldmax / Ldmean (defect length along the
profile), Ldcmax / Ldcmean and Ldrmax / Ldrmean (defect length on the clearance / rake surface from the cross section
at each position i). Buttons: export to database, save new reference, print.

## 3. What Tool3D can reproduce from its data

Tool3D has: per-flute rectified strips with the wear band and the cutting-edge line (metro, operator-correctable),
VB(z) with uncertainty, tip/corner damage depth, the per-face segmentation (flank / chip / adhesion) mapped on the
parametric model (map3d: side + end atlases, chip depth, per-tooth VB), the nominal parametric model (render
geometry: rake, clearance, lands), and the per-tool measurement history.

| vendor feature | Tool3D | how |
|---|---|---|
| Keyence overlay: edge line, VB arrows `[n] µm`, scale bar, magnification | **yes** | from metro rows (edge x, wear front x per row) on the rectified strip; scale from calibrated px/mm; magnification as Keyence-equivalent X = 297 mm / FOV |
| Keyence VB profile along the edge + statistics | **yes** | VB(u), u = z / cos(helix) = length along the helical edge |
| Keyence 3D height profile | no (no height data) | edge recession is modelled instead (below) |
| Alicona deviation worn vs reference | **modelled** | reference = nominal parametric model; worn = flank land (wedge model: depth (VB−s)·tan α) + chips (map3d depth). Not a measured surface: sign and magnitude follow the model |
| Dmin / Dmax / Dmean, Vv / Vp, Vdv / Vdp | **modelled** | on the side atlas; Dmax / Vp only from adhesion (thickness unknown → 0, reported as such) |
| colour-coded deviation on the 3D model | **yes** | vertex colours on the render geometry (same build as the 3D view) |
| EdgeQuality profile along the edge, Nd, L, Pd, Dd, Ld, Vd, Ldc, Ldr | **yes (model depth)** | per flute: D(u) = −VB(u)·tan α (edge recession of a flank land), corner damage from the tip depth; Ldc = VB / cos α, Ldr = VB·tan α / cos γ |
| cross section at position i (nominal vs worn wedge) | **yes (schematic to scale)** | rake γ and clearance α from the model |
| chipping list | **yes** | connected chip regions of the map3d side atlas: tooth, z, length, area, max depth, volume |
| tolerance pass/fail | **yes** | VBmax (metro limit), Ddmax, Pd, chip depth, Vdv |
| trend over tool life / animation | **yes** | per-tool history (metro + post entries), linear wear rate, measurements to the limit, VB(z) replay |
| CSV / print | **yes** | appended to the existing CSV / HTML / PDF reports |

Honest limits: photos give no height, so every depth/volume is a wedge-model estimate driven by the measured VB and
chip masks; the vendors measure it. The Keyence spot values (keyence.json) are the check for VB, not for depth.

## 4. Plan (built in `www/js/post/`)

1. `post-core.js` (pure, Node-testable): Keyence overlay model + scale bar + magnification, VB(u) statistics,
   EdgeQuality defect analysis, wedge cross-section, deviation atlas + WearMeasurementModule parameters, per-face
   deviation, chip list, tolerance checks, history / trend / extrapolation, CSV rows, HTML section, PDF page.
2. `post-ui.js`: panel ⑤ 후처리 after the metrology panel, tabs Keyence / Alicona, refreshed on `tool3d:metro` and
   `tool3d:map3d`; 3D deviation view with three.js on the render geometry.
3. Reports: metro-report CSV / HTML / PDF get the post section (PDF second page).
4. Validation against a real instrument: keyence.json gives five spot values with px/mm; the microscope mode
   (worker-micro2) and the seg engine can run on those TIFs and compare VB at the arrow positions.
