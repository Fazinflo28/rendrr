# MediaPipe Face Landmarker

`face_landmarker.task` (float16, version 1) from
`https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task`
(Apache-2.0, see LICENSE), run with the `mediapipe` Python package by `python/vision.py` on each face YuNet finds:
how open the mouth is (the `jawOpen` blendshape), blinks, and where the head points (yaw, pitch). It measures; it
decides nothing.

sha256 `64184e229b263107bc2b804c6625db1341ff2bb731874b0bcc2fe6544e0bc9ff`

The word aligner (wav2vec2, Apache-2.0) is not kept here: it is ~95 MB, so the worker's Dockerfile downloads
`Xenova/wav2vec2-base-960h` (`onnx/model_quantized.onnx` and `vocab.json`) from Hugging Face into
`/opt/models/wav2vec2` when the image is built.
