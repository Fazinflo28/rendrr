"""A reference video measured for its style (Engine Part 4.4, analyze_reference). Measurements only, no model reads it:
- on-screen text, found by its strokes (high local contrast, even stroke width, one ink colour), followed frame to frame
  at 10 fps: where it sits, how tall, its colour, an outline or a box behind it, how many words show at once, how often
  it changes, and how it comes in and goes out (pop, slide, fade, wipe; how long; how the motion eases);
- what happens at each cut, read at 30 fps on a small picture: a flash, a dip to black, a dissolve, a whip, or a cut;
- the picture's grade every 0.5 s: brightness, contrast, saturation, warmth;
- the sound: a bed under the voice in the pauses, how much its low end (40-80 Hz, under the voice) drops while someone
  speaks (ducking), and sharp hits at the cuts.

Usage: reference.py --video <proxy> --seconds <s> --w <w> --h <h> --cuts <cuts.json> --speech <speech.json> --out <out.json>
Prints PROGRESS <0-100> on stderr; writes the measurements to --out.
"""
import argparse, json, subprocess, sys
import cv2
import numpy as np

FPS = 10
TINY = 64  # the small picture's short side for the cuts pass


def progress(p):
    print(f"PROGRESS {int(p)}", file=sys.stderr, flush=True)


def hexc(bgr):
    b, g, r = [int(max(0, min(255, round(x)))) for x in bgr]
    return f"#{r:02X}{g:02X}{b:02X}"


def frames(video, w, h, fps, gray=False):
    """Frames of the video at fps, w x h, from one ffmpeg."""
    fmt, ch = ("gray", 1) if gray else ("bgr24", 3)
    p = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", video, "-an", "-vf", f"fps={fps},scale={w}:{h}:flags=area",
                          "-f", "rawvideo", "-pix_fmt", fmt, "pipe:1"], stdout=subprocess.PIPE)
    size = w * h * ch
    try:
        while True:
            b = p.stdout.read(size)
            if len(b) < size:
                break
            a = np.frombuffer(b, np.uint8)
            yield a.reshape(h, w) if gray else a.reshape(h, w, 3)
    finally:
        p.stdout.close()
        p.wait()


