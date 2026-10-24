# Phase 6 plan: colour and compositing

Rule for every item: a UI control, an op inside apply_edits, render support, a line in render_preview's check, and tests.

## What it does

- **Grade** on a V1 clip or a b-roll clip:
  - exposure (stops), contrast, temperature, tint and saturation
  - curves (master, red, green, blue)
  - an imported LUT (.cube), with an amount, applied first (an input LUT for log footage) or last (a look)
  - Copy a grade to other clips: listed clips, the clips of one video, or all.
- **Shot matching** from measured values, with no AI. The worker reads small frames of both clips. The reference is measured as it looks with its own grade, the target as recorded. Per channel, the 2nd, 50th and 98th percentiles of the target are mapped onto the reference's by three-point curves, and saturation is matched by its mean ratio. The result is an ordinary grade that can be seen and changed.
- **Chroma key**: key colour, similarity, blend and spill. The formulas are FFmpeg's `colorkey` and `despill`; the player runs the same formulas in a shader.
- **Masks**: rectangle, ellipse and path (polygon), with feather, invert and mode (add, subtract, intersect). A clip shows only inside its masks.
- **Blur and pixelate**, over the whole frame or inside an area (rectangle, ellipse or path, with feather and invert).
- **Under layer**: a b-roll clip can sit behind V1 (`under`). It shows where V1 is keyed, masked, framed smaller or moved away, which is how a green-screen speaker gets a background.
- **HDR stays HDR.**
  - The final render of an edit with HDR footage (PQ or HLG) is HEVC 10-bit, BT.2020, with the source's transfer and the right tags.
  - SDR clips, b-roll, graphics and captions are placed in it at SDR white (203 nits).
  - `set_export {hdr: "sdr"}` converts the edit to SDR, tone-mapped as today.
  - Previews and the editor stay SDR (tone-mapped, as the browser shows it), and the check says so.

## How the editor plays exactly what renders

- **One grade, one table.** A new shared module, `look.ts`, turns a grade into a 33-point 3D LUT. That covers WB and exposure (in linear light), contrast, saturation, curves (monotone cubic) and the imported LUT.
  - The render writes it as a `.cube` file for `lut3d` (trilinear).
  - The player uploads the same numbers as a 3D texture (trilinear).
- **One mask picture.** Masks and effect areas are drawn into a greyscale picture at the output size by one shared function, with a signed distance to the edge for the feather. The render reads it as a PGM file; the player uploads it as a texture.
- **Order, in both:** fit, then key alpha (from the fitted colours), then despill, grade, effects (blur/pixelate, mixed by their area) and masks (alpha), then framing, keyframes and compositing.
  - Blur is FFmpeg's `gblur` (4 steps) and a Gaussian shader with the same sigma.
  - Pixelate is `pixelize` (average) and a two-pass block average on the same block grid.
  - Sizes (feather, blur sigma, block size) are shares of the frame's short side, so preview and final look alike.
- **The player draws through WebGL2** when a clip has a look: a canvas at the plan's size, with the same fit (cover, 40% down for V1, centred for b-roll). The video element stays as the clock. The bucket already sends CORS headers, so the frames can be read.

## Files and data

| Area | Change |
|---|---|
| Timeline | V1 and V2 b-roll clips: `grade`, `key`, `masks`, `effects`; V2: `under`; timeline: `export` {hdr} |
| Shared `look.ts` (new) | schemas, `gradeAt`, `buildLut`, `cubeText`, `parseCube`, `shapeMask`/`maskPicture`, `keyAlpha`, `despillPx`, `matchGrade`, `lookText` |
| Render plan | `looks` per clip (LUT, key, masks, effects; hashed names), `under` overlays, `hdr` {transfer} or null; files to write (`lookFiles`) |
| ffmpegArgs | look chain in `drawSeg`, b-roll and under overlays; the base under V1 (black or the under clips); HDR: no tone-map, SDR→PQ LUT for SDR parts and overlays, PQ-mapped caption colours, 10-bit encode with tags |
| Playback | `liveFrame` gives the look of the showing clip, b-roll and under clip; the player compiles textures per look |
| Ops | `set_grade`, `copy_grade`, `match_color`, `set_key`, `set_masks`, `set_effects`, `set_under`, `set_export` |
| Worker | writes the `.cube` and `.pgm` files; `color_samples` job (timeout 60 s); probe reads the transfer; HDR final encode |
| API | LUT upload/list/delete (stored in the bucket, parsed and checked first); apply_edits measures for `match_color` (the samples come back in the op); get_project lines |
| Check | Colour, Key, Masks, Blur, HDR lines; a graded or keyed HDR clip is flagged (graded in SDR) |
| Editor | Color tab: grade sliders, curve editor, LUT import/choose, copy grade, match to a clip, key with eyedropper, masks (sliders, path drawn on the picture), blur/pixelate, under layer; outlines over the player |

## Risks

- **Decoders differ.** The browser and FFmpeg turn YUV into RGB with their own rounding. The match test measures the difference, and colour is compared on mean values with a small tolerance.
- **Gaussian approximation.** `gblur` is a recursive approximation of a Gaussian. Blurred areas differ slightly, and the test measures how much.
- **WebGL on weak devices.** A big blur costs about 160 texture reads per pixel at preview size. Only clips with a look use the canvas.
- **HDR overlays.** Graphics, b-roll and captions go into PQ through a LUT. Anti-aliased edges blend in PQ rather than in gamma, which is a small difference at edges.
- **Grading HDR clips.** A graded or keyed HDR clip is graded as the editor shows it (SDR) and then placed in the HDR output, so its highlights stop at SDR white. The check flags it.
