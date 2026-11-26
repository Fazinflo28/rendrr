"""A reference video mapped end to end (analyze_reference, part 2: the map). Measurements only, no model reads it.
reference.py reads text on screen, what happens at each cut, the grade and the sound's levels; this script adds:
- the virtual camera: zooms and pans across the whole frame (from the global motion between frames), each with its
  amount, how long it takes and how it eases;
- animations: every region that changes while the camera holds (an element that pops or scales in, slides, fades, a
  line that types itself, a picture that plays), with its place, length and easing;
- scenes: the video split at hard cuts and at full-frame changes, each scene's kind (camera footage, a still
  picture, a picture moved by the camera, a flat graphic or screen, a split screen) and its colours;
- the brand palette across the video;
- the music: where it plays, its tempo, how strong its beat is, major or minor, bright or dark, where it gets louder
  or quieter, drops out or stops, and how much it dips under the voice;
- sound effects: sharp sounds that are not the beat, each sorted by its shape (whoosh, riser, impact, click, ding,
  typing) and tied to the picture event next to it.

Only OpenCV, NumPy and FFmpeg. Usage:
reference_map.py --video <proxy> --seconds <s> --cuts <cuts.json> --speech <speech.json> --out <out.json>
Prints PROGRESS <0-100> on stderr.
"""
import argparse, json, subprocess, sys
import cv2
import numpy as np


def progress(p):
    print(f"PROGRESS {int(p)}", file=sys.stderr, flush=True)


def hexc(rgb):
    r, g, b = [int(max(0, min(255, round(float(x))))) for x in rgb]
    return f"#{r:02X}{g:02X}{b:02X}"


def r3(x):
    return round(float(x), 3)


def frames(video, w, h, fps):
    p = subprocess.Popen(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", video, "-an", "-vf", f"fps={fps},scale={w}:{h}:flags=area",
                          "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"], stdout=subprocess.PIPE)
    size = w * h * 3
    try:
        while True:
            b = p.stdout.read(size)
            if len(b) < size:
                break
            yield np.frombuffer(b, np.uint8).reshape(h, w, 3)
    finally:
        p.stdout.close()
        p.kill()
        p.wait()


def easing(p):
    """The easing a progress curve (0 to 1 over even steps) is nearest to; overshoot past 1 is a spring."""
    p = np.asarray(p, dtype=np.float64)
    if len(p) < 3:
        return "linear"
    if p.max() > 1.06:
        return "spring"
    s = np.linspace(0, 1, len(p))
    cand = {"linear": s, "ease-out": 1 - (1 - s) ** 3, "ease-in": s ** 3, "ease-in-out": np.where(s < 0.5, 4 * s ** 3, 1 - (-2 * s + 2) ** 3 / 2)}
    return min(cand, key=lambda k: float(np.mean((cand[k] - p) ** 2)))


def easing_of_speed(v):
    """Easing from a speed curve (how much moved each step): its running sum is the progress."""
    v = np.abs(np.asarray(v, dtype=np.float64))
    if v.sum() <= 0:
        return "linear"
    return easing(np.concatenate([[0], np.cumsum(v) / v.sum()]))


