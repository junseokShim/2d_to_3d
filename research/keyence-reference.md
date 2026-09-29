# Keyence VHX reference: first real-instrument ground truth

The operator measured flank wear (VB) on a Keyence VHX digital microscope (20260828_*.tif). These images give the first
instrument-measured VB values we can compare the app against.

## Dataset

`C:/agent_research_team/datasets/toolwear/reference/keyence/` (not in git)

| path | content |
|---|---|
| `images/keyence_<id>.png` | working-resolution image (1600 px wide) |
| `masks/keyence_<id>.png` | label: 0 background, 1 tool (unworn coated flank), 2 flank wear land, 3 chipping, 255 ignore |
| `labelinfo/keyence_<id>.json` | source tif, magnification, px/mm, Keyence measurements (arrow ends, reference line foot and normal), fitted Keyence overlay lines, notes |
| `work/*.npy` | SAM2 background and coating masks, cached for relabelling |

Built by `scripts/data/label_keyence.py` from `scripts/data/keyence_spec.json`, using SAM2 prompts plus hand-drawn polylines and polygons.

| id | field | px/mm (work) | Keyence value |
|---|---|---|---|
| 151425 | X100 | 539 | clean twin of 151443 |
| 151443 | X100 | 539 | [1] VB 123.51 µm |
| 151743 | X300 | 1616 | clean twin of 152008 |
| 152008 | X300 | 1616 | [1] VB 90.34 µm, [2] edge offset 24.33 µm |
| 152822 | X300 stitched | 581 | [1] VB 77.60 µm |

Not labelled:
- 151813, 151922, 151925, 151926, 152728 and 152735 are 3D height-map views. Of these, 151813/151922 carry [1] 52.90 µm, an edge recession measured along the edge.
- 153706 is an X20 end view.
- 153803 is an X1000 view of the coating.

None of these shows a flank wear land.

### Labelling rules

- **Far boundary of the wear land.** It is where the spotted coating texture starts. The bright, smooth polished band between the dark worn zone and the coating counts as wear, as the Keyence operator counts it.
- **Keyence boundary line.** Keyence draws the wear boundary as a line parallel to its reference line, the dotted line fitted on the unworn edge.
- **Scale.** The X300 scale is 2910 px/mm at full resolution, taken from the two 152008 lines, which agree with each other. The scale bar reads 2940 px/mm, 1% high.
- **Twin images.** 151425/151443 and 151743/152008 are pixel-identical apart from the overlays. The clean image is labelled; its twin gets the overlay pixels set to 255 (ignore).

## Comparison

Produced by `node test/micro/keyence-run.js` (report only, exit 0; `KEYENCE_NONET=1` skips the network). All values in µm.

| image | Keyence | mask K-line | dev | mask VB at arrow (app maths) | mask VBmax | app VB at arrow | app VBmax | IoU wear / tool (%) |
|---|---|---|---|---|---|---|---|---|
| 151443 X100 | [1] 123.51 | 122.0 | −1.2 % | 120.6 | 137.3 | – (turned 2×90) | 0.0 | 0.0 / 29.6 |
| 152008 X300 | [1] 90.34 | 91.3 | +1.0 % | 106.4 | 149.7 | 0.0 | 0.0 | 0.0 / 25.9 |
| 152008 X300 | [2] 24.33 (edge offset) | 24.7 | +1.7 % | – | | | | |
| 152822 X300 stitched | [1] 77.60 | 78.3 | +0.9 % | 132.5 | 206.5 | 0.0 | 0.0 | 0.0 / 56.1 |
| 151425 / 151743 (twins) | – | – | – | – | 148.5 / 149.7 | – | 0.0 | 0.0 / 29.4, 25.6 |

Column definitions:
- **K-line.** The Keyence method applied to the mask: from the Keyence reference line, along the arrow normal, out to the far end of the wear land. It is the median of 10 rays offset ±4–12 px along the edge on the raw mask, so it tests only the label.
- **Mask VB at arrow, mask VBmax.** micro-core maths (VB normal to the fitted edge) run on the mask.
- **App.** Microscope mode as the app runs it: the seg-wear U-Net plus micro-core.

## Gap analysis

1. **Labels vs Keyence: consistent.** The K-line is within 1.7% of every Keyence value (target 5%), so the masks hold the operator's wear boundary.
2. **App maths on a perfect mask vs Keyence: +18% (152008) and +71% (152822).** The two tools measure from different edges:
   - Keyence measures from a reference line fitted on the unworn edge.
   - micro-core measures from the edge fitted to the actual tool silhouette.

   In 152008 the actual edge lies up to 24 µm outside the reference line ([2]). In 152822 the worn and chipped zone reaches below the reference line, so the fitted edge moves outward.

   151443 agrees (−2.4%) because its edge is straight.

   To match Keyence, the app needs a reference-line option: fit the edge on the unworn part only, then measure VB from that line. This is an app change and out of scope here.
3. **App network vs mask: fails on this domain.** The U-Net finds no wear on any of the 5 images, and tool IoU is only 26–56%.
   - It flags `edge-ragged,no-wear,review`.
   - It turns the X100 images by 180° (2×90) where the mask needs 0.

   These are colour images of a coated insert on a Keyence VHX, which the training data does not cover. The next step is to add these masks, or crops of them, to fine-tuning, or at least to use them as the validation set. Five images from two tools are too few to train on alone.
4. **Label quality notes.**
   - The 151743/152008 far boundary has two straight polygon steps (x≈1245 and x≈1360 work px), far from the arrow; this is cosmetic.
   - 152822 has no clean twin, so its overlay box ("[1]77.60µm") and arrow are ignore pixels on the wear boundary. For that reason keyence-run caps how far wear fills into ignore regions (6 px) and reads the K-line on offset rays.
