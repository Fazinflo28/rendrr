"""Faces in frames, for set_framing fitFaceTo: YuNet (OpenCV's face detector, MIT) on raw RGB frames.

Usage: faces.py MODEL FRAMES W H N. FRAMES holds N frames of W x H RGB, one after another. Prints JSON: for each
frame the largest face found, {"x", "y", "w", "h", "score", "pts"} in pixels of the frame (pts: its five points, the
eyes, the nose tip and the corners of the mouth), or null when there is none.
"""
import json
import sys

import cv2
import numpy as np

model, path, w, h, n = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
frames = np.fromfile(path, dtype=np.uint8)[: w * h * 3 * n].reshape(-1, h, w, 3)
detector = cv2.FaceDetectorYN.create(model, "", (w, h), 0.6, 0.3, 50)
out = []
for frame in frames:
    _, faces = detector.detect(cv2.cvtColor(frame, cv2.COLOR_RGB2BGR))
    if faces is None or len(faces) == 0:
        out.append(None)
        continue
    best = max(faces, key=lambda f: f[2] * f[3])
    pts = [[float(best[4 + 2 * k]), float(best[5 + 2 * k])] for k in range(5)]
    out.append({"x": float(best[0]), "y": float(best[1]), "w": float(best[2]), "h": float(best[3]), "score": float(best[14]), "pts": pts})
print(json.dumps(out))
