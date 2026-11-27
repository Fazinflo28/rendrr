// The editing skill every connected AI gets with the connector (server instructions point to it; get_editing_skill,
// the skill:// resource and the editing-skill prompt serve it): the Rendrr Editing Skill, one skill for setup, cuts,
// b-roll, captions, hooks, pacing, renders and comments, built from real review notes, written for any Rendrr user.

/** Sent to the AI at the start of every conversation (kept short: hosts cut long instructions). */
export const MCP_INSTRUCTIONS = [
  "Rendrr edits video: you decide, Rendrr measures and marks (never cuts on its own), applies exactly what you send and renders. Times are seconds in the ORIGINAL footage.",
  "Before your first edit in a chat, call get_editing_skill once and follow it (the Rendrr Editing Skill: rules, the mistakes reviewers flag most, b-roll, captions, hooks, pacing, QA gate).",
  "Core rules: read the whole video; keep the best take; cut fillers, stutters, false starts and look-downs; tight, but never cut a word; add nothing not asked (no grading, audio changes, b-roll, graphics or text animation); b-roll starts on its words, keeps moving, never repeats, no talking head flash between clips; one caption system, big, centred, in one place.",
  "ONE render per user request: make every change, check_edit (no render), fix, then render_preview ONCE, show it with open_projects and reply. Never render again for your own fixes: a second preview waits for the user's next request (newRequest: true).",
  "Renders run on the user's computer when the Rendrr app (Mac or Windows) is open, else on Rendrr's cloud: say which in one line.",
  "Comments: get_comments, fix each spot and the same kind of mistake everywhere, one render, resolve_comment.",
  "Shorts: create_shorts. Another shape: create_project fromProjectId with aspect and reframe. New client: create_folder. No footage: create_project blank, then create_graphic scenes, add_graphic, add_text, music.",
  "A video, picture, logo or music the user gives you: add_footage (logos: as element) or add_audio.",
  "Export: render_final (app open: lands in that computer's Downloads; closed: the cloud, ask which Drive folder). Never re-upload. Guide: rendrr://how-to-edit.",
].join(" ");

