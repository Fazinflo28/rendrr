# Phase 7 plan: graphics and export

Rule for every item: a UI control, an op inside apply_edits, render support, a line in render_preview's check, and tests.

## What it does

1. **Graphics as long as the edit.** A graphic clip (built-in or custom) can run for the whole video.
   - Today a recording stops at 15 s: the render drops the graphic after 15 s, while the editor holds its last frame. That is a bug in older work, fixed here.
   - Built-in graphics are drawn for the clip's real length, in the render and in the player.
   - `create_graphic` records up to 4 hours.
   - A custom graphic placed longer than its recording holds its last frame, in both the render and the player.
2. **Export settings**, on the edit (`timeline.export`), set with `set_export`:
   - `resolution`: 720p, 1080p (default) or 4k. The short side is 720, 1080 or 2160, in the edit's shape (9:16, 16:9 or 1:1, set with `set_aspect` as today).
   - `codec`: h264 (default) or hevc. HDR kept is always HEVC 10-bit, as in Phase 6.
   - **Frame rate kept:** the final plays at the footage's own rate, snapped to the standard one within 0.5% (23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60). Above 60 it is exported at 60, and the check says so.
   - Previews stay 540p at 30 fps, from the 30 fps preview copy the editor plays.
3. **Final render progress with an estimated time left**, in the editor's render window and in the connector's render_final and get_render text.

## How

- **Frame rate.**
  - The plan gets `fps` (a number) and `rate` (FFmpeg's exact fraction, e.g. 30000/1001).
  - The sequence is aligned to that rate (`sequenceView align`). Every part is then a whole number of output frames, so picture and sound never drift, however many cuts there are.
  - In the graph, every `fps=`, `r=`, `settb=` and frame count uses the plan's rate.
  - At 30 fps every string is the same as before, so previews are byte-for-byte unchanged.
  - Encoding: `-r <rate>`, keyframe every 2 s.
- **Resolution.** `outputSize(aspect, kind, resolution)`. Captions, text and graphics already scale with the output; templates are drawn at up to 720p and scaled as today.
- **HEVC (SDR).** libx265 8-bit, BT.709 tags, `hvc1` tag (plays on Apple devices). Preset `fast`, or `faster` at 4K.
- **Time limits.** A final's limit grows with its pixels and codec (4K x3, HEVC x2). The render row's `quality` ("4K HEVC") carries it, so the worker, the queue guard and the maintenance sweep agree.
- **Estimated time.**
  - The worker publishes `etaSec`. Before encoding starts, it comes from this user's last renders of the same kind and quality: their seconds of work per second of output.
  - During the encode, it comes from the encode's own speed, plus packing time.
  - No estimate is ever made up: with no history and no speed yet, the UI says "Estimating".
- **Long graphics.**
  - Graphics up to 15 s are recorded exactly as today, frame by frame.
  - Longer ones are sampled every 0.5 s on the virtual clock:
    - Identical frames are held: one frame.
    - A small change (under 0.2% of the pixels: a progress bar's edge, say) is kept as two frames that the render blends, linearly, over the half second.
    - A bigger change is recorded frame by frame for that half second.
  - The WebM keeps each frame's real time (variable frame rate). The render blends with `framerate`, the editor draws the same HTML live, and the check reads the file.
  - Limits and progress:
    - The recording's limit grows with the length (60 s + 0.5 s per second of graphic).
    - Progress shows in the render's first step.
    - A graphic that changes on almost every frame for minutes fails with a plain message saying so; it does not run forever.

## Files and data

| Area | Change |
|---|---|
| `timeline.ts` | `ExportSchema` gets `resolution`, `codec` |
| `ops.ts` | `set_export {hdr, resolution, codec}`; get_project's Export line |
| `renderPlan.ts` | `outputSize` resolution; plan `fps`/`rate`; graph uses them; encode by codec; graphics hold and blend |
| `constants.ts` | `renderTimeoutMs(kind, seconds, quality)`; `qualityLabel` |
| `qa.ts` | Check line `Export: final 1080p 1920x1080 H.264, 29.97 fps (the footage's)` |
| `mcpTools.ts` | `set_export` fields; render_final text |
| worker | probe gives the exact rate; ETA; quality label; long-graphic sampling; graphic job limits |
| API | quality on the render row; `etaSec` in status; render_final / get_render text with % and time left; create_graphic up to 4 h |
| web | Export window before a final (shape, resolution, codec, frame rate shown, HDR), time left in the render window, template graphics at full length |
| DB | none (`quality` exists) |

## Risks

- **Frame-rate threading** touches every part of the graph. Mitigations:
  - At 30 fps the output strings are identical, so previews are byte-for-byte unchanged.
  - The existing worker tests compare rendered frames.
  - New tests render 25 fps and 23.976 fps footage and count frames and sync.
- **4K and HEVC are slow** (x265 at 4K is the slowest case). The limits grow, progress and the estimate show, and a time-out fails loudly.
- **Sampling long graphics can miss** something that appears and goes inside one half second of an otherwise still graphic. The player draws the real HTML, so such a blink would show there and not in the file. This is documented, and kept rare by sampling every 0.5 s.
- **4K needs an original that is 4K** to look 4K. A smaller original is scaled up, and the check says so.