def frame_features(bgr, gray):
    """Flat share (8x8 blocks with almost no texture), sensor noise in the smooth parts, colourfulness, brightness."""
    h, w = gray.shape
    g = gray.astype(np.float32)
    bw, bh = max(1, w // 8), max(1, h // 8)
    m = cv2.resize(g, (bw, bh), interpolation=cv2.INTER_AREA)
    m2 = cv2.resize(g * g, (bw, bh), interpolation=cv2.INTER_AREA)
    sd = np.sqrt(np.maximum(0, m2 - m * m))
    flat = float((sd < 1.2).mean())
    lap = np.abs(cv2.Laplacian(g, cv2.CV_32F))
    smooth = cv2.resize((sd < 6).astype(np.uint8), (w, h), interpolation=cv2.INTER_NEAREST).astype(bool)
    noise = float(np.median(lap[smooth])) if smooth.mean() > 0.05 else float(np.median(lap))
    f = bgr.astype(np.float32)
    rg, yb = f[..., 2] - f[..., 1], 0.5 * (f[..., 2] + f[..., 1]) - f[..., 0]
    colourful = float(np.sqrt(rg.std() ** 2 + yb.std() ** 2) + 0.3 * np.sqrt(rg.mean() ** 2 + yb.mean() ** 2)) / 255
    return flat, noise, colourful, float(g.mean()) / 255


def split_line(gray):
    """A straight line across the whole frame between 30% and 70% (a split screen's seam): 'h', 'v' or None."""
    g = gray.astype(np.float32)
    dy = (np.abs(np.diff(g, axis=0)) > 14).mean(axis=1)
    dx = (np.abs(np.diff(g, axis=1)) > 14).mean(axis=0)
    for prof, name in ((dy, "h"), (dx, "v")):
        n = len(prof)
        a, b = int(n * 0.3), int(n * 0.7)
        seg = prof[a:b]
        if len(seg) and seg.max() > 0.92 and np.median(prof) < 0.3:
            return name
    return None


def palette(pixels, k=6):
    px = np.float32(pixels.reshape(-1, 3))
    if len(px) > 40000:
        px = px[np.random.default_rng(1).choice(len(px), 40000, replace=False)]
    k = min(k, max(1, len(px) // 50))
    crit = (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 20, 1.0)
    _, lab, cen = cv2.kmeans(px, k, None, crit, 2, cv2.KMEANS_PP_CENTERS)
    share = np.bincount(lab.ravel(), minlength=k) / len(lab)
    order = np.argsort(-share)
    return [[hexc(cen[i][::-1]), r3(share[i])] for i in order if share[i] >= 0.02]


# ---------------------------------------------------------------------------------------------------------------------
# Picture
# ---------------------------------------------------------------------------------------------------------------------
def picture(video, seconds, cuts_in):
    fps = 12 if seconds <= 360 else 6
    total = max(1, int(seconds * fps))
    src = cv2.VideoCapture(video)
    W0, H0 = src.get(cv2.CAP_PROP_FRAME_WIDTH) or 1280, src.get(cv2.CAP_PROP_FRAME_HEIGHT) or 720
    src.release()
    k = 240 / min(W0, H0)
    W, H = max(2, int(round(W0 * k / 2)) * 2), max(2, int(round(H0 * k / 2)) * 2)
    border = np.zeros((H, W), bool)
    bd = max(3, W // 40)
    border[bd:-bd, bd:-bd] = True
    rows = []  # per frame: t, scale, dx, dy, ok, changed, boxes, hist-jump
    feats = []  # every other frame: t, flat, noise, colourful, light, split
    samples = []  # one small picture a second for the palette and scene colours
    prev, prev_hist = None, None
    for n, bgr in enumerate(frames(video, W, H, fps)):
        t = n / fps
        gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
        hist = cv2.calcHist([cv2.resize(bgr, (32, 32))], [0, 1, 2], None, [8, 8, 8], [0, 256] * 3)
        hist = cv2.normalize(hist, None).flatten()
        if n % 2 == 0:
            feats.append([t, *frame_features(bgr, gray), split_line(gray)])
        if n % fps == 0:
            samples.append((t, cv2.resize(bgr, (48, int(48 * H / W))).copy()))
        if prev is not None:
            jump = 1 - float(cv2.compareHist(prev_hist, hist, cv2.HISTCMP_CORREL))
            s, dx, dy, ok = 1.0, 0.0, 0.0, False
            pts = cv2.goodFeaturesToTrack(prev, 250, 0.01, 6)
            M = None
            if pts is not None and len(pts) >= 12:
                nxt, st, _ = cv2.calcOpticalFlowPyrLK(prev, gray, pts, None, winSize=(21, 21), maxLevel=3)
                good = st.ravel() == 1
                if good.sum() >= 10:
                    M, inl = cv2.estimateAffinePartial2D(pts[good], nxt[good], method=cv2.RANSAC, ransacReprojThreshold=1.0)
                    if M is not None and inl is not None and inl.mean() > 0.5:
                        ok = True
                        s = float(np.hypot(M[0, 0], M[1, 0]))
                        cx, cy = W / 2, H / 2
                        nx, ny = M[0, 0] * cx + M[0, 1] * cy + M[0, 2], M[1, 0] * cx + M[1, 1] * cy + M[1, 2]
                        dx, dy = (nx - cx) / W, (ny - cy) / H
            warped = cv2.warpAffine(prev, M, (W, H), borderMode=cv2.BORDER_REPLICATE) if ok else prev
            diff = cv2.absdiff(warped, gray)
            diff = cv2.GaussianBlur(diff, (5, 5), 0)
            mask = ((diff > 16) & border).astype(np.uint8)
            mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
            changed = float(mask.mean())
            boxes = []
            if 0.0015 < changed < 0.6:
                cnt, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
                for c in sorted(cnt, key=cv2.contourArea, reverse=True)[:6]:
                    x, y, w, h = cv2.boundingRect(c)
                    if w * h >= 0.003 * W * H:
                        sub = mask[y:y + h, x:x + w]
                        ys, xs = np.nonzero(sub)
                        boxes.append([r3(x / W), r3(y / H), r3(w / W), r3(h / H), r3((x + xs.mean()) / W), r3((y + ys.mean()) / H), r3(len(xs) / (W * H)),
                                      r3(float(gray[y:y + h, x:x + w].mean()) / 255)])
            rows.append([t, s, dx, dy, ok, changed, boxes, jump])
        prev, prev_hist = gray, hist
        if n % 30 == 0:
            progress(min(60, 60 * n / total))
    return fps, (W, H), rows, feats, samples


def find_cuts(rows, cuts_in, fps):
    """Hard cuts: the given scene cuts, plus frames where the colours jump and the camera cannot be followed."""
    cuts = sorted(set(round(c, 2) for c in cuts_in))
    for t, s, dx, dy, ok, ch, bx, jump in rows:
        if (jump > 0.55 and (not ok or ch > 0.5)) and all(abs(t - c) > 0.3 for c in cuts):
            cuts.append(round(t, 2))
    return sorted(cuts)


def camera_moves(rows, cuts, fps):
    """Zooms and pans of the whole frame: runs of frames that move the same way."""
    if not rows:
        return []
    t = np.array([r[0] for r in rows])
    ls = np.array([np.log(r[1]) if r[4] else 0 for r in rows])
    dx = np.array([r[2] if r[4] else 0 for r in rows])
    dy = np.array([r[3] if r[4] else 0 for r in rows])
    near_cut = np.array([any(abs(x - c) < 1.5 / fps for c in cuts) for x in t])
    ls[near_cut] = dx[near_cut] = dy[near_cut] = 0
    k = np.ones(3) / 3
    ls, dx, dy = np.convolve(ls, k, "same"), np.convolve(dx, k, "same"), np.convolve(dy, k, "same")
    sp = np.abs(ls) + np.hypot(dx, dy)
    moving = (np.abs(ls) > 0.0012 * 12 / fps) | (np.hypot(dx, dy) > 0.0025 * 12 / fps)
    moves, i, n = [], 0, len(rows)
    while i < n:
        if not moving[i]:
            i += 1
            continue
        j = i
        while j + 1 < n and (moving[j + 1] or (j + 2 < n and moving[j + 2])) and not near_cut[j + 1]:
            j += 1
        seg = slice(i, j + 1)
        zoom = float(np.exp(ls[seg].sum()))
        px, py = float(-dx[seg].sum()), float(-dy[seg].sum())  # the camera moves against the picture
        dur = t[j] - t[i] + 1 / fps
        if (abs(zoom - 1) > 0.03 or np.hypot(px, py) > 0.04) and dur >= 0.25:
            kinds = []
            if abs(zoom - 1) > 0.03:
                kinds.append("zoom in" if zoom > 1 else "zoom out")
            if np.hypot(px, py) > 0.04:
                kinds.append(("pan right" if px > 0 else "pan left") if abs(px) >= abs(py) else ("pan down" if py > 0 else "pan up"))
            pace = "slow drift" if dur > 2.5 and np.max(sp[seg]) < 0.01 * 12 / fps else "move"
            moves.append({"start": r3(t[i] - 1 / fps), "end": r3(t[j]), "ms": int(round(dur * 1000)), "kind": " + ".join(kinds), "zoom": r3(zoom),
                          "pan": [r3(px), r3(py)], "easing": easing_of_speed(sp[seg]), "pace": pace})
        i = j + 1
    return moves


def animations(rows, cuts, moves, fps):
    """Regions that change while the frame holds still: elements coming in, moving, going out. Changes inside a
    camera move are left to the move (following the camera leaves small errors everywhere)."""
    in_move = lambda x: any(m["start"] <= x <= m["end"] for m in moves)
    tracks, live = [], []
    for t, s, dx, dy, ok, ch, boxes, jump in rows:
        if any(abs(t - c) < 1.5 / fps for c in cuts) or ch > 0.5 or (in_move(t) and ch < 0.25):
            live = []
            continue
        nxt = []
        for b in boxes:
            best, bo = None, 0.0
            for tr in live:
                if tr in nxt:
                    continue
                L = tr["boxes"][-1]
                ix = max(0, min(L[0] + L[2], b[0] + b[2]) - max(L[0], b[0]))
                iy = max(0, min(L[1] + L[3], b[1] + b[3]) - max(L[1], b[1]))
                inter = ix * iy
                u = L[2] * L[3] + b[2] * b[3] - inter
                iou = inter / u if u > 0 else 0
                if iou > 0.1 and iou > bo:
                    best, bo = tr, iou
            if best is None:
                best = {"times": [], "boxes": []}
                tracks.append(best)
            best["times"].append(t)
            best["boxes"].append(b)
            nxt.append(best)
        live = nxt + [tr for tr in live if tr not in nxt and t - tr["times"][-1] <= 1.5 / fps]
    # One animation beat: tracks that start together (within 0.3 s) next to each other.
    tracks.sort(key=lambda tr: tr["times"][0])
    beats = []
    for tr in tracks:
        bx = np.array(tr["boxes"], dtype=np.float64)
        u = [bx[:, 0].min(), bx[:, 1].min(), (bx[:, 0] + bx[:, 2]).max(), (bx[:, 1] + bx[:, 3]).max()]
        hit = None
        for b in beats[::-1]:
            if tr["times"][0] - b["t0"] > 0.3:
                break
            g = b["u"]
            near = not (u[0] > g[2] + 0.05 or g[0] > u[2] + 0.05 or u[1] > g[3] + 0.05 or g[1] > u[3] + 0.05)
            if near:
                hit = b
                break
        if hit is None:
            beats.append({"t0": tr["times"][0], "u": u, "frames": {}})
            hit = beats[-1]
        else:
            hit["u"] = [min(hit["u"][0], u[0]), min(hit["u"][1], u[1]), max(hit["u"][2], u[2]), max(hit["u"][3], u[3])]
        for t, b in zip(tr["times"], tr["boxes"]):
            f = hit["frames"].setdefault(t, [1, 1, 0, 0, 0])
            hit["frames"][t] = [min(f[0], b[0]), min(f[1], b[1]), max(f[2], b[0] + b[2]), max(f[3], b[1] + b[3]), f[4] + b[6]]
    out = []
    for b in beats:
        ts = sorted(b["frames"])
        if len(ts) < 2:
            continue
        fr = np.array([b["frames"][t] for t in ts])
        x0, y0, x1, y1 = b["u"]
        w, h = x1 - x0, y1 - y0
        t0, t1 = ts[0] - 1 / fps, ts[-1]
        dur = t1 - t0 + 1 / fps
        if w * h < 0.006 or dur < 0.15:
            continue
        L, T, R, B, amt = fr[:, 0], fr[:, 1], fr[:, 2], fr[:, 3], fr[:, 4]
        area = (R - L) * (B - T)
        cx, cy = (L + R) / 2, (T + B) / 2
        size_steady = area.min() > 0.6 * area.max()
        if dur > 2.5 and amt.mean() > 0.01:
            kind = "plays (moving picture)"
        elif h < 0.12 and len(ts) >= 3 and abs(L[-1] - L[0]) < 0.03 and R[-1] - R[0] > 0.05 and np.all(np.diff(R) >= -0.02):
            kind = "types on" if dur >= 0.45 else "wipes in from the left"
        elif size_steady and np.hypot(cx[-1] - cx[0], cy[-1] - cy[0]) > 0.04:
            dx_, dy_ = cx[-1] - cx[0], cy[-1] - cy[0]
            kind = "slides " + (("right" if dx_ > 0 else "left") if abs(dx_) >= abs(dy_) else ("down" if dy_ > 0 else "up"))
        elif len(ts) >= 3 and area[0] < 0.45 * area.max() and np.argmax(area) > 0:
            kind = "grows in (pop, scale or reveal)"
        elif len(ts) >= 3 and area[-1] < 0.45 * area.max() and np.argmax(area) < len(area) - 1:
            kind = "shrinks / goes out"
        elif dur <= 0.35:
            kind = "appears"
        else:
            kind = "changes"
        out.append({"start": r3(t0), "end": r3(t1), "ms": int(round(dur * 1000)), "kind": kind, "box": [r3(x0), r3(y0), r3(w), r3(h)],
                    "easing": easing_of_speed(amt) if kind not in ("plays (moving picture)", "appears") else None})
    out.sort(key=lambda a: a["start"])
    return out[:200]


def scenes(rows, feats, samples, cuts, seconds, fps, size):
    """The video split at hard cuts and full-frame changes; each part's kind and colours."""
    W, H = size
    bounds = [0.0] + [c for c in cuts if 0.2 < c < seconds - 0.2]
    for t, s, dx, dy, ok, ch, bx, jump in rows:
        if ch > 0.45 and jump > 0.25 and all(abs(t - b) > 0.6 for b in bounds):
            bounds.append(round(t, 2))
    bounds = sorted(bounds) + [seconds]
    out = []
    for a, b in zip(bounds[:-1], bounds[1:]):
        if b - a < 0.15:
            continue
        fs = [f for f in feats if a <= f[0] < b] or [min(feats, key=lambda f: abs(f[0] - (a + b) / 2))] if feats else []
        rs = [r for r in rows if a + 1.5 / fps <= r[0] < b]
        flat = float(np.median([f[1] for f in fs])) if fs else 0
        noise = float(np.median([f[2] for f in fs])) if fs else 0
        colourful = float(np.median([f[3] for f in fs])) if fs else 0
        light = float(np.median([f[4] for f in fs])) if fs else 0
        splits = [f[5] for f in fs if f[5]]
        cam = float(np.mean([abs(np.log(r[1])) + np.hypot(r[2], r[3]) for r in rs if r[4]])) if any(r[4] for r in rs) else 0
        local = float(np.median([r[5] for r in rs])) if rs else 0
        graphic = flat > 0.32 and noise < 1.6
        if splits and len(splits) > 0.6 * len(fs):
            kind = "split screen"
        elif graphic:
            kind = "graphic / screen"
        elif local < 0.004 and cam < 0.0015 * 12 / fps:
            kind = "still picture"
        elif local < 0.006:
            kind = "picture moved by the camera"
        else:
            kind = "camera footage"
        pics = [p for (t, p) in samples if a <= t < b] or ([min(samples, key=lambda s: abs(s[0] - (a + b) / 2))[1]] if samples else [])
        cols = palette(np.concatenate([p.reshape(-1, 3) for p in pics]), 4) if pics else []
        out.append({"start": r3(a), "end": r3(b), "kind": kind, "flat": r3(flat), "noise": r3(noise), "colourful": r3(colourful), "light": r3(light),
                    "split": splits[0] if splits and kind == "split screen" else None, "colours": cols})
    return out


# ---------------------------------------------------------------------------------------------------------------------
# Sound
# ---------------------------------------------------------------------------------------------------------------------
KEYS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def sound(video, seconds, speech, events):
    SR, N = 22050, 1024
    hop = 256 if seconds <= 360 else 512
    a = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", video, "-vn", "-ac", "1", "-ar", str(SR), "-f", "f32le", "pipe:1"],
                       capture_output=True, timeout=600).stdout
    x = np.frombuffer(a, np.float32)
    if len(x) < SR:
        return None, []
    freqs = np.fft.rfftfreq(N, 1 / SR)
    win = np.hanning(N).astype(np.float32)
    bands = {"low": (freqs >= 40) & (freqs < 150), "mid": (freqs >= 300) & (freqs < 4000), "high": freqs >= 4000}
    pitch = np.full(len(freqs), -1)
    ok = (freqs >= 55) & (freqs <= 2000)
    pitch[ok] = (np.round(12 * np.log2(freqs[ok] / 261.63)) % 12).astype(int)
    nfr = 1 + (len(x) - N) // hop
    rms, flux, cent, flat, low, mid, high, persist = (np.zeros(nfr, np.float32) for _ in range(8))
    chroma = np.zeros((nfr, 12), np.float32)
    prev, prev_q = None, []
    lag = max(1, int(0.25 * SR / hop))
    hist = []
    for c0 in range(0, nfr, 2048):
        c1 = min(nfr, c0 + 2048)
        idx = np.arange(c0, c1)[:, None] * hop + np.arange(N)[None, :]
        fr = x[idx] * win
        mag = np.abs(np.fft.rfft(fr, axis=1)).astype(np.float32)
        p = mag ** 2
        rms[c0:c1] = np.sqrt((fr ** 2).mean(axis=1))
        tot = p.sum(axis=1) + 1e-12
        cent[c0:c1] = (p * freqs).sum(axis=1) / tot
        mm = mag[:, bands["mid"]] + 1e-9
        flat[c0:c1] = np.exp(np.log(mm).mean(axis=1)) / mm.mean(axis=1)
        for nm, arr in (("low", low), ("mid", mid), ("high", high)):
            arr[c0:c1] = 10 * np.log10(p[:, bands[nm]].sum(axis=1) / N + 1e-12)
        lm = np.log1p(mag * 100)
        d = np.diff(np.vstack([prev[None, :] if prev is not None else lm[:1], lm]), axis=0)
        flux[c0:c1] = np.maximum(d, 0).mean(axis=1)
        prev = lm[-1]
        for k in range(12):
            chroma[c0:c1, k] = p[:, pitch == k].sum(axis=1)
        # How steady the spectrum stays over 0.25 s (held notes): music high, speech lower.
        spec = lm[:, bands["mid"]]
        hist.extend(list(spec))
    hist = np.array(hist, dtype=np.float32)
    if len(hist) > lag:
        A, B = hist[:-lag], hist[lag:]
        num = (A * B).sum(axis=1)
        den = np.linalg.norm(A, axis=1) * np.linalg.norm(B, axis=1) + 1e-9
        persist[:-lag] = num / den
    del hist
    fps_a = SR / hop
    tt = np.arange(nfr) / fps_a
    db = 20 * np.log10(rms + 1e-9)
    sp = np.zeros(nfr, bool)
    for s, e in speech:
        sp[int(s * fps_a): int(e * fps_a) + 1] = True

    # Music per second: the beat's strength over 6 s around it (the onset curve's self-likeness at a tempo between 60
    # and 190 bpm), and held notes in the pauses.
    on = flux - np.convolve(flux, np.ones(int(fps_a)) / int(fps_a), "same")
    on = np.maximum(on, 0)
    secs = int(np.ceil(seconds))
    music = []
    lo, hi = int(fps_a * 60 / 190), int(fps_a * 60 / 60)
    for s in range(secs):
        a_, b_ = int(max(0, s - 2.5) * fps_a), int(min(seconds, s + 3.5) * fps_a)
        seg = on[a_:b_]
        if len(seg) < hi * 2 or db[a_:b_].max() < -55:
            music.append([s, 0.0, None, float(np.median(db[a_:b_])) if b_ > a_ else -90])
            continue
        seg = seg - seg.mean()
        ac = np.correlate(seg, seg, "full")[len(seg) - 1:]
        if ac[0] <= 0:
            music.append([s, 0.0, None, float(np.median(db[a_:b_]))])
            continue
        ac = ac / ac[0]
        L = int(np.argmax(ac[lo:hi])) + lo
        strength = float(ac[L])
        # Prefer a tempo between 80 and 160 (half and double are the same beat).
        bpm = 60 * fps_a / L
        while bpm < 80:
            bpm *= 2
        while bpm > 165:
            bpm /= 2
        held = float(np.median(persist[int(s * fps_a): int((s + 1) * fps_a)])) if s * fps_a < nfr else 0
        music.append([s, strength, round(bpm, 1), float(np.median(db[int(s * fps_a): int((s + 1) * fps_a)])) if s * fps_a < nfr else -90, held])
    # A second has music when the beat is clear, or notes are held while nobody speaks, and it is not near silence.
    has = []
    for m in music:
        s = m[0]
        held = m[4] if len(m) > 4 else 0
        quiet_voice = not sp[int(s * fps_a): int((s + 1) * fps_a)].mean() > 0.5 if s * fps_a < nfr else True
        has.append(m[3] > -50 and (m[1] > 0.32 or (quiet_voice and held > 0.86)))
    has = np.array(has, bool)
    # Fill one-second holes, drop lone seconds.
    for i in range(1, len(has) - 1):
        if not has[i] and has[i - 1] and has[i + 1]:
            has[i] = True
    for i in range(len(has)):
        if has[i] and not (i > 0 and has[i - 1]) and not (i + 1 < len(has) and has[i + 1]):
            has[i] = False
    sections = []
    i = 0
    while i < len(has):
        if not has[i]:
            i += 1
            continue
        j = i
        while j + 1 < len(has) and has[j + 1]:
            j += 1
        a_, b_ = i, min(seconds, j + 1)
        fa, fb = int(a_ * fps_a), min(nfr, int(b_ * fps_a))
        bpms = [m[2] for m in music[i:j + 1] if m[2] and m[1] > 0.25]
        beat = float(np.median([m[1] for m in music[i:j + 1]]))
        ch = chroma[fa:fb].sum(axis=0)
        key, mode = None, None
        if ch.sum() > 0:
            ch = ch / ch.sum()
            best = max(((np.corrcoef(np.roll(prof, k), ch)[0, 1], k, md) for k in range(12) for prof, md in ((MAJOR, "major"), (MINOR, "minor"))))
            key, mode = KEYS[best[1]], best[2]
        bright = float(np.median(cent[fa:fb]))
        quiet = ~sp[fa:fb]
        # The music's low end while someone speaks against in the pauses: how much it dips under the voice.
        duck = None
        if quiet.sum() > fps_a * 0.6 and (~quiet).sum() > fps_a * 0.6:
            duck = round(float(np.median(low[fa:fb][quiet]) - np.median(low[fa:fb][~quiet])), 1)
        level = [round(float(np.median(db[int(s * fps_a): int((s + 1) * fps_a)])), 1) for s in range(a_, int(b_)) if s * fps_a < nfr]
        sections.append({"start": float(a_), "end": round(float(b_), 2), "bpm": round(float(np.median(bpms)), 1) if bpms else None, "beat": r3(beat),
                         "key": key, "mode": mode, "brightHz": int(bright), "duckDb": duck, "levelDb": level,
                         "underVoice": bool(sp[fa:fb].mean() > 0.3)})
        i = j + 1
    # Changes in the music: a jump of 6 dB between two-second halves (gets louder / drops), inside a section.
    changes = []
    for sct in sections:
        lv = sct["levelDb"]
        for k in range(2, len(lv) - 1):
            before, after = np.median(lv[max(0, k - 2):k]), np.median(lv[k:k + 2])
            if abs(after - before) >= 6 and all(abs(c[0] - (sct["start"] + k)) > 2 for c in changes):
                changes.append([sct["start"] + k, "gets louder" if after > before else "drops quieter", round(float(after - before), 1)])

    # Sound effects: onsets well above their surroundings that are not on the beat, or sit next to a picture event.
    peaks = []
    med = np.convolve(flux, np.ones(int(fps_a * 2)) / int(fps_a * 2), "same")
    mad = np.convolve(np.abs(flux - med), np.ones(int(fps_a * 2)) / int(fps_a * 2), "same") + 1e-6
    z = (flux - med) / mad
    gap = int(0.12 * fps_a)
    for i in range(2, nfr - 2):
        if z[i] > 5 and z[i] == z[max(0, i - gap):i + gap + 1].max():
            peaks.append(i)
    sec_music = lambda t: bool(has[min(len(has) - 1, int(t))]) if len(has) else False
    sfx = []
    for i in peaks:
        t = tt[i]
        pk = i + int(np.argmax(db[i:i + int(0.25 * fps_a)]))
        before = float(np.median(db[max(0, i - int(0.3 * fps_a)):max(1, i - 1)]))
        jump = db[pk] - before
        if jump < 6:
            continue
        # How long it lasts: until it falls 12 dB under its peak.
        e = pk
        floor = max(db[pk] - 12, before + 3)
        while e + 1 < nfr and db[e + 1] > floor and e - pk < 2 * fps_a:
            e += 1
        # A slow build before the onset counts too (a whoosh or riser rises into its peak).
        s0 = i
        while s0 - 1 > 0 and db[s0 - 1] < db[s0] and db[s0 - 1] > db[pk] - 18 and i - s0 < 2 * fps_a:
            s0 -= 1
        dur = (e - s0 + 1) / fps_a
        attack = (pk - s0) / fps_a
        f_ = float(np.mean(flat[s0:e + 1]))
        c_ = cent[s0:e + 1]
        rising = len(c_) > 4 and np.polyfit(np.arange(len(c_)), c_, 1)[0] > 0
        lowshare = float(np.mean(low[pk:e + 1] - mid[pk:e + 1]))
        tonal = float(np.mean(persist[pk:e + 1])) > 0.9 and f_ < 0.2
        if dur > 1.0 and attack > 0.5 and rising:
            kind = "riser"
        elif f_ > 0.3 and 0.12 <= dur <= 1.6 and attack >= 0.04:
            kind = "whoosh"
        elif attack < 0.03 and lowshare > 3:
            kind = "impact / boom"
        elif dur < 0.12 and float(np.median(c_)) > 2500:
            kind = "click / pop"
        elif tonal and float(np.median(c_)) > 1200 and dur > 0.2:
            kind = "ding / chime"
        else:
            kind = "hit"
        near = min(events, key=lambda ev: abs(ev[0] - t)) if events else None
        near = near if near and abs(near[0] - t) <= 0.2 else None
        in_speech = bool(sp[i])
        on_beat = sec_music(t) and kind in ("hit", "impact / boom", "click / pop")
        # Keep it when a picture event is next to it, or its shape is clearly an effect, and it is not a syllable.
        if near is None and (on_beat or kind == "hit" or (in_speech and kind not in ("whoosh", "riser", "ding / chime"))):
            continue
        # Under music an effect has to stand out clearly or sit on a picture event.
        if sec_music(t) and near is None and jump < 10:
            continue
        sfx.append({"t": r3(tt[s0]), "kind": kind, "ms": int(round(dur * 1000)), "db": round(float(db[pk]), 1), "jumpDb": round(float(jump), 1),
                    "near": [r3(near[0]), near[1]] if near else None})
    # Many clicks close together: typing.
    merged, k = [], 0
    while k < len(sfx):
        j = k
        while j + 1 < len(sfx) and sfx[j + 1]["kind"] in ("click / pop", "hit") and sfx[j + 1]["t"] - sfx[j]["t"] < 0.35 and sfx[k]["kind"] in ("click / pop", "hit"):
            j += 1
        if j - k >= 3:
            merged.append({**sfx[k], "kind": "typing / keyboard", "ms": int(round((sfx[j]["t"] - sfx[k]["t"]) * 1000)) + sfx[j]["ms"], "count": j - k + 1})
        else:
            merged.extend(sfx[k:j + 1])
        k = j + 1
    loud = [round(float(np.median(db[int(s * fps_a): int((s + 1) * fps_a)])), 1) for s in range(secs) if s * fps_a < nfr]
    return {"sections": sections, "changes": changes, "musicSeconds": int(has.sum()), "levelDb": loud,
            "stops": [s["end"] for s in sections if s["end"] < seconds - 1.0]}, merged[:200]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--video", required=True)
    ap.add_argument("--seconds", type=float, required=True)
    ap.add_argument("--cuts", required=True)
    ap.add_argument("--speech", required=True)
    ap.add_argument("--out", required=True)
    o = ap.parse_args()
    cuts_in = json.load(open(o.cuts))
    speech = json.load(open(o.speech))
    fps, size, rows, feats, samples = picture(o.video, o.seconds, cuts_in)
    cuts = find_cuts(rows, cuts_in, fps)
    progress(62)
    moves = camera_moves(rows, cuts, fps)
    anims = animations(rows, cuts, moves, fps)
    progress(68)
    scs = scenes(rows, feats, samples, cuts, o.seconds, fps, size)
    pal = palette(np.concatenate([p.reshape(-1, 3) for _, p in samples]), 6) if samples else []
    progress(72)
    events = [[c, "cut"] for c in cuts] + [[s["start"], "scene change"] for s in scs[1:]] + [[m["start"], "camera " + m["kind"]] for m in moves] + \
             [[a["start"], "animation " + a["kind"]] for a in anims]
    events.sort(key=lambda e: e[0])
    music, sfx = sound(o.video, o.seconds, speech, events)
    progress(98)
    json.dump({"v": 1, "fps": fps, "size": list(size), "cuts": cuts, "moves": moves, "animations": anims, "scenes": scs, "palette": pal,
               "music": music, "sfx": sfx}, open(o.out, "w"))
    progress(100)


if __name__ == "__main__":
    main()
