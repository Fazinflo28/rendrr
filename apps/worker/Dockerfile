# Rendrr worker: FFmpeg, Python + PySceneDetect, headless Chromium for graphics. Build context: repository root.
FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv chromium fonts-inter fonts-dejavu-core fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      ca-certificates openssl bash \
    && rm -rf /var/lib/apt/lists/*
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
# The caption and text fonts the web app serves (render.ts reads them from here).
COPY apps/web/public/fonts apps/web/public/fonts
RUN cd packages/db && npx prisma generate
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
WORKDIR /app/apps/worker
CMD ["npx", "tsx", "src/index.ts"]
