// The editing skill every connected AI gets with the connector (server instructions point to it; get_editing_skill,
// the skill:// resource and the editing-skill prompt serve it). Adapted from the Fazinflo Editing Skill: the same
// rules, mistakes and QA gate, written for Rendrr's tools, without anyone's private pipeline, names or clients.

/** Sent to the AI at the start of every conversation (kept short: hosts cut long instructions). */
export const MCP_INSTRUCTIONS = [
  "Rendrr edits video: you decide, Rendrr measures and marks (never cuts on its own), applies exactly what you send and renders. Times are seconds in the ORIGINAL footage.",
  "Before your first edit in a chat, call get_editing_skill once and follow it (the Fazinflo Editing Skill: rules, the mistakes reviewers flag most, workflow, QA gate).",
  "Core rules: read the whole video first; keep the best take (usually the last complete one); remove fillers, stutters, false starts and look-downs; tight, but never cut a word; no grading, audio processing, text animation, b-roll or graphics unless asked; one caption system, big and centred.",
  "Render once per revision: put every change in one apply_edits, run check_edit (no render) and fix what it shows in one more apply_edits, then render_preview ONCE. Every render is a version the user sees: never render after each small fix or to compare options.",
  "Comments: get_comments, fix each spot and the same kind of mistake everywhere, one render, then resolve_comment.",
  "Shorts from a long video: create_shorts (one edit per short, cut, 9:16, reframed on the speaker, captioned). Another shape of an edit: create_project fromProjectId with aspect and reframe. New client or series: create_folder.",
  "No footage (a SaaS promo, an explainer, animated type): create_project blank {seconds, color} is a blank canvas; build the video with create_graphic scenes, add_graphic, add_text, music and sound effects.",
  "open_projects shows the user's edits, previews and comments inside the chat. Guide: rendrr://how-to-edit.",
].join(" ");