# ---------------------------------------------------------------------------------------------
# Text on screen
# ---------------------------------------------------------------------------------------------
def ink_of(crop_gray):
    """The text's ink in a box: split in two by brightness (Otsu); the part that fills less of the box's edge is the
    ink (the edge of a text box is mostly what is behind the letters)."""
    t, cls = cv2.threshold(crop_gray, 0, 1, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    cls = cls.astype(bool)
    edge = np.concatenate([cls[0], cls[-1], cls[:, 0], cls[:, -1]])
    light = edge.mean() < 0.5
    return (cls if light else ~cls), bool(light)


def text_lines(bgr, gray):
    """Boxes (x, y, w, h in pixels) that look like a line of overlaid text."""
    H, W = gray.shape
    grad = cv2.morphologyEx(gray, cv2.MORPH_GRADIENT, np.ones((3, 3), np.uint8))
    bw = (grad > 60).astype(np.uint8)
    kw = max(3, int(W * 0.022))
    closed = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (kw, 3)))
    n, _, stats, _ = cv2.connectedComponentsWithStats(closed, 8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = [int(v) for v in stats[i]]
        if h < H * 0.012 or h > H * 0.14 or w < h * 1.3 or w > W * 0.97:
            continue
        crop = gray[y:y + h, x:x + w]
        ink, light = ink_of(crop)
        share = float(ink.mean())
        if share < 0.12 or share > 0.75:
            continue
        # Letters: many ink runs across the middle rows, strokes of an even width, one ink colour.
        mid = ink[h // 3: max(h // 3 + 1, 2 * h // 3)]
        runs = np.mean([np.count_nonzero(r[1:] & ~r[:-1]) for r in mid]) if len(mid) else 0
        if runs < max(2, 0.8 * w / h):
            continue
        dt = cv2.distanceTransform(ink.astype(np.uint8), cv2.DIST_L2, 3)
        peaks = dt[(dt > 0) & (dt >= cv2.dilate(dt, np.ones((3, 3), np.uint8)))]
        if len(peaks) < 8:
            continue
        sw = float(np.median(peaks)) * 2
        q1, q3 = np.percentile(peaks, [25, 75])
        if (q3 - q1) / (np.median(peaks) + 1e-6) > 0.9 or sw > h * 0.35:
            continue
        cols = bgr[y:y + h, x:x + w][ink].astype(np.float32)
        if len(cols) < 10:
            continue
        if float(np.mean(np.std(cols, axis=0))) > 38:
            # One ink colour, or two (a highlighted word): each even.
            _, lab, _ = cv2.kmeans(cols, 2, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0), 1, cv2.KMEANS_PP_CENTERS)
            lab = lab.reshape(-1)
            within = sum(float(np.mean(np.std(cols[lab == k], axis=0))) * np.mean(lab == k) for k in (0, 1) if np.any(lab == k))
            if within > 30:
                continue
        out.append((x, y, w, h))
    # One line of text: boxes side by side at the same height.
    out.sort(key=lambda b: (b[1] + b[3] / 2, b[0]))
    merged = []
    for b in out:
        for k, m in enumerate(merged):
            cy, my = b[1] + b[3] / 2, m[1] + m[3] / 2
            if abs(cy - my) < 0.5 * max(b[3], m[3]) and abs(b[3] - m[3]) < 0.4 * max(b[3], m[3]) and (b[0] - (m[0] + m[2]) < 2.2 * max(b[3], m[3])) and (m[0] - (b[0] + b[2]) < 2.2 * max(b[3], m[3])):
                x0, y0 = min(b[0], m[0]), min(b[1], m[1])
                merged[k] = (x0, y0, max(b[0] + b[2], m[0] + m[2]) - x0, max(b[1] + b[3], m[1] + m[3]) - y0)
                break
        else:
            merged.append(b)
    return merged


def describe(bgr, gray, box):
    """What a line of text looks like: ink colour, outline, a box behind it, stroke weight, words, a signature."""
    x, y, w, h = box
    H, W = gray.shape
    crop, cg = bgr[y:y + h, x:x + w], gray[y:y + h, x:x + w]
    ink, light = ink_of(cg)
    cols = crop[ink].astype(np.float32)
    colour = np.median(cols, axis=0) if len(cols) else np.array([255, 255, 255])
    # Two ink colours far apart (white words, one yellow): the second is the highlight.
    hl = None
    if len(cols) > 40:
        crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0)
        _, lab, cen = cv2.kmeans(cols, 2, None, crit, 2, cv2.KMEANS_PP_CENTERS)
        cnt = np.bincount(lab.reshape(-1), minlength=2)
        main = int(np.argmax(cnt))
        if np.linalg.norm(cen[0] - cen[1]) > 90 and cnt.min() > 0.12 * cnt.sum():
            # A highlighted word is one stretch of the line in the other colour; anti-aliased edges are everywhere.
            xs = np.nonzero(ink)[1]
            lab = lab.reshape(-1)
            mx, Mx = xs[lab != main], xs[lab == main]
            lo_, hi_ = np.percentile(mx, 10), np.percentile(mx, 90)
            if (hi_ - lo_) < 0.6 * w and np.mean((Mx >= lo_) & (Mx <= hi_)) < 0.3:
                colour, hl = cen[main], cen[1 - main]
            else:
                colour = cen[main]
    # An outline: a ring just outside the ink much darker (or lighter) than the ink and than the area around.
    ink8 = ink.astype(np.uint8)
    ring = cv2.dilate(ink8, np.ones((3, 3), np.uint8), iterations=max(1, round(h * 0.06))) & (1 - ink8)
    around = cv2.dilate(ink8, np.ones((3, 3), np.uint8), iterations=max(2, round(h * 0.25))) & (1 - cv2.dilate(ink8, np.ones((3, 3), np.uint8), iterations=max(1, round(h * 0.12))))
    stroke = None
    if ring.any() and around.any():
        rl, al, il = float(np.median(cg[ring > 0])), float(np.median(cg[around > 0])), float(np.median(cg[ink]))
        if abs(il - rl) > 90 and abs(rl - al) > 35:
            stroke = {"color": hexc(np.median(crop[ring > 0], axis=0)), "widthPct": round(100 * max(1, round(h * 0.06)) / h, 1)}
    # A box behind: an even colour around the text, unlike the picture outside the box.
    pad = max(2, int(h * 0.35))
    X0, Y0, X1, Y1 = max(0, x - pad), max(0, y - pad), min(W, x + w + pad), min(H, y + h + pad)
    band = np.concatenate([bgr[Y0:y, X0:X1].reshape(-1, 3), bgr[y + h:Y1, X0:X1].reshape(-1, 3)]).astype(np.float32)
    boxc = None
    if len(band) > 20 and float(np.mean(np.std(band, axis=0))) < 14:
        # Unlike the picture well away from the text (2 to 3 heights above and below), or a strong colour itself.
        oy0, oy1, oy2, oy3 = max(0, y - 3 * h), max(0, y - 2 * h), min(H, y + 3 * h), min(H, y + 4 * h)
        outside = np.concatenate([bgr[oy0:oy1, X0:X1].reshape(-1, 3), bgr[oy2:oy3, X0:X1].reshape(-1, 3)]).astype(np.float32)
        bc = np.median(band, axis=0)
        sat = float(cv2.cvtColor(np.uint8([[bc]]), cv2.COLOR_BGR2HSV)[0, 0, 1]) / 255
        if (len(outside) and np.linalg.norm(bc - np.median(outside, axis=0)) > 30) or sat > 0.4:
            boxc = hexc(bc)
    # Stroke weight against the height: light, regular, bold, black.
    dt = cv2.distanceTransform(ink8, cv2.DIST_L2, 3)
    peaks = dt[(dt > 0) & (dt >= cv2.dilate(dt, np.ones((3, 3), np.uint8)))]
    weight = float(np.median(peaks) * 2 / h) if len(peaks) else 0.0
    # Words: gaps in the ink across the line wider than a third of its height.
    colsum = ink.any(axis=0)
    gaps, run = 0, 0
    for v in colsum:
        if not v:
            run += 1
        else:
            if run > h * 0.33:
                gaps += 1
            run = 0
    sig = cv2.resize(ink8 * 255, (32, 8), interpolation=cv2.INTER_AREA) > 127
    return {"color": hexc(colour), "highlight": hexc(hl) if hl is not None else None, "stroke": stroke, "box": boxc, "weight": round(weight, 3), "words": gaps + 1, "sig": sig, "light": bool(light)}


