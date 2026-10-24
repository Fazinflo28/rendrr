# Phase 4 plan: captions and text

Rule for every item: a UI control, an op inside apply_edits, render support, a line in render_preview's check, and tests.

## What it does

- **Caption styles.** A caption style is a set of numbers and names:
  - font and weight, size (share of the frame's short side), colour
  - stroke (colour, width), shadow (colour, offset), box (colour, opacity, padding)
  - position (x, y of the caption's bottom centre)
  - words at once, words per line, lines, case (as typed, upper, lower)
  - the active word's colour

  The three looks today (clean, bold, outline) become presets of it and look as they do now. `set_caption_style` changes any field; `set_captions{look}` starts again from a preset.
- **Text layers.** Title cards and callouts are text clips on V3 (not HTML graphics):
  - text with line breaks, the same style fields, alignment, position
  - an optional full-frame card colour behind them
  - an animation: none, fade, pop or slide

  They hang on a V1 clip like other V3 clips. Ops: `add_text`, `set_text`.
- **save_style keeps a full caption style.** `save_style{captions: {style: {...}}}` stores it, so `apply_style` (or `set_captions{styleId}`) gives any video the same captions with one setting.
- **One caption layer.** One caption is on screen at a time: a new one replaces the last (already true), with up to `lines` lines. Text layers are separate and stack in V3 order, under the captions.

## How the editor shows exactly what renders

- **Shared layout.** One function in shared code decides every caption and text layer in output pixels:
  - the lines (by words per line, then split again when a line would be wider than 90% of the frame, using the fonts' real glyph widths)
  - font size, line height, position
  - box padding, stroke and shadow sizes, colours
  - the active word, the animation at each moment
- **Render.** libass draws that layout from an ASS file. Lines are broken by us, and the file sets WrapStyle 2, so libass never re-wraps.
- **Editor.** The editor draws the same layout in an overlay sized at the output resolution (for example 960x540), scaled to the player. It uses the same font files.
- **Fonts.** Font files (SIL Open Font License, from Google Fonts) live in `apps/web/public/fonts`. The web app serves them and the worker image copies them for libass. A generated table of their metrics (advance widths, ascender, descender) lives in shared code.

## Files and data

| Area | Change |
|---|---|
| Fonts | `apps/web/public/fonts/*.ttf`, `OFL.txt`; `scripts/make-font-metrics.py` writes `packages/shared/src/fontMetrics.ts` |
| Shared `captions.ts` (new) | `CaptionStyleSchema`, the three presets, `TextLayer` fields, `layoutCaption()`, `layoutText()`, `buildAss()` (captions + text layers), `textWidth()` |
| Timeline | `captionStyle` on the timeline (full style; missing = the look's preset). V3 clips with `kind: "text"`: `text`, `style`, `card`, `anim` |
| Ops | `set_caption_style{...}`, `set_captions{styleId}`, `add_text{text, start, end, ...}`, `set_text{clipId, ...}`; `save_style` and `apply_style` carry `captions.style` |
| Render plan | Captions carry their lines and word times (active word); `plan.texts`; one ASS file for both; operations lines |
| Check | The caption line names the style. A text line lists the layers. Flags: text wider or taller than the frame, a text layer over the captions |
| Player | `liveFrame` returns the caption layout and the text layers at t; the editor draws them |
| Editor | A Text tab: caption style controls (font, weight, size, colours, stroke, shadow, box, position, words, lines, case, active word) and text layers (add at the playhead, edit, style, position, animation, card). Text clips on V3 |
| Worker | `FONTS_DIR` points at the bundled fonts; Dockerfile copies them |

## Risks

- **Rendering differences.** libass and the browser rasterise text differently (hinting, antialiasing). The layout (lines, sizes, positions, colours) is the same; the pixels can differ by a pixel at edges. A browser test compares the caption's place and size in the editor with the rendered frame.
- **Captions look a little different.** Today libass wraps captions by itself; after this, we break lines. The three looks keep their sizes, colours and boxes. Lines now break by word count and width, so a long caption can wrap in a different place.
- **Font files add about 4 MB** to the web app (loaded only when a caption or text layer uses that font) and to the worker image.
- **A box has square corners**: libass cannot round a box, so the editor does not either.