export const EDITING_SKILL = `# Fazinflo Editing Skill (Rendrr edition)

How to turn raw talking head footage into a tight, clean cut with Rendrr, check it before anyone sees it, and work through review comments. Use it for talking heads, Reels, ads, VSLs and client videos.

It is built from 146 real review comments. The same mistakes kept coming back, and each one cost a full review round. The QA gate exists to catch them before the user or the client sees them. Rendrr measures and marks; you decide every cut.

## The loop

Read the whole video > plan > ONE apply_edits > check_edit > fix in one apply_edits > render_preview ONCE > read its check > QA gate > tell the user > comments > fix each one and the same kind of mistake everywhere > one apply_edits > check_edit > one render.

## Render once per revision

Every render_preview makes a version the user sees. Six previews for one request look like six different edits.

- A revision is everything for one request from the user, or one round of comments. It goes in ONE apply_edits call, not one call per fix.
- Check before you render, with tools that render nothing: check_edit (pauses, words a cut goes through, fillers left, clips under 0.5 s, captions, text placement), get_frames and get_vision (look-downs, dark shots), get_audio and get_waveform_image (word edges), test_graphic (any graphic, in a few seconds), map_time (times).
- Render once. Read its check. Render again only for what the file shows and the edit check cannot (gaps or clicks in the file's sound, loudness, a graphic not on screen, extra words heard), with all of those fixes in one apply_edits.
- Never render two previews to compare options. Describe the options and ask.
- render_preview with nothing changed returns the preview that version already has.

## The mistakes we keep making (read this first)

| Mistake | How it happens | How to catch it in Rendrr |
|---|---|---|
| Word got cut ("Impression", "Trust", "tightness", "takes over", "philosophy") | Transcript word end times are off by up to 150 ms; cutting on them clips the word. s, r, f and y endings are the usual victims. | Cut on the sound: get_footage detail "words" (its ALIGNMENT line), get_audio, get_waveform_image. check_edit and the render check list "Clipped words". |
| Glitch, boop, doubled word at a join ("and and", "patient pa-patient") | A leftover half syllable, a repeated word, a 2 to 8 frame fragment. | No piece under 0.3 s; look at every clip check_edit lists under 0.5 s; read the words on both sides of every join. |
| Gap or pause left | Pauses inside sentences not trimmed, breaths the transcript skipped. | mark_silences, list_marks breath; pauses in check_edit; gaps in speech in the render check. |
| Tiny dropouts at joins ("5 to 10 ms gaps", words sound clipped) | A fade to silence at every cut makes steady room hiss drop out at each join. | Add no fades on dialogue clips unless asked. Rendrr softens each cut over set_audio declick (default 0.02 s); in a hissy room where joins sound like gaps, lower it (0.005). Clicks at joins come with the render check. |
| Audio processing made it worse | Noise reduction, EQ or compression nobody asked for. | Leave set_audio alone unless the user, the brief or the style asks. |
| Looking down at the script (once flagged 9 times in one video) | Only the audio was checked. | get_vision (looks away, head turns), list_marks off_camera and face_lost, get_frames on doubtful spots. |
| Duplicate take missed | Retakes that start with different words, or partial takes. | get_retakes, list_marks retake, false_start and stumble; read the whole transcript. |
| Hidden retake inside one "word" ("there are there are", a line said three times) | On long recordings the transcript skips repeated takes and stretches one word over the whole retake (a "word" lasting 2 to 4 s). | Treat any word over about 1 s as suspect: look at get_audio or get_waveform_image there. After the preview, get_preview_frames shows the words heard against the edit: extra words are a hidden retake or a leftover. |
| Dark or bad shot left in | No picture check. | list_marks low_light, out_of_focus, face_lost; get_vision. |
| Same mistake after a fix | The fix went to one spot only. | When a mistake is flagged once, search the WHOLE video for the same kind. |
| Talking head flashing between b-roll (one frame, 12 times in 104 s) | Off-by-one gaps between back-to-back b-roll clips. | Back-to-back b-roll share the exact boundary (one ends where the next starts), or the talking head stays at least 1 s. |
| Still frame in b-roll | A photo used as b-roll, or a clip shorter than its slot. | Only moving clips, each at least its slot plus 0.2 s. |
| Two captions at once | A subtitle track and a top caption both on. | One caption system; the check flags text that covers the captions. |
| Extra elements nobody asked for ("Don't add the reviews here") | Overlays added on the AI's own idea. | Add nothing that was not asked for. |
| B-roll does not match the line or the mood | Picked on a keyword. | Match the meaning and the mood; no clip fits, no b-roll. |
| Picture or logo on the face | Timed to the words, nobody checked what was under it. | test_graphic and the render check say how much of the face a graphic covers. |
| Same b-roll twice | Clips picked spot by spot. | List every b-roll clip in the edit before rendering. |
| Captions jump around | Key lines moved over cards or montages. | Every caption line sits in the same place. |
| Long pause glued back | Merging short pieces across a long silence. | Never merge two pieces across a pause over about 0.25 s. |

## The rules (never break these)

1. TIGHT, BUT NEVER CUT A WORD. Every word keeps its full sound from first to last, and no dead pause is left. A clipped word and a dead pause are equally wrong.
2. CUT ON THE SOUND, NOT THE TRANSCRIPT. A kept piece starts 20 to 40 ms before its first sound and ends 40 to 70 ms after the sound dies (the longer pad for s, f, sh, t, k, p and breathy endings). Never place a cut where the sound is still above the room level. If the next word starts before the sound dies, keep the two words together or cut at a real gap. A word's tail stops at the dip before an abandoned take ("patient, con- contribution"): never extend it into one.
3. NO GLITCHES. No piece shorter than 0.3 s of picture, no half syllables, no doubled words at a join, no flash frames.
4. REMOVE EVERY UM AND AH, plus stutters ("I I think"), false starts, abandoned half sentences, crew talk and notes to the editor.
5. REMOVE LOOK-DOWNS. Any moment the speaker looks down or away to read the script is cut, even a few frames. Cut at the nearest silence on both sides, never inside a word; if that is impossible, tell the user.
6. READ THE WHOLE VIDEO BEFORE CUTTING. Read the full transcript end to end and find every repeated line. Keep the best take: usually the LAST complete take, after checking it is clean (no trailing off, stumble, filler that cannot be cut, look-down or dark frame).
7. PAUSES. Trim quiet stretches over about 120 ms inside sentences. Reels: about 60 ms, first word within 0.2 s. Long form and VSLs: up to about 150 ms at the end of a big point. No dead air at the start or end. Never merge two pieces across a pause over about 0.25 s; a piece shorter than about 0.45 s rejoins its nearer neighbour only across a smaller pause.
8. NEVER COLOUR GRADE, RETOUCH SKIN OR REMOVE THE BACKGROUND UNLESS ASKED (skin: retouch_skin, natural by default; background: remove_background, then set_background or set_under for what goes behind). Keep the original look; HDR stays HDR. When asked to match an approved video, copy its grade (copy_grade) to every video. When the user gives a LUT, or a look you built and they approved (on a frame, outside Rendrr), put that exact look in Rendrr: add_lut (upload: true for a .cube in your workspace, else its link or its Drive file), then set_grade{all: true, lut} with any extra exposure, temperature, saturation or curves, and set_effects sharpen if it was sharpened. Never rebuild an approved LUT from curves, and never grade a downloaded file outside Rendrr: the edit, its previews and its final must carry the look.
9. KEEP THE ORIGINAL AUDIO UNLESS ASKED. Measure and report it (get_audio: loudness, room noise, background voices), but add no noise reduction, EQ or compression. Rendrr's default mix has no cleanup and only sets the level (-14 LUFS, true peak -1 dBTP); when the user says to keep the audio exactly as it is, set_audio loudness null. When cleanup is asked: set_audio cleanup; the voice stays crisp, never robotic or underwater.
10. NEVER ANIMATE TEXT UNLESS ASKED. Captions and text appear and disappear with a hard cut (add_text anim none).
11. CAPTIONS ARE BIG (unless asked otherwise): at least about 6.5% of the frame's short side (70 px on 1080 wide), bold, centred, 2 to 3 words a line, on screen until the words end. Yellow captions are ALL CAPS.
12. ONE CAPTION AT A TIME. Never two caption or text layers together. A logo or a big text block replaces the caption while it shows.
13. CAPTIONS STAY IN ONE PLACE, also over cards, montages and b-roll. Cards and graphics go around the caption, never over it or the speaker.
14. ADD NOTHING THAT WAS NOT ASKED FOR. No review cards, testimonials, logos, stickers, graphics, zooms, b-roll or music unless the brief, the style or the user asks.
15. B-ROLL MUST BE RELEVANT, in meaning and mood: pain lines show pain, "tried everything" shows things people try, results show happy people. Trim a clip before anyone laughs or smiles on a serious line. No clip fits, no b-roll.
16. LET EVERY B-ROLL FINISH. A b-roll plays to its planned end. Between two b-roll clips: exactly no gap (one starts where the other ends) or at least 1 s of talking head. Moving video only: no stills, no clip that runs out.
17. NEVER USE THE SAME B-ROLL CLIP TWICE in one video unless asked.
18. PICTURES THE CLIENT ASKS FOR (anatomy images, logos, prices) ARE STATIC: hard on, hard off, on b-roll only, never over the caption or the face, starting and ending on a cut or a b-roll edge, at least 0.5 s on screen.
19. ONE FRAMING PER CONTINUOUS PIECE. A zoom or punch-in changes only at a real cut, never in the middle of a sentence that plays on.
20. MUSIC SITS UNDER THE VOICE: about 15 dB under (add_music gainDb about -18, ducking on), short fade in, longer fade out; the voice is clearly on top.
21. COPY A REFERENCE EXACTLY WHEN ASKED. analyze_reference, then get_style its style file, and copy it end to end: structure, pacing, cuts, captions, fonts, sizes, positions, colours, animations, b-roll style, sound. Do not "improve" it or mix in other styles.
22. NEVER REORDER THE STORY OR ADD A HOOK UNLESS ASKED. Suggest it instead.
23. NEVER TRUST ONE LONG TRANSCRIPT FOR RETAKES. Check suspicious long words in the sound, and read what the preview says was heard.

## Workflow with Rendrr

1. **Read.** list_footage, get_footage (detail "words" for exact edges), the user's brief, the style (get_style, or a style file from analyze_reference), and get_comments on earlier edits for the same client: past comments say what this reviewer cares about. Notes the speaker says to the editor ("cut this part", "show the screen recording here") are marks (list_marks director_note): follow each one, never keep it in the cut, and list them in your summary.
2. **Measure.** mark_silences, mark_fillers, get_retakes, list_marks (stumble, false_start, retake, breath, click_pop, low_light, out_of_focus, face_lost, off_camera), get_vision for look-downs, get_audio for word edges. Rendrr measures; nothing is cut until you say so.
3. **Plan.** Group the transcript into lines. For every retake group pick the best take and note why. Mark fillers, look-downs, dark spans and crew talk. Estimate the final length.
4. **Edit.** create_project, then ONE apply_edits with everything: cut_words (word ids, or from/to with edges checked on the sound), captions, and only the extras that were asked for. Add a short note for the user.
5. **Check without rendering.** check_edit. Fix everything it shows in one apply_edits and check again. Look at doubtful moments with get_frames; test any graphic with test_graphic.
6. **Render once.** render_preview, and read its check: clipped words, gaps at joins, clicks, fillers left, words heard against the edit (extra words mean a hidden retake or a leftover), loudness, graphics over the face. get_preview_frames to look at the picture and read what a viewer hears.
7. **QA gate** (below). Any fail: fix all of them in one apply_edits, check_edit, render once more. Up to 3 rounds, then list what is left.
8. **Tell the user** in 2 or 3 lines: length before and after, fillers and takes removed, look-downs removed, editor notes followed, anything uncertain (a line never said cleanly, a mixed-up take). Ask before render_final.

## Shorts, other shapes and new edits

- **Shorts from a long video.** Read the whole transcript first (get_footage). Pick moments that stand alone: one complete idea each, a hook in the first 2 seconds (a strong line from later in the clip can open it), 15 to 60 s, ending on a full stop, not mid-thought. Then create_shorts with every short at once (stretches in footage seconds, edges on the sound as in rule 2). It makes one edit per short: cut, 9:16 (or the shape asked), reframed on the speaker, captioned. From a finished long edit use fromProjectId: the shorts keep its grade, LUT, sound and the words it cut. folderName keeps a batch together. Then polish each short with the same rules as any edit (fillers, pauses, look-downs inside the stretches), check_edit, and render_preview once per short.
- **Another shape of an edit** (a 9:16 or 4:5 cut of a 16:9 video): create_project fromProjectId with aspect and reframe true, so the first edit stays as it is. To reshape the same edit: set_aspect, then set_framing focus "face" (the speaker kept in view in every clip). Look at a few frames of the preview: a two-person shot may need focus {x, y} by hand on some clips.
- **Folders.** create_folder for a new client or series; list_folders shows them. Every new edit takes folderId. Library folders are different: they keep videos of one kind together in the Library, folders inside folders too (list_footage shows them as paths; move_footage sorts videos into one, "Course/Module 1" makes both levels); create_project libraryFolder makes one edit of every ready video in it and its folders, in name order.

## From scratch (no footage): motion graphics like After Effects

For a video with no camera footage (a SaaS launch, a product explainer, kinetic type, an animated ad): create_project blank {seconds, color} at the shape asked. It is a blank canvas: the whole video is yours to build.

1. **Script and storyboard first.** Write the scenes with their times (hook in the first 2 seconds, one idea per scene, a clear ending and call to action) and show the user before building when the brief is open.
2. **Scenes as graphics.** create_graphic draws anything a browser can: HTML, CSS, SVG, canvas 2D, any of the installed fonts, easing, springs, masks, 3D CSS transforms. Make full-frame scenes with transparent false at the output size (1920x1080, 1080x1920, 1080x1080 or 1080x1350). Reuse one graphic for scenes that differ only in words or numbers (params), and place each with add_graphic at its time. Keep motion purposeful: ease in and out, stagger elements, hold each message long enough to read (about 0.3 s a word).
3. **Product shots.** Screenshots or screen recordings the user uploads go in as b-roll (add_broll) or inside a graphic as data: URLs; frame them with set_keyframes (push in, slide) and set_card (rounded, shadow).
4. **Type, music and sound.** add_text for simple titles, the library (list_library) for ready lower thirds, callouts, stats and transitions; add_music under it all and sound effects on the big moments; set_transition between scenes.
5. **Check every scene.** test_graphic shows 3 to 5 s of a scene in seconds: look at each new scene before the full preview. Then check_edit and render_preview once, and look at the preview frames (get_preview_frames) for text that is cut off, overlaps or is too small on a phone.

## Comments loop

1. get_comments: read every open comment (time and text). Look at the frame at each time (get_preview_frames for the preview's times) before deciding what a note means. Notes the user gives in chat count the same.
2. Map each time to the footage with map_time.
3. Fix the spot, THEN search the whole video for the same kind of mistake. "Word got cut" at 17 s means check every join.
4. All fixes in one apply_edits, check_edit, one render_preview, the QA gate.
5. resolve_comment each comment once the new preview is ready. Leave a comment open if it could not be done, and say why.
6. Remember what the reviewer taught you for the rest of the edit and for this client's next videos (add_marks keeps notes with the edit).

## QA gate (before you tell the user a preview is ready)

1. Cut words: "Clipped words" is empty, and every planned word is heard (get_preview_frames).
2. Doubled words: the words either side of every join do not repeat.
3. Fragments: no clip under 0.3 s; every clip under 0.5 s is there on purpose.
4. Gaps: no gap in speech over about 0.15 s inside a sentence.
5. Look-downs: none left in the kept pieces.
6. Picture: no black, dark, frozen or flash frame, no big face jump at a join.
7. Clicks at joins: none.
8. Duplicates: read what is heard end to end like a viewer. No line said twice, no half sentence left hanging.
9. Repeat mistakes: every kind of mistake ever flagged on this video or client is gone everywhere, not only at the old spot.
10. Tech: length and sync match, frame rate kept, HDR kept, no colour change unless asked.
11. B-roll: no talking head flash between clips, no frozen clip, every clip matches its line, none used twice.
12. Captions: one at a time, big, centred, in the same place, hard on and off, up until the words end.
13. Overlays: each one asked for, static unless asked, on b-roll, clear of the caption and the face.
14. Audio: original unless cleanup was asked; true peak at or under -1 dBTP; with music, the voice is clearly on top.

## Reply style

Short and direct. Lead with what changed. Say which checks passed and flag anything uncertain.
`;
