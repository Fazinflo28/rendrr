"""Object tracking for Rendrr: follow a box the user drew through a clip's frames.

Frames come as raw grey (n frames of w x h, the clip turned and fitted as the render shows it), the box at frame k0.
The box is followed forward from k0 to the last frame and backward from k0 to the first. Each step:

1. Points worth following inside the box (Shi-Tomasi corners) are moved to the next frame by pyramidal Lucas-Kanade
   optical flow; a point is kept only if flowing it back lands within a pixel of where it started (forward-backward
   check), so points that slid onto the background are dropped.
2. A similarity transform (shift and scale, RANSAC) fitted to the kept points moves and scales the box; the scale is
   held to a few percent a step, so one bad step cannot blow the box up.
3. Drift is corrected against the object's own look: the box's picture at k0 (and the last confident one), matched by
   normalised cross-correlation in a window round the new box; a clear match pulls the box to it.
4. With too few points and no clear match the object is lost there: its box stays put and its confidence is 0.

Output (stdout, JSON): one row per frame, [x0, y0, x1, y1, confidence] in shares of the frame.
Usage: track.py frames.raw w h n k0 x y bw bh   (box in pixels of the frame)
OpenCV core only (Apache-2.0); no models.
"""
import json
import sys

import cv2
import numpy as np


def main():
    raw, w, h, n, k0, bx, by, bw, bh = sys.argv[1], *map(int, sys.argv[2:6]), *map(float, sys.argv[6:10])
    # Read from the file as needed (a long clip is not held in memory twice).
    gray = np.memmap(raw, dtype=np.uint8, mode="r", shape=(n, h, w))
    box0 = clamp_box((bx, by, bw, bh), w, h)
    rows = [None] * n
    rows[k0] = (*box0, 1.0)
    for order in (range(k0, n), range(k0, -1, -1)):
        for k, b, c in follow(gray, list(order), box0, w, h):
            rows[k] = (*b, c)
    out = []
    for r in rows:
        x, y, bw_, bh_, c = r
        out.append([round(x / w, 4), round(y / h, 4), round((x + bw_) / w, 4), round((y + bh_) / h, 4), round(c, 3)])
    print(json.dumps(out))


def clamp_box(b, w, h):
    x, y, bw, bh = b
    bw = max(4.0, min(bw, w)); bh = max(4.0, min(bh, h))
    x = min(max(x, -bw * 0.5), w - bw * 0.5); y = min(max(y, -bh * 0.5), h - bh * 0.5)
    return (x, y, bw, bh)


def crop(img, b):
    x, y, bw, bh = [int(round(v)) for v in b]
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(img.shape[1], x + bw), min(img.shape[0], y + bh)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None
    return img[y0:y1, x0:x1]


def corners(img, b):
    x, y, bw, bh = b
    mask = np.zeros_like(img)
    # A little inside the box: points on its edge are often background.
    ix, iy = int(round(x + bw * 0.08)), int(round(y + bh * 0.08))
    jx, jy = int(round(x + bw * 0.92)), int(round(y + bh * 0.92))
    mask[max(0, iy):max(0, jy), max(0, ix):max(0, jx)] = 255
    return cv2.goodFeaturesToTrack(img, maxCorners=120, qualityLevel=0.01, minDistance=3, mask=mask, blockSize=5)


def match(img, tmpl, b, w, h):
    """The template's best match in a window twice the box round it: (box, score) or (None, 0)."""
    if tmpl is None:
        return None, 0.0
    x, y, bw, bh = b
    t = cv2.resize(tmpl, (max(4, int(round(bw))), max(4, int(round(bh)))), interpolation=cv2.INTER_AREA)
    wx0, wy0 = int(max(0, x - bw * 0.5)), int(max(0, y - bh * 0.5))
    wx1, wy1 = int(min(w, x + bw * 1.5)), int(min(h, y + bh * 1.5))
    win = img[wy0:wy1, wx0:wx1]
    if win.shape[0] < t.shape[0] or win.shape[1] < t.shape[1] or t.std() < 2:
        return None, 0.0
    res = cv2.matchTemplate(win, t, cv2.TM_CCOEFF_NORMED)
    _, score, _, loc = cv2.minMaxLoc(res)
    return (wx0 + loc[0], wy0 + loc[1], bw, bh), float(score)


def follow(gray, order, box0, w, h):
    lk = dict(winSize=(21, 21), maxLevel=3, criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
    first = crop(gray[order[0]], box0)
    last_good = first
    b = box0
    pts = corners(gray[order[0]], b)
    for i in range(1, len(order)):
        prev, k = order[i - 1], order[i]
        conf = 0.0
        moved = None
        if pts is not None and len(pts) >= 4:
            nxt, st, _ = cv2.calcOpticalFlowPyrLK(gray[prev], gray[k], pts, None, **lk)
            back, st2, _ = cv2.calcOpticalFlowPyrLK(gray[k], gray[prev], nxt, None, **lk)
            fb = np.linalg.norm((pts - back).reshape(-1, 2), axis=1)
            good = (st.reshape(-1) == 1) & (st2.reshape(-1) == 1) & (fb < 1.0)
            if good.sum() >= 4:
                m, inl = cv2.estimateAffinePartial2D(pts[good], nxt[good], method=cv2.RANSAC, ransacReprojThreshold=2.0)
                if m is not None:
                    s = float(np.sqrt(m[0, 0] ** 2 + m[1, 0] ** 2))
                    s = min(1.06, max(0.94, s))
                    cx, cy = b[0] + b[2] / 2, b[1] + b[3] / 2
                    ncx, ncy = m[0, 0] * cx + m[0, 1] * cy + m[0, 2], m[1, 0] * cx + m[1, 1] * cy + m[1, 2]
                    nw, nh = b[2] * s, b[3] * s
                    moved = (ncx - nw / 2, ncy - nh / 2, nw, nh)
                    conf = min(1.0, float(inl.sum()) / 12.0) if inl is not None else 0.5
                    pts = nxt[good][inl.reshape(-1) == 1] if inl is not None else nxt[good]
        guess = moved or b
        # Drift: the object's own look, at the start and at its last confident step.
        mb, ms = match(gray[k], first, guess, w, h)
        lb, ls = match(gray[k], last_good, guess, w, h)
        if ls > ms:
            mb, ms = lb, ls
        if mb is not None and ms > 0.75:
            if moved is None:
                moved, conf = mb, ms * 0.8
            else:
                # Pull toward the match by how much clearer it is.
                a = 0.5 if ms > 0.85 else 0.25
                moved = (moved[0] * (1 - a) + mb[0] * a, moved[1] * (1 - a) + mb[1] * a, moved[2], moved[3])
                conf = max(conf, ms * 0.9)
        if moved is None:
            yield k, b, 0.0
            pts = corners(gray[k], b)
            continue
        b = clamp_box(moved, w, h)
        if conf > 0.6:
            c = crop(gray[k], b)
            if c is not None:
                last_good = c
        yield k, b, conf
        # Fresh points when too few are left (the object turned or was covered for a moment).
        if pts is None or len(pts) < 20:
            pts = corners(gray[k], b)
        else:
            pts = pts.reshape(-1, 1, 2).astype(np.float32)


if __name__ == "__main__":
    main()
