# Premiere parity

The reference is storytold/filmcraft (MIT / Apache-2.0), a desktop editor built to match Premiere Pro. Its
catalogue: 93 video effects (crates/project/src/effect/vfx.rs), 27 blend modes and Time Remapping
(crates/project/src/effect.rs), 84 transitions (crates/project/src/vtransition.rs), 53 audio effects
(crates/project/src/effect/audio.rs), masks with path keyframes and tracking (crates/project/src/mask.rs). Filmcraft
itself is about 56% of Premiere by its own count and has no Object Mask (Premiere 26.0's AI subject mask).

Rendrr is a web editor that Claude drives: every feature gets an editor control, an apply_edits op, render support,
a line in the text check (get_project / render_preview), and tests. Desktop-only items (camera RAW, .prproj import,
plugin hosting, hardware I/O, localization) are out of scope.

## Phases, in order of value for talking heads, ads and short-form

1. **Subject mask (done, 30 October).** Cut the person out of their background with an AI matte (Premiere's Object
   Mask, CapCut's Remove background), on V1 clips; the background changes with what Rendrr already has
   (set_background: colour, gradient, pattern, library video, blur; set_under: any footage behind). The matte follows
   the clip's trim, speed, turn and framing. Person subjects (MediaPipe selfie segmenter, Apache-2.0, in the worker
   image). Left for later: b-roll clips, reversed clips, any object with a general model.
2. **Text behind the subject and track mattes.** 2a (done, 30 October): text layers and graphics behind the person.
   2b (done, 30 October): Track Matte Key: a video inside text, and text cut out of its card. Shape wipes move to
   phase 12's transitions.
3. **Animated and tracked masks (done, 31 October).** Mask keys on rects and ellipses, masks and effect areas that
   follow the speaker's face, darken and a spotlight, a face blur that follows. Left for later: path keyframes,
   tracking an object other than a face.
4. **Blend modes and opacity (done, 31 October)** on b-roll and graphics: 12 modes and opacity, for light leaks,
   textures and brand overlays.
5. **Deeper colour (done, 31 October).** Highlights / shadows / whites / blacks, vibrance, colour wheels, HSL
   secondaries, hue vs sat, vignette; scopes in the editor. Left for later: hue vs hue, luma vs sat, RGB parade.
6. **Audio (done, 31 October).** Crossfades at cuts, volume keyframes, pan, per-clip EQ, reverb. Left for later:
   hearing pan, EQ and reverb live in the editor (a WebAudio graph), a parametric EQ.
7. **Warp Stabilizer (done, 31 October)** for hand-held footage: vidstab's two passes, smoothness, a zoom that hides
   the edges. Left for later: stabilizing ramped clips and b-roll, showing it live in the player.
8. **Morph Cut (done, 31 October)** for jump cuts in talking heads (motion-compensated interpolation). Left for
   later: a face-aware warp, the morph live in the player.
9. **Adjustment layers (done, 31 October)** over a time range: a grade and effects on everything under them
   (footage, b-roll, graphics); text and captions stay on top as they are. Left for later: keyframed and masked
   adjustment layers, their grade in an HDR output, the full grade live in the player (it shows exposure, contrast,
   saturation, blur and darken).
10. **Multicam with audio sync (done, 31 October)** for two-camera podcasts: other cameras synced to the main video by
    their sound, cut between them by range or live from the playhead, the main sound or each camera's own. Left for
    later: syncing by timecode, a 4-up monitor that plays in step while you cut with number keys, cutting to whoever
    speaks (from the transcript's speakers).
11. **Crop, flip, anchor, drop shadow, motion blur; optical-flow slow motion and eased speed ramps (done, 31
    October).** Flip on V1 and b-roll; crop, rounded corners and a drop shadow on V1 and b-roll (b-roll cards for
    picture-in-picture); the anchor point and motion blur on keyed V1 clips, b-roll and graphics; slow motion by frame
    blending or optical flow; eased ramps. Left for later: anchor and motion blur on text layers, a border on b-roll
    cards, motion blur and optical flow live in the player.
12. **Deliverables, more effects and transitions (done, 31 October).** SRT / WebVTT with every final, YouTube
    chapters from chapter marks, GIF, sound only (.m4a, WAV), the graphics, text and captions on transparency (ProRes
    4444), bitrate and frame rate; glow, grain, RGB split, camera shake, mirror, corner pin (vignette came in phase 5);
    push, wipe, iris, cross zoom, film dissolve, clock wipe, barn doors, iris diamond. Left for later: the new effects
    live in the player, GIF longer than a minute, more shape wipes.
