# Phase 5 plan: transitions, keyframes, speed

Rule for every item: a UI control, an op inside apply_edits, render support, a line in render_preview's check, and tests.

## What it does

- **Speed (V1 clips).**
  - Constant speed from 0.1x to 10x, reverse, speed ramps (speed points at moments of the clip's footage, linear between them), freeze frame (a still of one frame for N seconds).
  - Sound keeps its pitch (FFmpeg `atempo`; the browser's `preservesPitch`). Sound plays from 0.5x to 4x. Outside that range, reversed and frozen, the clip is silent in both the render and the player, because browsers mute sound there and cannot play sound backwards.
  - A clip that is not at normal speed has no J/L cut at its edges.
- **Transitions** sit on the cut before a V1 clip: cut, dissolve, dip to black, dip to white, whip pan, zoom, slide.
  - Each has a duration and is centred on the cut, so the edit's length does not change.
  - Dissolve, slide and whip use footage past the cut (handles), as Premiere does. When a clip has too little footage past its edge, the transition gets shorter and the check says so.
  - Dips and zoom need no handles. A dip on the first clip fades in from the colour.
- **Keyframes** on a V1 clip, a b-roll clip, a graphic or a text layer: position, scale, rotation and opacity at moments of the clip.
  - Easing from one key to the next: linear, ease in, ease out, ease in-out (the CSS curves), or any cubic bezier.
  - On V1 the picture moves over black. A b-roll clip with keyframes becomes a picture-in-picture over the main picture.

## How the editor plays exactly what renders

- **One set of numbers.** A new shared module, `motion.ts`, turns every keyframe curve into the same piecewise-linear table, with 16 pieces per eased segment. It also holds the speed-ramp steps (at most 0.2 s of edit each, constant inside) and the transition curves.
  - The render writes that table as FFmpeg expressions: a sum of clipped ramps.
  - The player evaluates the same table.
- **Speed in the sequence.** Every picture part, piece and sound part gets a `rate` (1 normal, below 0 reversed, 0 frozen).
  - Edit length = footage / speed.
  - Every part is a whole number of output frames.
  - The player sets `playbackRate` per part. It seeks frame by frame while a part plays reversed, and holds the frame while frozen.
- **Transitions in the render.** A window of the transition's length is built from the two sides' footage, each side going through the same steps as its parts (speed, turn, fit, framing, keyframes), and laid over the joined picture. The player draws the same window with two extra video elements and the same CSS maths.
- **Keyframes in the render.** FFmpeg's `perspective` filter (sense=destination, evaluated per frame) moves the picture's four corners where the keyframes put them, at output size, transparent outside. Opacity multiplies the alpha. The player uses a CSS transform and opacity from the same table.

## Files and data

| Area | Change |
|---|---|
| Timeline | V1 clip: `speed`, `reverse`, `ramp` [{at, speed}], `freeze` (seconds), `transition` {type, duration, dir}, `keys`. V2/V3 clips: `keys`. Key: {t (seconds into the clip), x, y, scale, rotation, opacity, ease} |
| Shared `motion.ts` (new) | key schema, easing tables, `motionAt`, `motionExpr`, ramp steps, transition curves and windows |
| Sequence | `rate` on pieces, picture parts and sound parts; ramp steps; freeze clips; reverse order; silent sound parts; J/L only between clips at normal speed |
| Render plan | parts with rate; `transitions` (windows, sides, the length they got); `keys` per part and overlay; `ffmpegArgs`: speed, reverse in chunks, freeze, atempo, transitions, perspective |
| Player | `liveFrame` gives the part's rate, the transition at t (both sides' footage and the curve values) and the keyframe transform of the picture, b-roll, graphics and text |
| Ops | `set_speed`, `freeze_frame`, `set_transition`, `set_keyframes` |
| Check | Speed line, Transitions line (with ones made shorter), Keyframes line. A requested dip is not flagged as black, and a frozen or reversed clip is not flagged as silent |
| Editor | A Clip tab: speed, reverse, ramp points, freeze at the playhead, the transition before the clip, keyframes at the playhead with easing. Markers on the timeline: speed on the clip, a transition mark at the cut, keyframe diamonds |

## Risks

- **Reverse needs all of a part's frames at once.** It is rendered in 2-second chunks, each from its own input, so memory stays small.
- **The player is a browser.** Reverse plays by seeking each frame, so it may stutter while playing. A paused frame is exact.
- **Speed frames.** At a speed that is not a whole number, a frame can land one frame apart in the player and the render (rounding). The test measures it.
- **Text layer keyframes.** ASS animates one straight line per event, so a keyframed text layer is written as one event per piece of the table (the same pieces the player uses).
- **Transitions use handles.** Handle footage is what was recorded past the cut (cut words there show during the transition, as in any editor).
