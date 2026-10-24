# Phase 3 plan: audio

Rule for every item: a UI control, an op inside apply_edits, render support, a line in render_preview's check, and tests.

## What it does

- **Cleanup presets for the dialogue:** `none` (default), `light`, `voice`, `noisy`. Fixed FFmpeg chains on the dialogue before the mix:
  - `light`: high-pass at 80 Hz and gentle compression
  - `voice`: adds light denoise, a de-esser and a presence lift
  - `noisy`: stronger denoise and a soft gate

  The three presets also put a 4 ms fade at every cut in the dialogue, so cuts don't click.
- **Loudness:** the file comes out at **−14 LUFS** integrated with a **−1 dBTP** true-peak ceiling, by default. Both are settable, and normalization can be turned off.
  - Done in two passes. The worker first measures the mix (audio only, fast).
  - Then it renders with the exact gain and a 4× oversampled limiter, which catches the peaks between samples.
- **Fades:**
  - each dialogue clip's sound can fade in and out
  - music and sound-effect clips get their own fades (music keeps today's automatic fades when none is set)
  - a fade of the whole mix at the start and end of the edit
- **Ducking:** music goes down by a set amount (default 12 dB, 0 = off) under speech. Speech means the spoken words in the edit (and other videos' sound where Rendrr has no transcript).
  - The ramps are fixed: 0.2 s down before speech, 0.5 s back up after.
  - It replaces today's sidechain compressor. It is exact, so the live player can follow it too.
- **Per-clip gain:** the dialogue of a V1 clip, a music clip or a sound effect can be turned up or down.

## Files and data

| Area | Change |
|---|---|
| Timeline (`timeline.ts`) | `audio` on the timeline: `cleanup`, `loudness` (LUFS or null = off), `peak`, `duck`, `fadeIn`, `fadeOut`. On V1 clips: `audioGain`, `audioFadeIn`, `audioFadeOut`. On A2/A3 clips: `gainDb` (as now), `fadeIn`, `fadeOut`. Missing = defaults: none, −14 / −1, duck 12 dB, no fades. |
| Sequence (`sequence.ts`) | V1 clips carry their dialogue's gain and fades. (Built: they apply by edit time to the joined dialogue, so how parts merge did not change.) |
| Ops (`ops.ts`) | `set_audio{cleanup, loudness, peak, duck, fadeIn, fadeOut}` and `set_clip_audio{track, clipId, gainDb, fadeIn, fadeOut}` |
| Render (`renderPlan.ts`) | `plan.audioMix` (settings plus speech ranges). The graph gets per-part gain and fades, the cleanup chain, the ducking envelope, mix fades, and normalization with the true-peak limiter. A `measure` mode builds the audio-only graph. Model A plans are unchanged. |
| Worker | A "Measuring loudness" step before the render (timeout, progress, a plain error on failure); the gain is stored with the render |
| Check (`qa.ts`) | An audio line (cleanup, target, ducking, fades), and the file's loudness and true peak against the target. Flags: more than 1 LU off target, or true peak over the ceiling. |
| Player (`playback.ts`, editor) | `audioAt(plan, t)` gives each sound's level at any moment (clip gain, fades, ducking, mix fades). The live player plays music and sound effects too, at those levels. |
| Editor | An Audio tab: cleanup, loudness target, ducking, mix fades, and the selected clip's gain and fades. Fades drawn on the clips. |
| API | Signed URLs of the built-in music and sound effects for the player. "Measuring loudness" in the render steps. |
| Connector | The two new ops (one line each), the audio settings in `get_project`, the audio line in the check |

## Risks

- **Every new render sounds different.** Loudness at −14 LUFS and the new ducking apply to every sequence that does not say otherwise. This is the point of the phase, but previews change level. Old versions (model A) keep rendering exactly as before.
- **The live player can't play cleanup or loudness exactly.**
  - The preview copies are served without CORS, so the browser can't route them through its audio engine.
  - The live player plays the balance: clip gains, fades, ducking, music and sound effects.
  - The rendered preview (which the editor plays when it's up to date) has the exact sound. The Audio tab says so.
- **Two passes take longer.** The measuring pass decodes audio only, about 5–10% of a preview's time. It has its own timeout and fails with a plain message.
- **Limiting can pull loudness below target** on very peaky audio. The check reports the file's real loudness, and flags it when it's more than 1 LU off.
