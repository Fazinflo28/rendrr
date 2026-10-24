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
- **`start` / `end`** on every clip are edit seconds, written by the layout with `timelineStart`, `timelineEnd` and `linkId`. `stripLayout` removes the last three, so they never make a version.

### What plays

`sequenceView(timeline, words)` gives:

- **picture parts:** stretches with no cut in them; footage that continues (same video, same look) is one part
- **sound parts:** they cover the whole edit; muted ones keep their footage, so captions follow them
- each clip's place, and lookups between edit time and footage time

With `align: 30` (the render plan) every part starts and ends on a frame, exactly as model A's planner did.

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
