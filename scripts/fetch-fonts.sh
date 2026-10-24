#!/usr/bin/env bash
# Downloads the caption and text fonts (SIL Open Font License, Google Fonts) as static TTF files into
# apps/web/public/fonts. The web app serves them; the worker image copies them for libass. Run from the repo root,
# then run scripts/make-font-metrics.py.
set -euo pipefail
out=apps/web/public/fonts
mkdir -p "$out"
fams=(
  "Inter:400,600,700,800,900"
  "Montserrat:600,800,900"
  "Poppins:600,800,900"
  "Roboto:500,900"
  "Oswald:600"
  "Bebas Neue:400"
  "Anton:400"
  "Archivo Black:400"
  "Lilita One:400"
  "Bangers:400"
  "Permanent Marker:400"
  "Playfair Display:700"
  "DM Serif Display:400"
  "Space Grotesk:700"
)
for f in "${fams[@]}"; do
  fam="${f%%:*}"; weights="${f#*:}"
  for w in ${weights//,/ }; do
    css=$(curl -fsS -A 'Mozilla/4.0' "https://fonts.googleapis.com/css?family=${fam// /+}:${w}")
    url=$(printf '%s' "$css" | grep -o 'https://fonts.gstatic.com/[^)]*\.ttf' | head -1)
    name="${fam// /}-${w}.ttf"
    curl -fsS -o "$out/$name" "$url"
    echo "$name $(wc -c < "$out/$name")"
  done
done
