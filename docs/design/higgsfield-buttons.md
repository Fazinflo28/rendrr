# Higgsfield buttons, mapped for Rendrr

Read from higgsfield.ai's public CSS on 27 Nov 2026 (their `q-button` system). No sign in.
Rendrr copies the flat product buttons. Higgsfield's marketing hero button (`q-button-marketing-primary`)
still has a 3px darker bottom edge and drop shadows; Rendrr does NOT copy that one.

## Sizes (height / padding / radius / text)
| Size | Height | Padding | Radius | Text |
|------|--------|---------|--------|------|
| lg | 56px | 16px 20px | 12px | 16px / 600 |
| md | 48px | 16px | 12px | 16px / 600 |
| sm | 40px | 8px 16px | 10px | 14px / 500 |
| xs | 32px | 6px 12px | 8px | 14px / 500 |
| xxs | 24px | 0 12px | 6px | 12px / 500 |
Icons: 24px (lg, md), 20px (sm), 16px (xs), 12px (xxs). Gap 6px. Icon-only: square, no side padding.

## Kinds (all flat, no shadow)
| Higgsfield | Fill | Text | Hover | Rendrr class |
|-----------|------|------|-------|--------------|
| primary | lime #d1fe17 | #1a1a1a | 20% white overlay | `.btn.primary` (lime #bde816, hover --accent-hi) |
| brand-soft | lime at 10% | lime | overlay | `.btn.lime` |
| tertiary | white 10% + blur | white | overlay | `.btn.secondary` / `.btn.quiet` (white 5%, hover 10%) |
| outline | none, 1px white 60% border | white | white 20% fill, border goes | (use quiet + border) |
| ghost | none | white | white 20% overlay | `.btn.ghost` |
| danger | red #fa0019 | white | overlay | (Rendrr has no red by design) |
| nav sign up | lime, 32px tall, radius 10px, padding 0 14px, 14px/600 | #1a1a1a | brightness .8, pressed .6 | `.btn.primary.sm` |

## States
- Hover: a see-through layer on top of the fill (white 20% by default, black 10% on light fills). Rendrr uses a lighter fill instead.
- Pressed: brightness .6 (nav). Rendrr: scale .97 and brightness .92.
- Focus: 2px page-colour gap, then a ring. Rendrr: `0 0 0 2px var(--bg), 0 0 0 4px var(--accent-ring)`.
- Disabled: 50% opacity, no clicks. Rendrr keeps its grey disabled fill.
- Motion: colour, background, border, shadow change over ~150ms, ease cubic-bezier(.4,0,.2,1).

## Copy-paste (Rendrr tokens)
```css
.btn { height: 40px; padding: 0 16px; border-radius: 12px; font-weight: 600; font-size: 14px; box-shadow: none; }
.btn.sm { height: 36px; padding: 0 12px; border-radius: 10px; }
.btn.xs { height: 28px; padding: 0 10px; border-radius: 8px; font-size: 12px; font-weight: 500; }
.btn.primary { background: var(--accent); color: var(--button-ink); }
.btn.primary:hover { background: var(--accent-hi); }
.btn.quiet { background: var(--raised); color: var(--ink); }
.btn.quiet:hover { background: var(--raised-strong); }
.btn.ghost { background: transparent; } .btn.ghost:hover { background: var(--raised); }
.btn:focus-visible { box-shadow: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent-ring); }
```
In JSX/htm: `<${Btn} kind="primary|secondary|quiet|ghost|white|lime|tertiary" size="sm|xs" icon="plus">Label<//>`.
