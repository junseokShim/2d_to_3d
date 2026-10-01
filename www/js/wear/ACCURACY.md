# Wear module: method and expected accuracy

## What it measures
Flank wear per ISO 8688-2 (end milling), peripheral cutting edge, one side photo per flute (that flute facing the camera, tip up).
Output: `window.Tool3D.wearResult` = `{flutes, diameterMm, helixDeg, perFlute:[{vbMaxMm, vbAvgMm, areaMm2, volumeMm3, profile:[{zMm, vbMm}]}], totals:{vbMaxMm, areaMm2, volumeMm3}}`.
Diagnostics (alignment, thresholds, warnings, top-view circle) go to `window.Tool3D.wearDebug`.

## Pipeline (`wear-core.js`)
1. **Auto align**: Sobel edges; the tool silhouette is the outermost pair of straight edges. The tilt is searched from -15° to +15° (1° steps, then 0.1°). Scale = edge separation / known diameter (px/mm). If one side's scale is more than 20 % off the median of the other sides, it is re-aligned at the median scale. Tip = first row where both silhouette edges start, refined to the strongest across-the-tool edge.
2. **Rectify**: resample at the native px/mm, with the axis vertical and z = 0 at the tip.
3. **Helix angle**: from the dominant edge orientation (structure tensor) of the body below the wear zone. Set `helixDeg` when the catalogue value is known.
4. **Segmentation**: wear band = pixels brighter than median + `sens`·σ of the tool body (σ from the median absolute deviation, which the band itself does not skew). The zone runs from the tip to `zoneMm` (default 0.8·D). A 2×2 morphological opening removes 1 px glints. The largest connected region is kept (the flute facing the camera).
5. **VB profile**: each photo row is converted to arc width on the cylinder, s = R·asin(u/R), which undoes foreshortening. Then VB = Δs·cos(helix), the width normal to the helical edge. The profile uses 0.1 mm steps along z.
   VBmax = maximum of VB(z) after a 3-row median. VBavg = mean of VB over the worn length (ISO zone B average).
6. **Area** = Σ Δs·dz, the true band area on the cylinder surface.
7. **Volume, wedge model**: the worn land (width VB, parallel to the cutting direction) cuts a triangle off the clearance face. Its cross-section is ½·VB²·tan α, where α = clearance angle (default 8°, option `clearanceDeg`).
   **V = Σ ½·VB(z)²·tan α · dz / cos(helix)** (the edge length element is dz/cos helix).
8. **Top photo**: circle fit of the end face. Gives a second px/mm (scale cross-check) and the bright area on the end face (`wearDebug.top.endBrightAreaMm2`). It is not added to the contract.

## Verified (test/wear/run.js, synthetic photos with known truth, 43/43 pass)
| Quantity | Tested at | Error seen | Test tolerance |
|---|---|---|---|
| tilt | -5°, 0°, +3° | < 0.1° | 0.3° |
| px/mm | 30–50 px/mm | < 0.2 % | 2 % |
| helix (estimated) | 25–35° | +1.8 to +4.3° (biased high) | 5° |
| VBmax | 0.08–0.30 mm | ≤ 0.02 mm (< 1 px) | max(0.03 mm, 1.5 px) |
| VBavg | 0.08–0.20 mm | ≤ 0.005 mm | max(0.02 mm, 1.2 px) |
| area | 0.44–0.95 mm² | ≤ 3.5 % | 12 % |
| volume | 0.0025–0.013 mm³ | ≤ 5 % | 25 % |
| top-view scale | 20 px/mm | 0.3 % | 3 % |

## Expected error vs a 3D reference instrument (real photos)
Focus-variation 3D instruments and digital microscopes measure VB at about 1 µm resolution and wear volume from a 3D surface. A phone photo cannot reach that. Realistic expectations:
- **Resolution floor: about 1–1.5 px.** VB error ≈ ±1 px / (px/mm). A phone macro at 50–100 px/mm gives about ±0.01–0.03 mm. The scenario screenshots are about 4 px/mm (±0.25 mm), so VB there is not meaningful; `wearDebug.warnings` flags any side below 20 px/mm.
- **Segmentation is the main error on real tools.** Bright means worn only when coating loss or a worn land shows contrast. Specular glints on the cylinder and on flute edges, and chips or built-up edge, read as wear and inflate VB, often by 2× or more. Dark (e.g. TiAlN) coating on carbide under diffuse light works best. Use `sens` and `zoneMm` to tune.
- **Helix**: each 4° error changes VB by about 4 %. Enter the catalogue helix when known.
- **Volume**: the wedge model assumes a flat land and the nominal clearance angle. It ignores edge rounding, cratering and chipping, so expect ±30–50 % against a 3D instrument's volume even when VB is right. Volume scales with VB², so VB errors double in volume.
- **Perspective**: this assumes orthographic, axis-perpendicular shots. At a 20 cm distance, perspective distorts a Ø10 tool's width by about 1–2 %, and a 10° off-axis camera tilt about 1.5 %.
- **Summary**: at ≥ 50 px/mm with good light, expect VBmax within about ±0.02–0.04 mm and VBavg within about ±0.02 mm of a 3D reference instrument, and area within about ±15 %. Volume is an estimate. These real-photo numbers are estimates, not validated: there were no real photos with 3D-instrument reference values to validate against.

## Tests
`node test/wear/run.js` (no dependencies). Covers synthetic accuracy cases, no-wear, contract shape, and an end-to-end run on the scenario sample crops (`test/wear/samples/`, yellow guide lines removed). The sample result is written to `test/wear/samples/result.json`.