def iou(a, b):
    x0, y0 = max(a[0], b[0]), max(a[1], b[1])
    x1, y1 = min(a[0] + a[2], b[0] + b[2]), min(a[1] + a[3], b[1] + b[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    return inter / (a[2] * a[3] + b[2] * b[3] - inter + 1e-9)


# ---------------------------------------------------------------------------------------------
# The cuts
# ---------------------------------------------------------------------------------------------
def classify_cut(lum, sharp, k):
    """lum, sharp: per frame (30 fps) of the small picture; k: the cut's frame. What happens across it."""
    a, b = max(0, k - 8), min(len(lum), k + 9)
    L, S = lum[a:b], sharp[a:b]
    if len(L) < 6:
        return "cut", 0
    side = np.concatenate([lum[max(0, k - 14):max(0, k - 8)], lum[min(len(lum), k + 9):min(len(lum), k + 15)]])
    base = float(np.median(side)) if len(side) else float(np.median(L))
    hi, lo = float(L.max()), float(L.min())
    if hi > 0.82 and hi - base > 0.22:
        return "flash", int(np.count_nonzero(L > base + (hi - base) / 2)) * 33
    if lo < 0.07 and base > 0.15:
        return "dip-black", int(np.count_nonzero(L < base / 2)) * 33
    d = np.abs(np.diff(L))
    sb = float(np.median(np.concatenate([sharp[max(0, k - 14):max(0, k - 8)], sharp[min(len(sharp), k + 9):min(len(sharp), k + 15)]]))) if len(side) else float(np.median(S))
    if sb > 0 and float(S.min()) < 0.35 * sb:
        return "whip", int(np.count_nonzero(S < 0.6 * sb)) * 33
    return "cut", 0


# ---------------------------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--seconds", type=float, required=True)
    ap.add_argument("--w", type=int, required=True)
    ap.add_argument("--h", type=int, required=True)
    ap.add_argument("--cuts", required=True)
    ap.add_argument("--speech", required=True)
    ap.add_argument("--out", required=True)
    o = ap.parse_args()
    cuts = json.load(open(o.cuts))
    speech = json.load(open(o.speech))
    W, H, M = o.w, o.h, min(o.w, o.h)
    total = max(1, int(o.seconds * FPS))

    # 1. Text and grade at 10 fps.
    tracks, live, grade = [], [], []
    for n, bgr in enumerate(frames(o.video, W, H, FPS)):
        t = n / FPS
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        if n % 5 == 0:
            hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
            f = bgr.astype(np.float32)
            mid = (gray > 50) & (gray < 205)
            warm = float(np.mean(f[..., 2][mid] - f[..., 0][mid]) / 255) if mid.any() else 0.0
            tint = float(np.mean(f[..., 1][mid] - (f[..., 2][mid] + f[..., 0][mid]) / 2) / 255) if mid.any() else 0.0
            grade.append([round(t, 1), round(float(gray.mean()) / 255, 3), round(float(gray.std()) / 255, 3), round(float(hsv[..., 1].mean()) / 255, 3), round(warm, 3), round(tint, 3)])
        found = text_lines(bgr, gray)
        nxt = []
        for box in found:
            d = describe(bgr, gray, box)
            # The same text: on the same row (its middle within 0.6 of a line), about as tall, overlapping across.
            best, bo = None, 0
            for tr in live:
                if tr in nxt:
                    continue
                last = tr["boxes"][-1]
                same_row = abs((last[1] + last[3] / 2) - (box[1] + box[3] / 2)) < 0.6 * max(last[3], box[3]) and abs(last[3] - box[3]) < 0.5 * max(last[3], box[3])
                over = min(last[0] + last[2], box[0] + box[2]) - max(last[0], box[0])
                if same_row and over > 0 and over > bo:
                    best, bo = tr, over
            if best is None:
                best = {"start": t, "times": [], "boxes": [], "desc": [], "changes": []}
                tracks.append(best)
            elif np.mean(best["desc"][-1]["sig"] != d["sig"]) > 0.22 or abs(best["boxes"][-1][2] - box[2]) > 0.15 * box[2]:
                best["changes"].append(t)
            best["times"].append(t)
            best["boxes"].append(box)
            best["desc"].append(d)
            nxt.append(best)
        # A track missing for over 0.3 s has ended.
        live = nxt + [tr for tr in live if tr not in nxt and t - tr["times"][-1] <= 0.3]
        if n % 25 == 0:
            progress(min(70, 70 * n / total))

    # Tracks that last (0.4 s and more), with their stable box (the median of the middle part).
    texts = []
    for tr in tracks:
        if len(tr["times"]) < 4:
            continue
        bx = np.array(tr["boxes"], dtype=np.float32)
        mid = bx[len(bx) // 4: max(len(bx) // 4 + 1, 3 * len(bx) // 4)]
        x, y, w, h = [float(v) for v in np.median(mid, axis=0)]
        ds = tr["desc"]
        ent = entrance(bx, tr["times"], (x, y, w, h))
        ext = entrance(bx[::-1], tr["times"][::-1], (x, y, w, h), out=True)
        # Each chunk (from one change of the text to the next): its own entrance, against its own settled box.
        cuts_at = [0] + [tr["times"].index(c) for c in tr["changes"] if c in tr["times"]] + [len(bx)]
        chunk_in = []
        for a_, b_ in zip(cuts_at[:-1], cuts_at[1:]):
            if b_ - a_ >= 3:
                cb = bx[a_:b_]
                st = tuple(float(v) for v in np.median(cb[len(cb) // 2:], axis=0))
                chunk_in.append(entrance(cb, tr["times"][a_:b_], st)["kind"] if b_ - a_ >= 3 else "cut")
        # The main ink colour (the most frames, colours rounded), and a second colour on a share of the frames.
        q = lambda hx: tuple(int(hx[i:i + 2], 16) // 40 for i in (1, 3, 5))
        main_q = max(set(q(d["color"]) for d in ds), key=lambda c: sum(1 for d in ds if q(d["color"]) == c))
        main = np.array([[int(d["color"][i:i + 2], 16) for i in (5, 3, 1)] for d in ds if q(d["color"]) == main_q])
        cols = [hexc(np.median(main, axis=0))] * len(ds)
        rgb = lambda hx: np.array([int(hx[i:i + 2], 16) for i in (1, 3, 5)], dtype=np.float32)
        # The second colour: only highlights (never the line's main colour of another frame), the median of each channel.
        others = [rgb(d["highlight"]) for d in ds if d["highlight"] and np.linalg.norm(rgb(d["highlight"]) - rgb(cols[0])) > 70]
        others += [rgb(d["color"]) for d in ds if np.linalg.norm(rgb(d["color"]) - rgb(cols[0])) > 70 and d["highlight"]]
        hl_col = hexc(np.median(np.array(others), axis=0)[::-1]) if len(others) > 0.25 * len(ds) else None
        texts.append({
            "start": round(tr["times"][0], 2), "end": round(tr["times"][-1] + 1 / FPS, 2),
            "box": [round(x / W, 3), round(y / H, 3), round(w / W, 3), round(h / H, 3)], "height": round(h / M, 4),
            "color": cols[0], "highlight": hl_col,
            "stroke": next((d["stroke"] for d in ds if d["stroke"]), None) if sum(1 for d in ds if d["stroke"]) > len(ds) / 3 else None,
            "boxColor": next((d["box"] for d in ds if d["box"]), None) if sum(1 for d in ds if d["box"]) > len(ds) / 3 else None,
            "weight": round(float(np.median([d["weight"] for d in ds])), 3), "words": int(np.median([d["words"] for d in ds])),
            "changes": [round(c, 2) for c in tr["changes"]], "in": ent, "out": ext, "chunkIn": chunk_in,
        })
    progress(72)

    # 2. The cuts at 30 fps on a small picture.
    tw, th = (TINY, max(2, round(TINY * H / W / 2) * 2)) if W <= H else (max(2, round(TINY * W / H / 2) * 2), TINY)
    lum, sharp = [], []
    for g in frames(o.video, tw, th, 30, gray=True):
        lum.append(float(g.mean()) / 255)
        sharp.append(float(cv2.Laplacian(g, cv2.CV_32F).var()))
    lum, sharp = np.array(lum), np.array(sharp)
    trans = []
    for c in cuts:
        k = int(round(c * 30))
        if 0 < k < len(lum) - 1:
            kind, ms = classify_cut(lum, sharp, k)
            trans.append([round(c, 2), kind, ms])
    progress(85)

    # 3. The sound: 16 kHz mono; 100 ms frames of the whole level and the 40-80 Hz band (under the voice).
    a = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", o.video, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], capture_output=True).stdout
    x = np.frombuffer(a, np.float32)
    sound = None
    if len(x) > 16000:
        hop = 1600
        nfr = len(x) // hop
        fr = x[: nfr * hop].reshape(nfr, hop)
        lvl = 20 * np.log10(np.sqrt((fr ** 2).mean(axis=1)) + 1e-9)
        spec = np.abs(np.fft.rfft(fr * np.hanning(hop), axis=1))
        freqs = np.fft.rfftfreq(hop, 1 / 16000)
        lowband = (freqs >= 40) & (freqs <= 80)
        low = 20 * np.log10(np.sqrt((spec[:, lowband] ** 2).sum(axis=1)) / hop + 1e-9)
        sp = np.zeros(nfr, bool)
        for s, e in speech:
            sp[int(s * 10): int(e * 10) + 1] = True
        # Pauses: 0.4 s and longer with no speech, away from the speech's edges.
        pause = ~sp & ~np.convolve(sp, np.ones(5), "same").astype(bool)
        sound = {
            "speechDb": round(float(np.median(lvl[sp])), 1) if sp.any() else None,
            "pauseDb": round(float(np.median(lvl[pause])), 1) if pause.sum() >= 4 else None,
            "lowSpeechDb": round(float(np.median(low[sp])), 1) if sp.any() else None,
            "lowPauseDb": round(float(np.median(low[pause])), 1) if pause.sum() >= 4 else None,
            "pauseFrames": int(pause.sum()),
        }
        # Hits: a jump of 9 dB or more over the 300 ms before, at a cut (within 150 ms), not where speech starts.
        hits = []
        for c in cuts:
            i = int(round(c * 10))
            if 3 <= i < nfr - 1:
                j = i + int(np.argmax(lvl[i - 1:i + 2])) - 1
                before = float(np.median(lvl[max(0, j - 4):j - 1])) if j > 3 else lvl[j]
                starts = sp[j] and not sp[max(0, j - 2)]
                if lvl[j] - before >= 9 and not starts:
                    hits.append([round(c, 2), round(float(lvl[j]), 1)])
        sound["hitsAtCuts"] = hits
    progress(98)

    json.dump({"v": 1, "size": [W, H], "texts": texts, "transitions": trans, "grade": grade, "sound": sound}, open(o.out, "w"))
    progress(100)


def entrance(bx, times, stable, out=False):
    """How a text comes in (or, read backwards, goes out): pop (grows), slide (moves in), wipe (widens at the same
    height), or straight on; how long (ms, at 10 fps) and how the motion eases."""
    x, y, w, h = stable
    n = min(len(bx), 6)
    if n < 2:
        return {"kind": "cut", "ms": 0}
    sc = np.array([b[3] / h for b in bx[:n]])
    wd = np.array([b[2] / w for b in bx[:n]])
    dx = np.array([(b[0] + b[2] / 2) - (x + w / 2) for b in bx[:n]])
    dy = np.array([(b[1] + b[3] / 2) - (y + h / 2) for b in bx[:n]])
    settled = lambda arr, tol: next((i for i in range(n) if all(abs(v) <= tol for v in arr[i:])), n)
    if sc[0] < 0.85:
        k = settled(sc - 1, 0.06)
        prog = np.clip((sc[: k + 1] - sc[0]) / max(1e-6, 1 - sc[0]), 0, 2)
        return {"kind": "pop", "ms": int(k * 100), "from": round(float(sc[0]), 2), "easing": easing(prog)}
    if abs(dx[0]) > 0.04 * w + 2 or abs(dy[0]) > 0.25 * h + 2:
        use = dx if abs(dx[0]) >= abs(dy[0]) else dy
        k = settled(use, max(2, 0.03 * (w if use is dx else h)))
        d = ("left" if dx[0] < 0 else "right") if use is dx else ("up" if dy[0] > 0 else "down")
        prog = 1 - use[: k + 1] / (use[0] if use[0] else 1)
        return {"kind": "slide", "ms": int(k * 100), "dir": d if not out else {"left": "right", "right": "left", "up": "down", "down": "up"}[d], "px": round(float(abs(use[0])) / max(w, h), 2), "easing": easing(prog)}
    if wd[0] < 0.8:
        k = settled(wd - 1, 0.05)
        return {"kind": "wipe", "ms": int(k * 100), "easing": easing(np.clip((wd[: k + 1] - wd[0]) / max(1e-6, 1 - wd[0]), 0, 2))}
    return {"kind": "cut", "ms": 0}


def easing(p):
    """The easing a progress curve (0 to 1 over even steps) is nearest to; overshoot past 1 is a spring."""
    p = np.asarray(p, dtype=np.float64)
    if len(p) < 3:
        return None
    if p.max() > 1.04:
        return "spring"
    s = np.linspace(0, 1, len(p))
    cand = {"linear": s, "ease-out-cubic": 1 - (1 - s) ** 3, "ease-in-out": np.where(s < 0.5, 4 * s ** 3, 1 - (-2 * s + 2) ** 3 / 2)}
    return min(cand, key=lambda k: float(np.mean((cand[k] - p) ** 2)))


if __name__ == "__main__":
    main()
