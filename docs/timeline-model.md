# Timeline model: A today, B later

All timeline logic lives in `packages/shared/src/sequence.ts`. It covers what plays, where each clip lands, links, split, trim, delete, unlink and range removal. Everything else calls into it:

- the connector's edit ops (`ops.ts`)
- the render plan (`renderPlan.ts`)
- the after-render check (`qa.ts`)
- the editor (`apps/web/src/rendrr/editor.js`)

The live player reads the render plan through `playback.ts`. Model B replaces `sequence.ts` and the parts of `renderPlan.ts` that read clip positions. The player, the connector and the check keep their interfaces.

## Model A (now)

- A clip's `start` and `end` are seconds in the project's one original footage.
- V1 is magnetic. Its clips play in footage order, back to back, minus cut words. Removing or shortening a V1 clip closes the gap, so ripple is built in. The edit's length is the sum of the kept parts.
- A1 is the dialogue. A V1 clip and the A1 clip with the same start and end are linked and edit together, unless one was unlinked (`unlinked: true`). Picture with no A1 under it plays muted.
- V2, V3, A2 and A3 clips are pinned to footage moments. When footage before them is cut, they move with it. When their own footage is cut, they shrink or leave the edit.
- Every clip also carries derived fields, rewritten after every change:
  - `sourceVideoId`, `sourceIn`, `sourceOut`: the video the clip plays and its in/out points. For V1 and A1 that's the footage; for b-roll, its own video. For clips that play no video (captions, zooms, graphics, music, sound effects), it's the footage moment they are pinned to.
  - `timelineStart`, `timelineEnd`: the clip's place in the edit, in edit seconds.
  - `linkId`: shared by a linked V1/A1 pair.

  Versions are compared without these fields (`stripLayout`), so they never create a version.

What A cannot do:
- several videos on V1
- the same footage twice
- clips out of footage order
- J/L cuts (dialogue offset from its picture)
- moving a clip without changing which footage it plays

## Model B (Phase 2)

- A clip is placed freely on the edit's timeline: `timelineStart`, plus `sourceVideoId` and `sourceIn`/`sourceOut`. Its length in the edit is `sourceOut - sourceIn`, until speed arrives in Phase 5.
- V1 may hold any videos in any order, with repeats. Ripple becomes an explicit rule in `sequence.ts`: it shifts later clips by the change in length, and it is no longer a side effect of footage order.
- Links become explicit (`linkId`) instead of "same start and end". A1 can then sit offset from V1, which gives J and L cuts.
- Cut words become ranges removed from the clips that contain them.
- The edit-wide `rotate` (footage filmed sideways) becomes a per-clip transform. The migration copies it onto every V1 clip.

## Migration A → B

1. **Back up.** Copy every `Project.timeline` and every `ProjectVersion.timeline` to a backup table before anything changes.
2. **Convert each timeline**, inside one migration script:
   - **V1:** each clip's kept parts (V1 minus cut words) become B clips. They take `sourceVideoId` = the project footage, `sourceIn`/`sourceOut` = the kept part, and `timelineStart` = its place in the edit, already stored as `timelineStart`.
   - **A1:** split the same way. Each A1 piece takes the `linkId` of the V1 piece it covers; A1 that covers no kept V1 stays unlinked.
   - **V2, V3, A2, A3:** keep `timelineStart`/`timelineEnd` as their positions; b-roll keeps its `sourceIn`.
   - **Cut words:** stay in `cut` for the transcript view. They no longer decide what plays, because the B clips already leave them out.
3. **Verify.** For every project, render the plan from the A timeline and from the B timeline and compare:
   - every kept part, as source video, source in/out and edit time, must be within one frame
   - the captions, zooms, overlays and audio must be equal, as numbers
   - for a sample of projects, a full render each way, compared by stream length and frame hashes

   Any project that fails stays on A and is listed in the migration report.
4. **Switch.** A `model: "B"` field on the timeline tells `sequence.ts` which rules to use, so A and B can live side by side until every project has moved.
5. **Keep the ops working.** `split_clip`, `trim_clip`, `delete_clip`, `cut_words` and `cut_silences` take the same input. On B their times are footage seconds of V1 clip parts, found through `sourceIn`/`sourceOut`. The new ops are `move_clip`, `add_clip` and `set_audio_offset`.
6. **Rollback.** Restore the backup table. A-format timelines still load, because `sequence.ts` reads the `model` field.

## Where the code reads positions today

| Reads clip positions | File |
| --- | --- |
| Kept parts, time map, layout | `packages/shared/src/sequence.ts` |
| Render plan (spans, dialogue mutes) | `packages/shared/src/renderPlan.ts`, `planRender()` |
| After-render check | `packages/shared/src/qa.ts` (through `keptRanges`, `makeTimeMap`) |
| Style rules (zoom placement) | `packages/shared/src/ops.ts`, `applyStyleRules()` |
| Editor drawing and trims | `apps/web/src/rendrr/editor.js` (draws `timelineStart`/`timelineEnd`) |
