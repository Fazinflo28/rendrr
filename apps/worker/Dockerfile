# Rendrr worker: FFmpeg, Python + PySceneDetect, headless Chromium for graphics. Build context: repository root.
FROM node:22-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-venv chromium fonts-inter fonts-dejavu-core fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji \
      ca-certificates openssl bash curl libegl1 libegl-mesa0 libgles2 \
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
# The deeper measurements (python/deep_audio.py, align.py, vision.py): onnxruntime runs Silero VAD and wav2vec2;
# MediaPipe's face landmarker reads mouth and head pose (it loads libEGL even on the CPU). MediaPipe without its
# dependencies: they would replace OpenCV with a second, desktop build.
RUN /opt/venv/bin/pip install --no-cache-dir onnxruntime==1.31.1 absl-py==2.5.1 flatbuffers==25.12.19 certifi==2026.10.23 matplotlib==3.11.2 \
    && /opt/venv/bin/pip install --no-cache-dir --no-deps mediapipe==1.1.1 \
    && /opt/venv/bin/python -c "import cv2, onnxruntime, mediapipe; from mediapipe.tasks.python import vision"
# wav2vec2 for word alignment (facebook/wav2vec2-base-960h, Apache-2.0, as ONNX by Xenova; about 95 MB), fetched once.
# Without it the worker still measures everything and moves each word's edges onto the sound; the build says so.
RUN mkdir -p /opt/models/wav2vec2 && cd /opt/models/wav2vec2 \
    && (curl -fsSL --retry 3 -o model_quantized.onnx https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/main/onnx/model_quantized.onnx \
        && curl -fsSL --retry 3 -o vocab.json https://huggingface.co/Xenova/wav2vec2-base-960h/resolve/main/vocab.json \
        && [ "$(stat -c %s model_quantized.onnx)" -gt 50000000 ] && echo "wav2vec2 ready: $(sha256sum model_quantized.onnx)" \
        || (rm -f model_quantized.onnx vocab.json; echo "WARNING: wav2vec2 not downloaded; word alignment falls back to the sound only"))
ENV PYTHON_BIN=/opt/venv/bin/python CHROMIUM_PATH=/usr/bin/chromium ALIGN_MODEL=/opt/models/wav2vec2/model_quantized.onnx ALIGN_VOCAB=/opt/models/wav2vec2/vocab.json
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
