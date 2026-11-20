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
# remove_background: two of MediaPipe's models (Apache-2.0), the person's matte (python/matte.py): the selfie segmenter
# (250 KB) finds the people, the multiclass selfie model (16 MB) cuts them out. Pinned versions, checked.
RUN mkdir -p /opt/models/selfie && cd /opt/models/selfie \
    && curl -fsSL --retry 3 -o selfie_segmenter.tflite https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite \
    && curl -fsSL --retry 3 -o selfie_multiclass_256x256.tflite https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite \
    && echo "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b  selfie_segmenter.tflite" | sha256sum -c - \
    && echo "c6748b1253a99067ef71f7e26ca71096cd449baefa8f101900ea23016507e0e0  selfie_multiclass_256x256.tflite" | sha256sum -c - \
    && echo "selfie models ready"
# Studio voice (python/voice.py): DeepFilterNet3's official ONNX export (MIT or Apache-2.0, Rikorose/DeepFilterNet at
# v0.5.6, 8 MB), the AI that takes noise and room out of the dialogue. Pinned, checked.
RUN mkdir -p /opt/models/dfn3 && cd /opt/models/dfn3 \
    && curl -fsSL --retry 3 -o dfn3.tar.gz https://raw.githubusercontent.com/Rikorose/DeepFilterNet/v0.5.6/models/DeepFilterNet3_onnx.tar.gz \
    && echo "c94d91f70911001c946e0fabb4aa9adc37045f45a03b56008cb0c8244cb63616  dfn3.tar.gz" | sha256sum -c - \
    && tar -xzf dfn3.tar.gz --strip-components=2 && rm dfn3.tar.gz \
    && echo "7c5399d3da8a50ebef1c1a0ae421b33376aa5e45d0e92df16da7e83c9c131916  enc.onnx" | sha256sum -c - \
    && echo "ab669a1d10afe20911728b33053a452071042317a90581092b325da7b2f9d895  erb_dec.onnx" | sha256sum -c - \
    && echo "23114ce3b0f6464b763ee62f7bb8aab6b2a129a21eabd5bcfe59413db05f278a  df_dec.onnx" | sha256sum -c - \
    && echo "studio voice model ready"
ENV PYTHON_BIN=/opt/venv/bin/python CHROMIUM_PATH=/usr/bin/chromium ALIGN_MODEL=/opt/models/wav2vec2/model_quantized.onnx ALIGN_VOCAB=/opt/models/wav2vec2/vocab.json MATTE_MODEL=/opt/models/selfie/selfie_multiclass_256x256.tflite MATTE_LOCATE=/opt/models/selfie/selfie_segmenter.tflite VOICE_MODELS=/opt/models/dfn3
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
# tini as process 1: it collects the processes a killed or crashed browser leaves behind. Without it they piled up as
# zombies (process 1 was npx, which collects nobody), each holding one of the container's 1000 threads, until no
# graphic or FFmpeg could start ("pthread_create() failed") for hours.
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production PORT=8080
EXPOSE 8080
WORKDIR /app/apps/worker
ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["npx", "tsx", "src/start.ts"]
