#!/usr/bin/env bash
# Downloads the caption and text fonts (SIL Open Font License, Google Fonts) as static TTF files into
# apps/web/public/fonts. The web app serves them; the worker image copies them for libass. Run from the repo root,
# then run scripts/make-font-metrics.py.
set -euo pipefail
out=apps/web/public/fonts
mkdir -p "$out"
fams=(
  # Engine Part 4.3: the common Google Fonts with every weight they come in.
  "Inter:100,200,300,400,500,600,700,800,900"
  "Montserrat:100,200,300,400,500,600,700,800,900"
  "Poppins:100,200,300,400,500,600,700,800,900"
  "Roboto:100,300,400,500,700,900"
  "Open Sans:300,400,500,600,700,800"
  "Oswald:200,300,400,500,600,700"
  "Bebas Neue:400"
  "Anton:400"
  "Archivo Black:400"
  "Lilita One:400"
  "Bangers:400"
  "Permanent Marker:400"
  "Kalam:300,400,700"
  "Playfair Display:400,500,600,700,800,900"
  "DM Serif Display:400"
  "Space Grotesk:300,400,500,600,700"
)
for f in "${fams[@]}"; do
  fam="${f%%:*}"; weights="${f#*:}"
  for w in ${weights//,/ }; do
    css=$(curl -fsS -A 'Mozilla/4.0' "https://fonts.googleapis.com/css?family=${fam// /+}:${w}")
    url=$(printf '%s' "$css" | grep -o 'https://fonts.gstatic.com/[^)]*\.ttf' | head -1)
    name="${fam// /}-${w}.ttf"
    if [ -f "$out/$name" ]; then continue; fi
    curl -fsS -o "$out/$name" "$url"
    echo "$name $(wc -c < "$out/$name")"
  done
done
