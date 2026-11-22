# Timeline model: the sequence (B)

All timeline logic lives in `packages/shared/src/sequence.ts`: what plays, where each clip lands, and the clip edits. Everything else calls into it:

- the connector's edit ops (`ops.ts`)
- the render plan (`renderPlan.ts`)
- the after-render check (`qa.ts`)
- the editor (`apps/web/src/rendrr/editor.js`), which edits with the same ops

The live player reads the render plan through `playback.ts` (`sequenceClock`, `liveFrame`).

## Model B (since Phase 2)

A timeline with `model: "B"` and `mainVideoId` (the project's footage):

- **V1 is the sequence.** An ordered list of clips, each with `sourceVideoId`, `sourceIn` and `sourceOut` (seconds in that video). They play back to back in list order, so the edit never has gaps and every change ripples by itself. Clips can come from any of the user's videos, the same footage can play twice, and clips can be moved.
- **Cut words** (`cut`, word ids of the main footage) are left out of main-footage clips wherever they play. `cut_words` / `restore_words` work as before.
- **Dialogue follows its picture.** Each V1 clip's sound plays its own footage in sync with its picture. `audioStart` on a clip moves the cut between its sound and the sound before it:
  - `< 0`: its sound starts that much before its picture (J cut)
  - `> 0`: the clip before is heard that much into it (L cut)

  The cut never passes the picture cut before or after it, and never reaches outside the footage. `audioMuted` makes a clip silent. A1 is written from this by the layout: one clip per V1 clip, with the same id.
- **Other tracks hang on a V1 clip.** V2 (zooms, b-roll), V3 graphics, A2 music and A3 sound effects store `anchorId` (the V1 clip), `anchorAt` (a moment of its footage) and `length` (edit seconds). They move with their clip and keep their length. `fill: true` is a music bed under the whole edit. V3 caption clips only say which transcript lines show captions.
- **Turn and framing** (`rotate`, `framing`) are per V1 clip.
- **Captions and text (Phase 4).** `captionStyle` on the timeline is the edit's own caption style (missing = the look's preset, with the project style's word counts). V3 clips with `kind: "text"` are text layers: `text` (line breaks with `\n`), `style` (font, weight, size, colour, stroke, shadow, box, x, y, case, align), `card` (full-frame colour behind), `anim` (none, fade, pop, slide). They hang on a V1 clip like other V3 clips.
- **Sound (Phase 3).** `audio` on the timeline holds `cleanup` (`none`, `light`, `voice`, `noisy`), `loudness` (LUFS, or `null` for off), `peak` (dBTP), `duck` (dB) and the mix's `fadeIn` / `fadeOut`. `declick` is the fade at every dialogue cut (seconds, default 0.02). `highpass`, `denoise`, `presence`, `deess` and `compress` change the preset's numbers by hand. Missing fields take the defaults: none, −14, −1, 12, 0, 0, 0.02 and the preset's values. V1 clips carry their dialogue's `audioGain`, `audioFadeIn` and `audioFadeOut`. A2 and A3 clips carry `gainDb`, `fadeIn` and `fadeOut`; a music clip without fades gets the automatic ones.
- **Speed, transitions, keyframes (Phase 5).** A V1 clip can carry:
  - `speed` (0.1 to 10), `reverse`, `ramp` (speed points `{at, speed}` at its footage seconds, linear between them)
  - `freeze` (seconds): the clip is a still of the frame at `sourceIn`
  - `transition` `{type, duration, dir}` on the cut before it: dissolve, dip-black, dip-white, flash (an overexposure flash: the picture itself blown out on the cut), whip, zoom, slide
  - `keys` (keyframes), stored at footage seconds so they move with the footage when the clip is cut or split; a freeze's are `sourceIn` + seconds into it

  V2 b-roll and V3 text and graphics clips carry `keys` in seconds from their own start. A key is `{t, x, y, scale, rotation, opacity, ease}`.

  A V3 custom graphic clip can carry `sourceStart` (seconds into the recording where it starts, from `add_graphic from`) and `params` (values for the graphic's `window.params`; a placement whose values differ from the graphic's plays its own recording, kept by its values).
- **Colour and compositing (Phase 6).** V1 clips and V2 b-roll clips can carry:
  - `grade`: `exposure` (stops), `contrast`, `temperature`, `tint` (−100 to 100), `saturation` (%), `curves` (`master`, `r`, `g`, `b`: points `[in, out]` 0–1) and `lut` `{id, amount, input}` (an imported .cube)
  - `key` `{color, similarity, blend, spill}`: a chroma key
  - `masks`: shapes the clip shows inside. A rect or ellipse is `x`, `y` (top left), `w`, `h` as shares of the frame; a path is `points`. Each has `feather` (share of the short side), `invert` and `mode` (add, subtract, intersect).
  - `effects`: `{type: blur | pixelate, amount, area}`, where `area` is a shape like a mask

  A V2 b-roll clip with `under: true` is drawn behind V1. The timeline's `export.hdr` is `keep` (the default) or `sdr`.
- **`start` / `end`** on every clip are edit seconds, written by the layout with `timelineStart`, `timelineEnd` and `linkId`. `stripLayout` removes the last three, so they never make a version.

### What plays

`sequenceView(timeline, words)` gives:

- **picture parts:** stretches with no cut in them; footage that continues (same video, same look) is one part
- **sound parts:** they cover the whole edit; muted ones keep their footage, so captions follow them
- each clip's place, and lookups between edit time and footage time

With `align` (the render plan's frame rate) the edit is timed exactly and the picture is put on frames:
- **Sound** is cut where the edit says, to the millisecond. A part at normal speed keeps its exact footage in and out (only the file's last whole frame caps it).
- **Picture**: each part starts on the frame nearest its exact edit time and shows, frame by frame, the footage frame its sound is playing (the frame that covers that moment). Picture and sound are at most half a frame apart at a cut, and that never adds up over cuts. A part shorter than a frame is heard; its neighbours' frames cover it.
- The edit's length is the picture's whole frames; the render pads or cuts the sound to it (under half a frame).
- `cutsOnFrames` rounds the cuts to frames as model A's planner did. It is only used to check a conversion from model A, like for like.
- Cut points, trims, footage in/out and J/L offsets are stored to the millisecond (1/100 s before). Parts under 0.04 s are dropped, and a cut leaves no leftover under 0.04 s.

Speed (Phase 5): every piece, picture part and sound part has a `rate`, footage seconds per edit second. Below 0 is reversed, 0 is frozen, missing is 1.
- A part's edit length is its footage / |rate|, in whole frames.
- `srcAt` / `editOf` map between edit and footage time at any rate.
- A ramp is split into steps of at most 0.2 s of edit, each at the speed of its middle.
- A clip off normal speed has no J/L cut at its edges.
- Its sound follows its picture piece by piece (`atempo`, pitch kept). It is `silent` when reversed, frozen, or outside 0.5x to 4x. Silent sound gets no captions and does not count as speech.

### Ops on the sequence

- Old ops take the same input as before. Their times are main-footage seconds, where that footage first plays. V1 clip ops (`split_clip`, `trim_clip`) take that clip's own footage seconds.
- `edit: true` on any timed op makes its times edit seconds.
- New ops: `add_clip`, `move_clip`, `set_audio_offset`, `roll_edit`, `slip_clip`, `slide_clip`.
- When a V1 clip goes away, clips that hung on it are put back by their footage, as model A did: their footage no longer plays, they leave; it partly plays, they get shorter.
- `set_link` is kept for old callers. It changes nothing, because dialogue always follows its picture. `trim_clip` on A1 with `linked: false` moves the J/L cuts. `delete_clip` on A1 with `linked: false` mutes the clip.
- `apply_style` rebuilds a plain cut of the footage from paragraphs, as before. A sequence that was rearranged or mixes videos is kept, and only gets the cuts.

### Render

`planRender` plans a sequence from several inputs, one per video. With one video and one look, the graph is model A's: cut, join, then fit once. Otherwise each part is fitted, turned and framed on its own, then joined. The dialogue is joined from its own parts, with silence for muted parts.

The sound (`plan.audioMix`, `audio.ts`):

1. The dialogue gets the cleanup chain, a 4 ms fade at each part when a preset is on, and each clip's gain and fades.
2. Music gets its fades, its gain, and the ducking envelope from the speech ranges. Sound effects get their fades and gain.
3. Everything is mixed and the mix fades are applied.
4. The worker measures this mix (`ffmpegArgs(..., { measure: true })`), then renders it with `loudnessGainDb` and the true-peak limiter.

`audioAt(plan, t)` in `playback.ts` gives the same levels to the live player.

Speed, transitions and keyframes (Phase 5, `motion.ts`):
- **Speed.** A part at another speed picks output frame n = source frame floor(|rate| x n) in play order (`settb`, `setpts=ceil(N/rate)`, `fps`). The player's `showAt` seeks into the same frame. A reversed part is read in 1 s chunks, each from its own input with `-ss`, fitted, then `reverse`d. A freeze holds one frame (`tpad`).
- **Transitions** are planned by `planTransitions`: centred on the cut, whole frames on each side, shorter when a clip next to them is short or a side has too little footage past the cut. The note says why.
  - A dip is a colour fading in to the cut and out after it.
  - The zoom transition is a zoom term ("through").
  - Dissolve, slide and whip are drawn from both sides' segments (each through the same steps as a part) and laid over the joined picture.
- **Keyframes** become one piecewise-linear table per property (16 pieces per eased segment). The render writes it as an FFmpeg expression for the `perspective` filter (the four corners), with opacity multiplied into the alpha. The player evaluates the same table (`liveFrame`: `motion`, `transition`, overlay and text motion). A keyframed text layer is one ASS event per piece.
- **Timing.** Every curve in the player is read at the start of the frame showing. Overlays (b-roll, graphics, transitions, dips) start and end on whole frames.

Colour and compositing (Phase 6, `look.ts`):
- **The look of a clip** runs after its fit and before framing and keyframes, in this order:
  1. the key's alpha (FFmpeg's `colorkey` on the fitted 8-bit colours), then `despill`
  2. the grade as one 33-point 3D LUT (`lut3d`, trilinear, 16-bit RGB)
  3. blur (`gblur`, 4 steps) and pixelate (`pixelize`), mixed in by their areas (`maskedmerge`)
  4. the masks (a PGM picture) multiplied into the alpha
- **Files.** `plan.looks` names each clip's files and `plan.lookFiles` says what is in them; `lookFileData` writes them at the plan's size. The player builds the same LUT and the same pictures and draws through WebGL2 (`look-gl.js`).
- **Under V1.** Where a V1 part has alpha, framing or keyframes, it is laid over the b-roll under it (black when there is none). Each `under` clip is cut to that part's window.
- **HDR.** A final of HDR footage (and `export.hdr` not `sdr`) has `plan.hdr = {transfer, lut}`:
  - The output is 10-bit, BT.2020, PQ or HLG.
  - HDR parts pass through untouched.
  - SDR parts, b-roll, graphics and caption colours go through the SDR-into-HDR LUT (SDR white at 203 nits).
  - A graded or keyed HDR clip is tone-mapped first and graded as SDR (the editor shows it that way).

Graphics and export (Phase 7):
- **`timeline.export`** holds `{hdr?, resolution?: 720p|1080p|4k, codec?: h264|hevc}`, set by `set_export`. Defaults (HDR kept, 1080p, H.264) are not stored.
- **Size.** `outputSize(aspect, kind, resolution)`: a final's short side is 720, 1080 or 2160 in the edit's shape; previews stay 540.
- **Frame rate.**
  - `outputRate(kind, sourceFps)`: a final plays at its main footage's rate, snapped to the nearest standard rate within 0.5% and capped at 60; previews are 30.
  - The plan carries it (`plan.fps`, `plan.rate` as FFmpeg's fraction). The picture is aligned to it, so every picture part is a whole number of output frames; the sound is cut to the millisecond (see "What plays").
  - The graph's `fps=`, `r=`, `settb=` and frame counts and the encoder's `-r`/`-g` all use it. At 30 every string is as before.
- **Codec.** HEVC is libx265 with `hvc1` and BT.709 tags (`fast`, `faster` at 4K). HDR kept is always HEVC 10-bit.
- **Graphics of any length.**
  - Up to 15 s a graphic is recorded frame by frame. Longer ones are sampled every 0.5 s on the virtual clock: the same picture is held, a small change (under 0.2% of the pixels) is shown from the sample, and a bigger change is recorded frame by frame for that half second.
  - The WebM keeps each picture's time (variable frame rate).
  - A file shorter than its clip holds its last frame (`files.graphicSeconds`): the render pads it, and the player's `<video>` holds it the same way.
- **Check.** `exportText` gives the `Export (final): ...` line in get_project and in render_preview's check: size, codec, frame rate, and a note when the final is scaled up or capped.

## Model A (before Phase 2)

Clip times were seconds in the project's one footage. V1 played in footage order minus cut words. A1 holes muted the picture, and other tracks were pinned to footage moments. `renderPlanA.ts` keeps that planner unchanged: an old version, or a project the migration left on A, renders exactly as before.

## Migration A → B (done at API start-up)

1. **Convert.** `toModelB()`, measured with the same frame-aligned map as the old planner:
   - V1 clips keep their footage, in footage order; footage two clips shared plays once.
   - Kept footage without A1 becomes a muted clip.
   - The edit-wide turn and framing go onto every clip.
   - Every other clip hangs on the kept moment where its start landed, with the length it had in the edit.
2. **Check.** `convertChecked()` (`packages/shared/src/migrate.ts`) plans the old timeline with the A planner and the converted one with the B planner. It compares picture parts, muted dialogue, captions, zooms, b-roll, graphics, music and sound effects, all within one frame.
3. **Back up, then store.** Only a project whose plans match is converted. Its old timeline goes to `TimelineBackup` first, and its place in the list of edits is kept. A project that differs stays on A, renders with the old planner, is logged, and converts at its next edit.
4. **Versions are not touched.** A version converts when it is restored, and renders with the A planner until then.
5. **Rollback:** copy `TimelineBackup.timeline` back into `Project.timeline`. A-format timelines still load and render.

Tests:

- 500 random model A edits convert to the same plan.
- The same edit rendered by both graphs decodes to identical frames and sound (`apps/worker/test/sequence-render.test.ts`).
