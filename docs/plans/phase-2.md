# Phase 2 plan: the sequence model (B)

## What B is

- **V1 is an ordered list of clips from any video.** Each clip stores `sourceVideoId`, `sourceIn`, `sourceOut`. The edit plays them back to back in list order, so V1 stays magnetic: no gaps, and ripple stays automatic. Repeats and several videos are allowed, and so are moves.
- **Dialogue (A1) follows its picture.** Each V1 clip carries `audioStart` / `audioEnd` offsets:
  - a negative start = its sound starts before its picture (J cut);
  - a positive end = its sound runs on under the next clip (L cut);
  - `audioMuted` = no sound.

  A1 is written out from these after every change, for the timeline and readers.
- **Cut words stay a filter.** `cut` (word ids of the main footage) is taken out of main-footage clips, as today, so `cut_words` / `restore_words` keep working unchanged.
- **Other tracks are connected clips** (V2 b-roll/zooms, V3 graphics, A2 music, A3 SFX), as in Final Cut. Each is anchored to a V1 clip at a moment of that clip's footage (`anchorId`, `anchorAt`) and has a `length` in edit seconds. It moves with its clip when clips are moved or reordered. A music bed covering the whole edit is `fill: true`.
- **`start` / `end` on every clip are edit seconds.** They are written by the layout; the source and anchor fields decide them. Rotation and framing become per V1 clip.

## Files

| Area | Files |
| --- | --- |
| Model and edits | `packages/shared/src/timeline.ts` (schema: `model: "B"`, clip fields), `sequence.ts` (B view: picture and audio parts, layout, anchors, split / trim / delete / move / add / roll / slip / slide / audio offset; `toModelB()`) |
| Ops | `ops.ts`: every old op on B; new ops `add_clip`, `move_clip`, `set_audio_offset`, `roll_edit`, `slip_clip`, `slide_clip`; `edit: true` on time-based ops |
| Render | `renderPlan.ts`: plans B (parts from several videos, per-clip turn and framing, separate audio parts with silence for J/L), several inputs. `renderPlanA.ts`: the old A planner, kept only to verify the migration |
| Check | `qa.ts`: reads the B view; new line for the sequence (clips, videos, repeats, J/L cuts) |
| Player | `playback.ts` and `apps/web/src/rendrr/editor.js` / `ui.js`: one video element per source plus a sound element. Picture and sound follow the plan's parts. |
| Editor tools | Select V, Razor C, ripple trim, Rolling N, Slip Y, Slide U, Snapping S, Zoom to fit (Shift Z), drag to reorder, Alt-drag the sound edge (J/L), Add clip, split at playhead (Cmd K) |
| Worker | `jobs/render.ts`: fetch every video on V1 (finals: the original where Rendrr has it, else the preview copy, said in the check) |
| API | Migration at start-up with a backup table; payload with the other videos' preview copies and transcripts; check and summary on B |
| DB | Migration: `TimelineBackup` (project, version, timeline, model) |
| Connector | `mcpTools.ts`: the new ops and `edit: true`, in one line each |

## Migration A → B

1. Back up every project's timeline and every version's timeline in `TimelineBackup`.
2. Convert with `toModelB()`:
   - V1 clips keep their footage ranges, in footage order.
   - Holes in A1 become muted pieces.
   - Other tracks are anchored at the kept moment their start lands on, with the length they had in the edit.
3. Verify: the old planner (A) and the new planner (B) must give the same plan within one frame: picture parts, sound, captions, zooms, b-roll, graphics and audio clips. A project that differs stays on A (it converts on the fly when read) and is listed in the log.
4. A real render through both graphs is compared by frame hashes in the tests.
5. Old versions convert when restored.

## Risks

- **Migration exactness.** Verified per project; the backup and the on-the-fly conversion are the safety net.
- **The player with several sources and J/L cuts.** It uses several elements, so picture and sound can drift. It resyncs whenever they are more than 0.15 s apart and at every part boundary. The up-to-date preview still plays the exact file.
- **`apply_style` on a sequence that was moved or mixes videos.** It keeps the sequence and only cuts silences and fillers. It no longer rebuilds V1 from paragraphs.
- **Finals with other videos on V1.** A local video's original is only uploaded for the main footage, so other local videos use their 720p copy in the final. The check says so; Phase 7 export can improve it.
- **Tool definitions grow.** The new ops get one short line each.