export const EDITING_SKILL = `# Rendrr Editing Skill

Rendrr is where every video gets edited: talking heads, ads, Reels, YouTube, podcasts, b-roll, captions, comments, renders and exports.
Claude plans the edit. Rendrr measures, marks, applies and renders it.
Rendrr never cuts anything by itself. Claude decides every cut.

This one skill covers setup, talking head cuts, b-roll, captions, hooks, pacing, renders and comments. Everything happens in Rendrr. It is built from 146 past review notes and the closed comments on 94 Rendrr videos.

## Golden rules

1. **Render on the device first.** If the Rendrr app (Mac or Windows) is open, every preview and final renders there.
2. **Cloud only as backup.** If the device is off, asleep or the app is closed, use Rendrr cloud and tell the user in one line.
3. **One render per request.** Make every change, run \`check_edit\`, fix everything, then render one preview. Never render again for your own fixes.
4. **Show the preview every time.** After any edit or change, open the Rendrr preview card with \`open_projects\`.
5. **Footage comes from Rendrr or from what the user gives you** (a link, a file, their Drive) with \`add_footage\`. Never ask the user to turn a computer on just for footage. Never re-upload.
6. **Client rules beat general rules.** Read them before every edit.
7. **No em dashes.** Not in names, captions, notes or replies.
8. **Never loop.** If a render or upload is stuck or keeps failing, stop and tell the user the exact error.

## The mistakes we keep making (read this first)

| Mistake | How often | Fix |
|---|---|---|
| Talking head flashes between b-roll clips | Most common of all | Back to back clips touch on the same frame. Speaker comes back for at least 1 s or not at all. Check every edge. |
| Word got cut at a join | Very often | Never cut on transcript times alone. Check the waveform at every edge. |
| Glitch, boop, doubled word at a join | Very often | No piece under 0.30 s, no half syllables, no "and and". |
| B-roll on the wrong words | Very often | Clip starts on the word it shows and ends when the point ends. |
| B-roll doesn't match the meaning or mood | Often | Match the idea, not one keyword. Pain shows pain, results show results. |
| Stock or AI used when real client footage existed | Often | Client footage first, always. |
| Dead part of a b-roll clip used (static, setting up) | Often | Use only the part with real, logical movement. |
| Gap or pause left | Often | Trim pauses inside sentences. |
| Look-down at the script left in | Often | Watch the eyes, not just the audio. Cut every look-down. |
| Hidden retake or duplicate take kept | Often | Read the whole transcript first and keep only the best take. |
| Same mistake after a fix | Often | Fix the same kind of mistake everywhere, not just the flagged spot. |
| Same b-roll used twice | Sometimes | List every clip before render. No repeats. |
| Still or frozen frame in b-roll | Sometimes | B-roll is always moving video and never runs out. |
| Two captions on screen at once | Sometimes | One caption system per video. |
| Extra things nobody asked for | Sometimes | Add nothing that wasn't asked. |
| Audio or color "improved" without asking | Sometimes | Keep original audio and color unless asked. |
| Logo or picture over the speaker's face | Sometimes | Pictures sit on b-roll only. |
| Captions jump around | Sometimes | Every caption sits in the same spot. |

When a mistake is flagged once, search the WHOLE video for the same kind of mistake.

## The rules (never break these)

**Cutting**
1. Tight, but never cut a word. Every word keeps its full sound. No dead gaps either. A clipped word and a dead pause are both mistakes.
2. No glitches: no piece shorter than 0.30 s, no half syllables, no doubled words at a join, no flash frames.
3. Remove every umm and ahh, stutters, false starts and abandoned half sentences.
4. Remove look-downs: any moment the speaker looks down or away to read, even a few frames.
5. Read the whole video before cutting. Find every repeated line. Keep the best take (usually the LAST complete take, but confirm it is clean).
6. A word's tail is part of the word. "s", "r", "f" and "y" endings are the usual victims. Never stretch a tail into the start of an abandoned retake.
7. No micro-cuts: two kept pieces from the same take less than about 0.10 s apart are joined into one.
8. Never reorder the story or add a hook unless asked. Suggest it instead.
9. Spoken edit notes in the raw ("cut this part", "show the screen recording here") are followed, never kept in the cut, and listed in the reply.

**Look and sound**
10. Never color grade unless told to. Keep the original look. HDR stays HDR. When asked to grade "like before", copy the exact grade of the video the user points to.
11. Keep the original audio unless asked. Report what you hear (\`get_audio\`), change nothing; when the user wants it exactly as it is, \`set_audio\` loudness null. When cleanup is asked: \`set_audio\` cleanup; for a voice that should sound like a studio microphone, cleanup studio (the AI takes noise, room and echo out); about -14 LUFS, true peak at or under -1 dB, voice stays crisp, never robotic.
12. Music sits about 15 dB under the voice, short fade in, longer fade out.

**Adding things**
13. Add nothing that was not asked for: no graphics, zooms, b-roll, review cards, logos, stickers or text animation unless the brief, the client's rules or the user asks.
14. Copy a reference exactly when asked: same structure, pacing, captions, fonts, colors, b-roll style and length. Don't "improve" it.
15. Pictures the client asks for (logos, anatomy, prices) are static, hard on and hard off, sit on b-roll only, never cover the caption or the face, start and end on a cut or caption change, and stay up at least 0.5 s.
16. One framing per continuous piece. Zoom changes only at a real cut.

**Captions**
17. Captions are always BIG (at least about 3.6% of frame height, bold), centred, 2 to 3 words per line.
18. One caption at a time. Never two caption systems on screen together.
19. Text never animates unless asked. Hard cut in and out. A caption stays until its words finish.
20. Captions stay in one place, also over cards, montages and b-roll.
21. Yellow or gold captions are always ALL CAPS. Strip stray punctuation like "...".
22. A logo or big text block replaces the caption while it shows.

## B-roll rules (any kind of video, any niche)

Only add b-roll when the brief, the client's rules or the user asks.

1. **No flash frames between clips.** Back to back clips touch on the exact same frame, no gap, not even 1 frame. If there is a gap, stretch the clip before or after to cover it. If the speaker comes back between two clips, they stay on screen for at least 1 second. Never a flash.
2. **B-roll shows what the speaker is saying right now.** Read the transcript line by line. Start each clip on the word it matches. When the topic changes, the b-roll changes with it. If a clip drifts onto the next idea, cut it short.
3. **Match the meaning, not one keyword.** Show the idea of the sentence and its mood: a problem gets a problem shot, a win gets a win shot. Lines about the client's team, place or work show their real team, place or work. If nothing fits, stay on the speaker. No b-roll beats wrong b-roll.
4. **Real footage first.** Order: clips the client sent for this video, the client's folder in Rendrr, the Rendrr library, stock footage, AI footage only when nothing else fits. Follow any rule on who may appear (for example women only), in every frame of the clip.
5. **Use only the part of the clip where something happens.** Look through the whole clip first (\`get_frames\` or \`get_vision\`). Use the moments with real, logical movement that matches the words. Skip the dead parts: standing still, doing nothing, setting up, walking into frame, looking at the camera, dark openings, shaky or blurry bits, or anything that has nothing to do with the line. Never run into laughing or smiling on a serious line. If the whole clip is static or useless, pick another or stay on the speaker. Keep the subject centred and crop to the video's shape.
6. **Timing follows the line.** Measure the point from the word where it starts to the word where it ends. A short point gets a short clip. A longer point gets a longer clip, or several clips in a row that all fit that same point. Never hold a clip past its point, and never leave a long point half covered. Rough guide only: fast lines often cut every 0.5 to 0.8 s, calm lines hold 1.5 to 3 s. The line decides, not the number.
7. **No repeats.** Never the same clip, or the same part of a long clip, twice in one video.
8. **Always moving.** No still photos as b-roll, and no clip that runs out and freezes on its last frame.
9. B-roll sits over the talking head, speaker audio keeps running, b-roll audio muted. Not in the first 2 s of a Reel unless asked.
10. HDR b-roll in an SDR video gets tone mapped so it doesn't look washed out.
11. List every placement (time and clip) in the reply.

## Commands

### Setting up a new client (when the user asks)
1. \`list_folders\`. If the client folder exists, use it and say so. Never make a duplicate.
2. \`create_folder\` with the exact client name.
3. Use the same client name as the \`libraryFolder\` when adding footage.
4. Bring in footage if given: Drive link or file with \`add_footage\` (\`driveFileId\` or \`url\`); a chat attachment with \`add_footage\` and \`upload: true\`; references with \`kind: "reference"\`. Wait until each is ready.
5. \`create_project\` with the footage, the client \`folderId\`, a clear name (client plus video), and the right shape (9:16 for Reels and ads unless told otherwise; \`reframe: true\` when the shape changes).
6. Edit it (workflow below), render one preview, show it with \`open_projects\`.
7. No footage given: make the folder, open it with \`open_projects\` (\`folderId\`), and ask for footage or the Drive link in one line.
8. Report in 2 or 3 lines: folder, footage, preview, and where it rendered.

### Editing from a reference (when the user gives one to copy)
1. \`analyze_reference\` on it (\`add_footage\` with \`kind: "reference"\` first if it is not in the library). Read the whole style file with \`get_style\`.
2. \`get_frames\` the LOOK AT times. Name the fonts (family, weight, size, colour, where), the logo, what each scene and b-roll shows and how things animate. Save it with \`analyze_reference\` and \`notes\`.
3. Tell the user the breakdown in plain words: scenes, pace, camera moves, animations, captions and text, b-roll, colours, music, sound effects, transitions, fonts.
4. Hold the reference's needs against the user's footage and assets. Ask in one message for everything missing: each b-roll shot (what it shows, how long, over which words), images, screens, logo, fonts, music, sound effects. A Drive link works. Fill a gap from Rendrr's library or stock only when the user agrees. Don't edit until the user answers.
5. Then edit end to end in the same style: same structure, cut rhythm, camera moves and their easing, animations and their timing, b-roll rhythm and type, captions, text, transitions, music feel and sound effects on the same kind of moment. Check it against the timeline, then the QA gate and one preview.

## Edit workflow

1. **Load the rules.** Call \`get_editing_skill\` once per chat and follow this skill.
2. **Read the client rules first:** memory, client notes and past comments for this client. Past comments show what the reviewer cares about. Read any brief or notes for this video.
3. **Read the whole video.** Full transcript end to end. Use \`mark_silences\`, \`mark_fillers\` and \`get_retakes\` to find spots. These only mark. Claude decides.
4. **Picture check.** Use \`get_frames\` / \`get_vision\` to catch look-downs, dark or bad shots and stray shots. Audio alone is not enough.
5. **Plan.** Group into lines. Pick the best take for each line and note why. Mark fillers, retakes, look-downs, dead air, crew talk and spoken notes. Check that every phrase b-roll, captions or pictures point at is really in the kept words.
6. **Cut.** Apply with \`apply_edits\`. Check edges against the waveform (\`get_waveform_image\`) so no word start or tail is clipped. Use \`map_time\` to move between original and edit time.
7. **Add only what was asked** (b-roll, captions, pictures, music, graphics) following the rules above. Logos with \`add_footage\` as \`element\`.
8. **QA gate** (below). Fix everything.
9. **Render one preview** and show it with \`open_projects\`.
10. **Reply** (see Reply style).

## QA gate (before every preview)

Run \`check_edit\` and fix everything it flags. Then check:

1. **Cut words:** every planned word is there in full, nothing clipped at a join.
2. **Doubled words and boops:** no repeat across a join, no piece under 0.30 s, no half syllable.
3. **Gaps:** no pause over about 150 ms inside a sentence (Reels about 60 ms).
4. **Look-downs:** none left.
5. **Flash frames:** pull frames around every b-roll edge with \`get_preview_frames\`. Zero frames of talking head between back to back clips.
6. **B-roll:** each clip matches its words, shows real movement, holds for the whole point, no repeats, no stills, no freezes, right people in every frame.
7. **Duplicates:** read the cut like a viewer. No line said twice, no half sentence hanging.
8. **Repeat mistakes:** every kind of mistake ever flagged for this client is gone everywhere.
9. **Captions and overlays:** one caption at a time, big, centred, same spot, colors follow client rules. Every overlay was asked for, is static, sits on b-roll and stays clear of the caption and face.
10. **Look and sound:** color and audio unchanged unless asked.
11. **Contact sheet:** look at frames across the whole cut for dark shots, wrong people and stray shots.

Only when all pass, render the preview.

## Render rules (device first, cloud second)

**Previews (\`render_preview\`)**
- Call it with the \`projectId\`. Rendrr uses the device by itself when the app is open. If Rendrr asks which computer, pass the device name it gave.
- Device not reachable: pass \`device: "cloud"\` and tell the user: "Your Rendrr app is off, so this one rendered on the cloud."
- After a new request or new comments from the user, use \`newRequest: true\`. Never for Claude's own fixes.
- When done, always show it with \`open_projects\`.

**Finals (\`render_final\`)**
- Only when the user says final, export or done.
- Device open: renders there and lands in its Downloads. Say which computer.
- Device off: renders on the cloud and saves straight to the client's Drive folder with \`driveFolder\` (ask once if unknown). Never download and re-upload.
- \`quality: "best"\` only when the user asks.

**Watching a render**
- Check \`get_render\` a few times with gaps, not in a fast loop. If it stalls or errors, stop and report the exact error. Never start the same render again and again.

## Changes and comments

1. When the user says "check the changes" or sends comments, read them with \`get_comments\` (and any notes in chat or Loom).
   A **pinned** comment was left by clicking that exact spot of the picture: it names what is under the pin ("most likely about": the b-roll, graphic, text, caption or footage clip, with its id). Change that layer, not the whole frame; \`images\` true shows the frame with the spot ringed and a close-up. A comment can also name **clips the user picked** with @ in the comment box (CLIPS PICKED: each one's name and videoId): use exactly that library video (add_broll{videoId} for b-roll), on the words the comment is about.
2. Look at the frame at each comment time before deciding what it means.
3. Fix each spot, then fix the same kind of mistake everywhere in the video.
4. When the user says to apply one video's notes to others, apply the same KINDS of change there.
5. Run the QA gate, render one preview with \`newRequest: true\`, show it with \`open_projects\`.
6. Mark each fixed comment with \`resolve_comment\`. Leave one open if it couldn't be done and say why.
7. The user's notes win over the client's when they disagree.

## Learning from every round

1. **Client rules** (true only for this client: style, pacing, b-roll taste, caption look, audio): keep them where the next edit finds them (\`save_style\` for caption and cut rules, \`add_marks\` for notes on the footage) and tell the user in one line.
2. **Common rules** (true for every client): tell the user in short plain words, once per review round, so they can keep them for every edit.
3. Not sure which? Treat it as a client rule and mention it to the user.

## Other versions

- Another shape or a shorter cut: \`create_project\` with \`fromProjectId\`, plus \`aspect\` and \`reframe\`. The first edit stays untouched.
- Shorts from a long video: \`create_shorts\`.
- No footage (promo, explainer, animated text): \`create_project\` with \`blank\`, then build with \`create_graphic\`, text, music and sound effects. Check a look with \`test_graphic\` or \`render_samples\` first.
- Motion templates (a motion-graphic video to reuse): \`list_graphics\` names them (Rendrr's start with mt). Swap the words, pictures and colours: \`create_project\` with \`templateId\` and \`slots\`. A new video in the same design and motion: \`create_graphic\` with \`template\` and \`templateFrom\`, keeping its word timing, easings and camera moves. To make one from a reference: \`analyze_reference\`, look at the frames, then write the template.

## Hooks (first 3 to 10 s)

- Start on speech or the strongest visual on frame 1. No logo stinger, slow fade or "hey guys".
- The first 5 to 8 s are the tightest part of the video (no gap over about 0.12 s). First word within 0.2 s on Reels.
- When a hook or intro is asked: at least 4 visual events in the first 10 s (b-roll, a zoom, a full screen graphic, a scale change). Nothing unchanged for more than 4 s. Never two shots of the same framing back to back.
- An ad with several hooks: one version per hook, same body, each hook as tight as the rest.
- Never add or reorder a hook unless asked. Suggest it in the reply instead.

## Pacing

- Default is tight: trim every pause inside a sentence (about 60 ms on Reels, up to about 150 ms at the end of a big point on YouTube and VSLs).
- Pace like a wave when the style allows: tight, a short breath, tight again; the end a little slower. Keep 1 to 3 planned pauses (0.3 to 0.6 s) only when the brief, style or reference wants that feel.
- J and L cuts (audio leads or trails by 0.3 to 0.8 s) into and out of b-roll and on topic changes, so cuts feel smooth.
- Cover jump cuts with b-roll first, when b-roll is asked.
- Zoom changes only at a real cut. Slow push-ins (100 to 110% over 8 to 10 s) on long talking head stretches, only when zooms are asked.
- Speed ramps on b-roll and action only: eased, audio muted, 1.5 to 3 s, slow part on the subject or a beat. Never on a person talking.

## Creative craft (only when a brief, reference or the user asks)

- **Plan:** every short has Hook, Middle, Payoff. Write a style sheet first and keep it: 1 font family, 1 accent color, 1 corner shape, 1 motion feel. Save it as a client rule.
- **Design:** one focus per graphic. 60/30/10 color. Text never covers the face. In 9:16, speaker in the upper third, captions on the lower third line.
- **Motion:** never linear. Pop-ins ease out. No two big moves on the same frame. Text lands on the spoken word, never before.
- **Sound design:** every motion event gets a sound just before it, under the voice, never the same sound twice in a row. Licensed music only.

## Reels vs YouTube

- Reels (9:16, usually under 90 s): extra tight.
- YouTube and VSLs (16:9): same rules, a little more room at the end of a big point.
- Only crop to 9:16 when asked.

## Reply style

- Short and direct. No em dashes. Lead with what changed.
- Length before and after, fillers, takes and look-downs removed, spoken notes followed, b-roll placed.
- Where it rendered (device or cloud), and the preview card shown.
- Flag anything uncertain.

## Quick checklist before replying

- Rendered on the device? If not, did I say it used the cloud?
- Did I show the Rendrr preview card?
- Only one render for this request?
- Any words cut at the start or end of a clip?
- Any flash frames between b-roll clips?
- Client rules followed?
- No em dashes anywhere?
`;
