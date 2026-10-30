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

1. **Subject mask (this phase).** Cut the person out of their background with an AI matte (Premiere's Object Mask,
   CapCut's Remove background), on any V1 or b-roll clip; the background changes with what Rendrr already has
   (set_background: colour, gradient, pattern, library video, blur; set_under: any footage behind). The matte follows
   the clip's trim, speed, turn and framing. Person subjects first (MediaPipe selfie segmenter, Apache-2.0, in the
   worker image); any object later with a general model.
2. **Text behind the subject and track mattes.** The subject drawn again over V3 (titles behind the person); Track
   Matte Key (video inside text, shape wipes).
3. **Animated and tracked masks.** Mask keyframes, masks that follow a face or the subject, masks that limit one
   effect (face blur that follows, spotlight, grade one area).
4. **Blend modes and opacity** on overlay layers (Screen, Multiply, Overlay, Add, Soft Light), for light leaks,
   textures and brand overlays.
5. **Deeper colour.** Highlights / shadows / whites / blacks, vibrance, colour wheels, HSL secondary, hue vs sat,
   vignette; scopes in the editor.
6. **Audio.** Crossfades at cuts, volume keyframes, pan, per-clip EQ, reverb.
7. **Warp Stabilizer** for handheld footage (shake is already measured).
8. **Morph Cut** for jump cuts in talking heads.
9. **Adjustment layers** over a time range (affect b-roll and graphics too).
10. **Multicam with audio sync** for two-camera podcasts.
11. **Crop, flip, anchor, drop shadow, motion blur on any clip**; optical-flow slow motion and eased speed ramps.
12. **Deliverables.** SRT / VTT export, export with transparency, GIF, audio only, bitrate and frame-rate settings,
    YouTube chapters from markers; more effects (glow, grain, vignette, RGB split, camera shake, mirror, corner pin) and
    transitions (push, wipes, iris, cross zoom, film dissolve).
