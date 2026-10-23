# Phase 1 plan: fix what's broken (model A)

Rule for every item: UI control, MCP op (inside apply_edits), render support, a line in render_preview's check, tests.

## Files

| Area | Files |
| --- | --- |
| Timeline logic (one module) | `packages/shared/src/sequence.ts`: kept ranges, time map, layout fields, links, split / trim / delete / unlink, range removal |
| Edit ops | `packages/shared/src/ops.ts`: linked ops, `set_link`, `cut_words` exact ranges, `cut_silences` clip edges, `set_clips` with or without ids |
| Player = render | `packages/shared/src/playback.ts` (new): reads the same `planRender()` output the renderer uses (kept parts, captions, zooms, b-roll, graphics, muted dialogue) |
| Graphic HTML | `apps/worker/src/lib/templates.ts` moves to `packages/shared/src/graphicHtml.ts`, so the editor draws a template with the same HTML and clock the renderer records |
| File check | `apps/worker/src/lib/ffmpeg.ts` (`measureFile`: stream lengths, black, silence, loudness, one pass), `jobs/render.ts` (stores it), `packages/shared/src/qa.ts` (reads it) |
| Transcript | `packages/shared/src/transcript.ts`: word end times in `detail: "words"` |
| Connector | `packages/shared/src/mcpTools.ts`, `apps/api/src/tools.ts`: `images: true` on `get_footage` and `create_graphic`, docs for the new op fields |
| Login | `apps/api/src/auth.ts`, `apps/api/src/services/logins.ts`: same verified email = same account; safe merge of empty duplicates at start-up |
| Editor | `apps/web/src/rendrr/editor.js`, `ui.js`: timeline and player in edit time, linked clips, Alt-click unlink, live graphics, plays the preview when it's up to date |
| API payload | `apps/api/src/services/projects.ts`: caption rules, b-roll and graphic files for the player |
| Docs | `docs/timeline-model.md` (A to B migration), `STATUS.md`, `DECISIONS.md` |

## Data changes

- Every clip gets derived fields, rewritten after every edit: `sourceVideoId`, `sourceIn`, `sourceOut`, `timelineStart`, `timelineEnd`, and `linkId` on a linked V1/A1 pair. `unlinked: true` marks a pair someone unlinked.
- Model A still decides from `start`/`end` (footage seconds); the derived fields are for the player and for a later model B. Versions are compared without them, so no empty versions.
- Render rows store `plan.measured` (what the file measured).
- No database migration: all of this lives in the timeline JSON and the render's plan JSON.

## Risks

- **The editor switches to edit time.** Comments made in the editor until now used footage time. From now on editor and review comments both use edit time, so old editor notes can sit at a different moment.
- **The web app now imports `@rendrr/shared`.** This adds a workspace dependency, Next `transpilePackages` and Dockerfile copies. The build must pass on Railway.
- **Live player vs file.** The live player covers cuts, captions, zooms, b-roll, graphics and muted dialogue. Music and SFX only play in the rendered preview, so the editor plays the preview whenever it is up to date.
- **No images by default.** An AI that relied on the overview sheet now needs `images: true`.
- **The account merge deletes rows.** It only removes an account with nothing in it, and logs each one.
- **Already started, not in Phase 1.** `set_audio` and audio settings are Phase 3; they stay uncommitted until then.
