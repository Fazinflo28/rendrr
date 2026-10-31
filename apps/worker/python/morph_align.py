"""Face-aware Morph Cut for Rendrr: where the face is in A's frame (the last before a jump cut) and B's (the first
after it), and the move that takes A's head onto B's.

YuNet (OpenCV's face detector, MIT; models/yunet) finds the face and its five points in each frame. Its points are a
little noisy from frame to frame, so the move is then fitted to many more points: ORB features in the head and
shoulders of each frame, matched both ways, with a RANSAC similarity fit (shift, scale, turn). B's five points are
given back as A's points moved by that fit, so the render's own least-squares fit finds exactly that move. With too
few matches, YuNet's own points are used.

Usage: morph_align.py MODEL FRAMES W H N. FRAMES holds N pairs of frames (A then B, W x H RGB each). Prints JSON: for
each pair {"a": [[x, y] x 5], "b": [[x, y] x 5], "aBox": [x, y, w, h], "bBox": [...], "fit": "features" | "points"}
in pixels, or null when a face is not found in both.
"""
import json
import sys

import cv2
import numpy as np


def largest(det, img):
    _, faces = det.detect(cv2.cvtColor(img, cv2.COLOR_RGB2BGR))
    if faces is None or len(faces) == 0:
        return None
    return max(faces, key=lambda f: f[2] * f[3])


def region(face, w, h):
    """Head and shoulders round a face box (a mask for the features)."""
    x, y, fw, fh = face[:4]
    m = np.zeros((h, w), np.uint8)
    cx, cy = x + fw / 2, y + fh * 0.9
    cv2.ellipse(m, (int(cx), int(cy)), (int(fw * 1.6), int(fh * 1.9)), 0, 0, 360, 255, -1)
    return m


def main():
    model, path, w, h, n = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), int(sys.argv[5])
    frames = np.fromfile(path, dtype=np.uint8)[: w * h * 3 * 2 * n].reshape(-1, h, w, 3)
    det = cv2.FaceDetectorYN.create(model, "", (w, h), 0.6, 0.3, 50)
    orb = cv2.ORB_create(nfeatures=1500, scaleFactor=1.15, nlevels=6, edgeThreshold=15, patchSize=21)
    out = []
    for k in range(n):
        a, b = frames[2 * k], frames[2 * k + 1]
        fa, fb = largest(det, a), largest(det, b)
        if fa is None or fb is None:
            out.append(None)
            continue
        pa = np.array([[fa[4 + 2 * i], fa[5 + 2 * i]] for i in range(5)], np.float32)
        pb = np.array([[fb[4 + 2 * i], fb[5 + 2 * i]] for i in range(5)], np.float32)
        fit = "points"
        ga, gb = cv2.cvtColor(a, cv2.COLOR_RGB2GRAY), cv2.cvtColor(b, cv2.COLOR_RGB2GRAY)
        ka, da = orb.detectAndCompute(ga, region(fa, w, h))
        kb, db = orb.detectAndCompute(gb, region(fb, w, h))
        if da is not None and db is not None and len(ka) >= 12 and len(kb) >= 12:
            bf = cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True)
            ms = sorted(bf.match(da, db), key=lambda m: m.distance)[:400]
            if len(ms) >= 12:
                src = np.float32([ka[m.queryIdx].pt for m in ms])
                dst = np.float32([kb[m.trainIdx].pt for m in ms])
                M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=2.0, maxIters=4000, confidence=0.999)
                if M is not None and inl is not None and int(inl.sum()) >= 12:
                    # Only if it agrees with the face's own points (a match on the room behind would not).
                    moved = pa @ M[:, :2].T + M[:, 2]
                    if float(np.abs(moved - pb).mean()) < max(4.0, fa[2] * 0.12):
                        pb, fit = moved.astype(np.float32), "features"
        out.append({"a": pa.tolist(), "b": pb.tolist(), "aBox": [float(v) for v in fa[:4]], "bBox": [float(v) for v in fb[:4]], "fit": fit})
    print(json.dumps(out))


if __name__ == "__main__":
    main()
