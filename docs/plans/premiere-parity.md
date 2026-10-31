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

## Phases 13 on: the "left for later" items, in order of value

13. **Multicam: cut to whoever speaks (done, 31 October).** Each camera's own sound every 10 ms against its room
    noise: the person loudest on their mic gets the shot; a camera must lead 0.4 s before the shot changes; shots
    shorter than the shortest shot (default 2 s) go into the one before; cuts come 0.2 s before the voice; a wide camera
    when both talk. The multicam_auto op (the server fills its plan), the editor's Cut to whoever speaks, and number
    keys 1-9 that cut live at the playhead. Left for later: speaker labels from the transcriber (one shared mic).
14. **Colour: hue vs hue, luma vs sat, RGB parade (done, 31 October).** Lumetri's Hue vs Hue (a turn by hue, greys
    left alone) and Luma vs Sat (saturation by brightness), both in the grade's LUT (49 points) so the render and the
    player draw them alike; the Color tab's six-colour and five-brightness sliders; the scopes' RGB parade.
15. **Audio live in the editor and a parametric EQ (done, 31 October).** Each clip's pan, EQ and reverb play live
    through a Web Audio chain with the render's filters and room; up to 4 parametric bells (frequency, gain, Q). The
    render's shelves moved from FFmpeg's bass/treble to lowshelf/highshelf (RBJ, Q 0.7071) and the 1 kHz bell to its Q,
    so live and rendered sound are one EQ (measured within 0.01 dB at 9 frequencies).
16. **Masked and keyframed adjustment layers (done, 31 October).** Layers take masks (rect, ellipse, path, feather,
    invert, modes) whose rect or ellipse moves with keys from the layer's start, a strength (0-1) and fades in and out.
    Render: the layer's alpha from its masks, scaled by strength and ramped by the fades; the player masks its preview
    with the same picture and sets its strength as opacity. Left for later: strength keys over time, follow face.
17. **Anchor and motion blur on text layers; a border on b-roll cards (done, 31 October).** A text layer turns and scales
    about a point of its text (the anchor grid in Speed & motion), drawn in the render and the player alike; motion blur
    on its keyed movement in the render; b-roll cards take a border that moves with them.
18. **Subject mask on b-roll and reversed clips (done, 31 October).** remove_background on b-roll over the picture (its
    own video's matte; the picture under it shows round the person) and on reversed clips (the matte read backwards in
    the picture's pieces); the person behind text works over reversed clips; a mirrored clip's matte is mirrored.
19. **The newer effects live in the player (done, 31 October)** (glow, grain, RGB split, shake, mirror): WebGL passes with
    the render's numbers, measured against the render frame by frame. Fixed with it: glow washed colours out in the render
    (FFmpeg's 16-bit screen; now float), and shake or mirror on one clip of several broke the render (non-square pixels).
20. **More shape wipes; GIFs longer than a minute (done, 31 October).** Iris box, Iris cross, Venetian blinds, Checker
    wipe and Wedge wipe (render and player from one rule); GIFs up to ten minutes at fewer frames and a smaller size.
21. **Warp Stabilizer on b-roll and ramped clips (done, 31 October).** A V1 clip with any part at another speed (a
    ramp's steps, reversed, a freeze) and stabilized b-roll read a stabilized copy of their footage: the shake measured
    over the whole clip (a second either side), written smoothed once, so a ramp is smoothed through its speed changes.
    Normal-speed V1 clips keep the in-render path. Measured: the shake drops from 22-30 to under 0.7 (half speed, a ramp,
    reversed, b-roll), no jump where a ramp changes speed.
22. **Multicam sync by timecode (done, 31 October).** Each file's start timecode is read when it is probed (MOV/MP4
    timecode tracks, drop-frame too; older videos are read on first sync). An angle is lined up by timecode when both
    files carry one; the sound checks it and wins only when it clearly disagrees (a camera not jammed) or timecode is
    missing. The angle keeps how it was synced; the editor and Claude say "by timecode, sound check N%".

Hardest, last:

23. **Mask path keyframes (done, 31 October).** A path mask (or effect area) keys its shape over time (pathKeys): each
    point moves straight to its place in the next shape; shapes with different point counts are spaced out to the same
    count along their outline first. One rule (areaAt) for the render's mask video and the player's outline and mask.
    Editor: "Key the shape here" and "Redraw here" at the playhead. Measured: the rendered mask matched the shape between
    keys on 100% of pixels away from the edge.
24. **Tracking an object other than a face (done, 31 October).** A box drawn round anything (a logo, a plate, a product)
    is followed through the clip by optical flow (feature points checked forward and back, a shift-and-scale fit,
    template matching against drift), on frames turned and fitted as the render shows them; where it is lost the box
    holds. Masks and effect areas follow it (follow "object"); text and graphics are pinned to it (keyframes made from
    the track, kept up to date after every change). Measured: the tracker stayed on a moving, growing patch (worst
    overlap 93%, centre within 0.4% of the width); in a real render the blur took a sliding square's texture from 54
    to 0.4 and a pinned title kept its place on it within 1 px while it moved 250 px.
25. **A face-aware Morph Cut.**