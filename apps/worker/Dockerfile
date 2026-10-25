# Rendrr worker: FFmpeg, Python + PySceneDetect, headless Chromium for graphics. Build context: repository root.
FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv chromium fonts-inter fonts-dejavu-core fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      ca-certificates openssl bash \
    && rm -rf /var/lib/apt/lists/*
# Fonts for motion graphics: ~80 Google Fonts families (open licences, pinned in fonts.txt), common names such as
# Arial or Georgia mapped to metric-compatible open fonts (fonts.conf). The build stops if any is missing.
COPY apps/worker/fonts.txt apps/worker/fonts.conf /tmp/fonts/
COPY apps/worker/scripts/fetch-fonts.mjs /tmp/fonts/scripts/
RUN node /tmp/fonts/scripts/fetch-fonts.mjs /usr/share/fonts/truetype/rendrr-google \
    && cp /tmp/fonts/fonts.conf /etc/fonts/local.conf && fc-cache -f \
    && for f in "Open Sans" "Montserrat" "Kalam" "Poppins" "Bebas Neue" "Playfair Display" "JetBrains Mono" "Arimo"; do [ "$(fc-match -f '%{family[0]}' "$f")" = "$f" ] || { echo "font missing: $f"; exit 1; }; done \
    && fc-match Arial | grep -q Arimo && rm -rf /tmp/fonts
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir scenedetect==0.7.2 opencv-python-headless==5.0.0.93 numpy==2.5.3
ENV PYTHON_BIN=/opt/venv/bin/python CHROMIUM_PATH=/usr/bin/chromium
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY packages/core/package.json packages/core/
COPY apps/worker/package.json apps/worker/
RUN PUPPETEER_SKIP_DOWNLOAD=1 pnpm install --frozen-lockfile --filter "@rendrr/worker..."
COPY packages packages
COPY apps/worker apps/worker
# The caption and text fonts the web app serves (render.ts reads them from here; graphics can use them too).
COPY apps/web/public/fonts apps/web/public/fonts
RUN mkdir -p /usr/share/fonts/truetype/rendrr-captions && cp apps/web/public/fonts/*.ttf /usr/share/fonts/truetype/rendrr-captions/ && fc-cache -f
RUN cd packages/db && npx prisma generate
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
WORKDIR /app/apps/worker
CMD ["npx", "tsx", "src/index.ts"]
