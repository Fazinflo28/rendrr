"""
The subject's matte: where the person is, frame by frame, as a grey video (white = subject), for remove_background.

  python matte.py --input VIDEO --from S --to S --turn 0|90|180|270 --model selfie_multiclass_256x256.tflite
                  --locate selfie_segmenter.tflite --out matte.mp4

Reads [from, to) of the video at its own size and frame rate, turns each frame upright (the footage's turn) for the
models, and writes the matte in the footage's own orientation, so the render puts it through the same steps as the
picture. Two of MediaPipe's models (Apache-2.0), each seeing a 256x256 square: the selfie segmenter (fast, coarse)
finds where the people are in the whole frame; the multiclass selfie model (slower, much closer to the person: it
leaves out what is behind and around them, a painting's colours, a chair) reads a square centred on them, or
overlapping squares along a long frame when they are taller than it is wide. Its confidence is smoothed over time where
the picture is still (no flicker, moving edges follow at once), turned into a matte (smoothstep), and its edges fitted
to the picture's own edges with a guided filter at the frame's size (hair and hands follow the picture, not the
model's 256 px grid).
Progress: "PROGRESS p" lines on stderr (0-100). Prints a JSON summary on stdout.
"""
import argparse, json, os, subprocess, sys, time

import cv2
import numpy as np

cv2.setNumThreads(2)
TILE = 256  # the models' input size
MARGIN = 0.12  # room round the people found, as a share of their box


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    num, den = (s.get("avg_frame_rate") or s.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den or 1) if float(num) else 30.0
    return int(s["width"]), int(s["height"]), fps


def segmenter(model):
    """
    A model as a function: an RGB square in, the person's confidence (0-1, same size) out. The selfie segmenter gives
    it as its one mask; the multiclass model's first mask is the background, so the person is what is left.
    """
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    opts = vision.ImageSegmenterOptions(base_options=BaseOptions(model_asset_path=model), output_confidence_masks=True, output_category_mask=False,
                                        running_mode=vision.RunningMode.IMAGE)
    seg = vision.ImageSegmenter.create_from_options(opts)

    def run(rgb):
        m = seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))).confidence_masks
        c = np.asarray(m[0].numpy_view(), dtype=np.float32)
        c = c.reshape(c.shape[0], c.shape[1])  # the selfie segmenter's has a channel axis
        return 1 - c if len(m) > 1 else c
    run.close = seg.close  # closed before Python exits (its own clean-up then fails)
    return run


def box_of(c, W, H, least=12):
    """The box (x0, y0, x1, y1, in pixels of a W x H frame) round where c (any size) is over 0.5, or None."""
    ys, xs = np.nonzero(c > 0.5)
    if len(xs) < least:  # a few stray pixels are not a person
        return None
    fx, fy = W / c.shape[1], H / c.shape[0]
    return xs.min() * fx, ys.min() * fy, (xs.max() + 1) * fx, (ys.max() + 1) * fy


def where(locate, rgb):
    """The box round everyone the fast model finds in the whole frame (it takes in what they sit behind), or None."""
    H, W = rgb.shape[:2]
    return box_of(locate(cv2.resize(rgb, (TILE, TILE), interpolation=cv2.INTER_AREA)), W, H)


class Follow:
    """
    The box the squares are cut round, followed from frame to frame from the fine model's own reading (the person
    alone: the tighter the square, the closer the model looks). It grows at once (a hand flung out stays in), and
    shrinks a tenth of the way a frame (no jumping squares, so no flicker from the model seeing a new crop). Lost for a
    moment (a fast turn), it is kept for a second; then the fast model looks over the whole frame again.
    """
    def __init__(self, fps):
        self.box, self.lost, self.keep = None, 0, max(1, int(round(fps)))

    def update(self, b):
        if b is None:
            self.lost += 1
            if self.lost > self.keep:
                self.box = None
            return self.box
        self.lost = 0
        if self.box is None:
            self.box = b
        else:
            o = self.box
            self.box = (min(b[0], o[0] + (b[0] - o[0]) * 0.1), min(b[1], o[1] + (b[1] - o[1]) * 0.1),
                        max(b[2], o[2] + (b[2] - o[2]) * 0.1), max(b[3], o[3] + (b[3] - o[3]) * 0.1))
        return self.box


def squares(box, H, W):
    """
    Squares (y, x, side) round the box with a margin: one centred on it, as close as the person's size allows (never
    under 40% of the frame's short side); a person longer than the frame's short side gets overlapping squares along
    the frame's long side.
    """
    x0, y0, x1, y1 = box
    m = MARGIN * max(x1 - x0, y1 - y0)
    x0, y0, x1, y1 = max(0, x0 - m), max(0, y0 - m), min(W, x1 + m), min(H, y1 + m)
    short = min(H, W)
    s = int(min(short, np.ceil(max(x1 - x0, y1 - y0, 0.4 * short))))
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    place = lambda c, n: int(min(max(0, round(c - s / 2)), n - s))
    if x1 - x0 <= s and y1 - y0 <= s:
        return [(place(cy, H), place(cx, W), s)]
    tall = H > W
    a, b = (y0, y1) if tall else (x0, x1)
    n = int(np.ceil(max(0, (b - a) - s) / (0.75 * s))) + 1
    starts = np.linspace(max(0, a), min(H if tall else W, b) - s, n) if n > 1 else [a]
    return [(int(min(max(0, round(t)), H - s)), place(cx, W), s) if tall else (place(cy, H), int(min(max(0, round(t)), W - s)), s) for t in starts]


_ramps = {}


def ramp(n, tall):
    """A square's weight where squares overlap (n x n): most at its centre, fading to its edges, so seams do not show."""
    key = (n, tall)
    if key not in _ramps:
        r = np.minimum(np.arange(n), np.arange(n)[::-1]).astype(np.float32) + 1
        k = np.minimum(r / (n * 0.15), 1)
        _ramps[key] = np.ascontiguousarray(np.broadcast_to(k[:, None] if tall else k[None, :], (n, n)))
    return _ramps[key]


def confidence(run, rgb, h, w, box):
    """
    The fine model's confidence over the whole upright frame, at h x w (the work size): read in the squares round the
    box (0 outside them: no one there), or nothing at all when no one was found.
    """
    H, W = rgb.shape[:2]
    acc = np.zeros((h, w), np.float32)
    if box is None:
        return acc
    sq = squares(box, H, W)
    wt = np.zeros((h, w), np.float32)
    f = w / W
    for y, x, s in sq:
        y1, x1, n = int(round(y * f)), int(round(x * f)), min(int(round(s * f)), h, w)
        y1, x1 = min(y1, h - n), min(x1, w - n)
        c = cv2.resize(run(cv2.resize(rgb[y:y + s, x:x + s], (TILE, TILE), interpolation=cv2.INTER_AREA)), (n, n), interpolation=cv2.INTER_LINEAR)
        k = ramp(n, H > W) if len(sq) > 1 else 1.0
        acc[y1:y1 + n, x1:x1 + n] += c * k
        wt[y1:y1 + n, x1:x1 + n] += k
    return np.where(wt > 0, acc / np.maximum(wt, 1e-6), 0).astype(np.float32)


def islands(c):
    """
    Small islands the model is unsure of dropped (a painting's flower beside a hand: 1% of the person's size, 66% sure
    against 96%). An island is kept when it is at least 3% of the biggest, or the model is sure of it (a hand seen apart
    from the arm).
    """
    n, lab, st, _ = cv2.connectedComponentsWithStats((c > 0.5).astype(np.uint8), connectivity=8)
    if n <= 2:
        return c
    big = st[1:, cv2.CC_STAT_AREA].max()
    mean = np.bincount(lab.ravel(), weights=c.ravel(), minlength=n) / np.maximum(st[:, cv2.CC_STAT_AREA], 1)
    drop = [i for i in range(1, n) if st[i, cv2.CC_STAT_AREA] < 0.03 * big and mean[i] < 0.85]
    if not drop:
        return c
    gone = cv2.dilate(np.isin(lab, drop).astype(np.uint8), np.ones((5, 5), np.uint8))
    return np.where(gone > 0, 0, c).astype(np.float32)


def guided(full, p, r, eps):
    """
    He et al.'s fast guided filter with a colour guide: the matte's edges follow the picture's. p is the matte at the
    work size; its coefficients are worked out there and applied to the full-size picture (full: float RGB, 0-1).
    """
    h, w = p.shape
    H, W = full.shape[:2]
    I = cv2.resize(full, (w, h), interpolation=cv2.INTER_AREA) if (h, w) != (H, W) else full
    box = lambda x: cv2.boxFilter(x, -1, (r, r))
    mI = box(I)
    mp_ = box(p)
    cIp = box(I * p[..., None]) - mI * mp_[..., None]
    # The guide's 3x3 covariance, a little regularised, inverted per pixel.
    v = {}
    for i in range(3):
        for j in range(i, 3):
            v[i, j] = box(I[..., i] * I[..., j]) - mI[..., i] * mI[..., j] + (eps if i == j else 0)
    a00, a01, a02, a11, a12, a22 = v[0, 0], v[0, 1], v[0, 2], v[1, 1], v[1, 2], v[2, 2]
    i00 = a11 * a22 - a12 * a12
    i01 = a02 * a12 - a01 * a22
    i02 = a01 * a12 - a02 * a11
    i11 = a00 * a22 - a02 * a02
    i12 = a01 * a02 - a00 * a12
    i22 = a00 * a11 - a01 * a01
    det = a00 * i00 + a01 * i01 + a02 * i02
    ca = [(i00 * cIp[..., 0] + i01 * cIp[..., 1] + i02 * cIp[..., 2]) / det,
          (i01 * cIp[..., 0] + i11 * cIp[..., 1] + i12 * cIp[..., 2]) / det,
          (i02 * cIp[..., 0] + i12 * cIp[..., 1] + i22 * cIp[..., 2]) / det]
    b = mp_ - ca[0] * mI[..., 0] - ca[1] * mI[..., 1] - ca[2] * mI[..., 2]
    up = (lambda x: cv2.resize(box(x), (W, H), interpolation=cv2.INTER_LINEAR)) if (h, w) != (H, W) else box
    q = up(ca[0]) * full[..., 0] + up(ca[1]) * full[..., 1] + up(ca[2]) * full[..., 2] + up(b)
    return np.clip(q, 0, 1)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


def turn_up(frame, turn):
    """The footage turned upright (turn: the clockwise turn the render gives it)."""
    return np.rot90(frame, k=-(turn // 90)) if turn else frame


def turn_back(frame, turn):
    return np.rot90(frame, k=turn // 90) if turn else frame


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--from", dest="start", type=float, default=0)
    ap.add_argument("--to", dest="end", type=float, required=True)
    ap.add_argument("--turn", type=int, default=0)
    ap.add_argument("--model", required=True, help="the fine model (selfie multiclass)")
    ap.add_argument("--locate", required=True, help="the fast model that finds the people (selfie segmenter)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=1280, help="longest side the matte is made at")
    a = ap.parse_args()

    W0, H0, fps = probe(a.input)
    k = min(1.0, a.max / max(W0, H0))
    W, H = int(round(W0 * k / 2) * 2), int(round(H0 * k / 2) * 2)
    seconds = max(0.0, a.end - a.start)
    total = max(1, int(round(seconds * fps)))
    run, locate, follow = segmenter(a.model), segmenter(a.locate), Follow(fps)
    rd = subprocess.Popen(["ffmpeg", "-v", "error", "-nostdin", "-threads", "2", "-filter_threads", "1", "-ss", f"{a.start:.3f}", "-t", f"{seconds:.3f}", "-i", a.input,
                           "-vf", f"scale={W}:{H}:flags=area", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], stdout=subprocess.PIPE)
    wr = subprocess.Popen(["ffmpeg", "-v", "error", "-nostdin", "-y", "-filter_threads", "1", "-f", "rawvideo", "-pix_fmt", "gray", "-s", f"{W}x{H}", "-r", f"{fps:.6f}", "-i", "-",
                           "-c:v", "libx264", "-preset", "veryfast", "-crf", "12", "-pix_fmt", "yuv420p", "-threads", "2", "-movflags", "+faststart", a.out],
                          stdin=subprocess.PIPE)
    size = W * H * 3
    prev_c = prev_g = None
    n, last, t0 = 0, -1, time.time()
    r = max(3, int(round(min(W, H) * 0.006)) | 1)  # the filter's window at the work size (half)
    while True:
        buf = rd.stdout.read(size)
        if len(buf) < size:
            break
        rgb = turn_up(np.frombuffer(buf, np.uint8).reshape(H, W, 3), a.turn)
        uh, uw = rgb.shape[:2]
        h, w = uh // 2, uw // 2  # the work size: the model's map, smoothing and the filter's coefficients
        if follow.box is None:
            # First frame, or no one for a second: the fast model finds them, the fine one draws the box round them.
            found = where(locate, rgb)
            follow.box = found and (box_of(islands(confidence(run, rgb, h, w, found)), uw, uh) or found)
        c = confidence(run, rgb, h, w, follow.box)
        follow.update(box_of(islands(c), uw, uh))
        # Over time: where the picture has not changed, the confidence is averaged with the frame before (no flicker);
        # where it moved, the new one counts (edges follow at once).
        g = cv2.resize(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), (w // 2, h // 2), interpolation=cv2.INTER_AREA).astype(np.float32)
        if prev_c is not None:
            moved = cv2.GaussianBlur(cv2.resize(np.clip(np.abs(g - prev_g) / 12.0, 0, 1), (w, h), interpolation=cv2.INTER_LINEAR), (0, 0), 2)
            w_new = 0.45 + 0.55 * moved
            c = w_new * c + (1 - w_new) * prev_c
        prev_c, prev_g = c, g
        m = guided(rgb.astype(np.float32) * (1 / 255), smoothstep(0.3, 0.7, islands(c)), r, 1e-4)
        m = smoothstep(0.08, 0.92, m)
        out = (turn_back(m, a.turn) * 255 + 0.5).astype(np.uint8)
        wr.stdin.write(np.ascontiguousarray(out).tobytes())
        n += 1
        p = int(n * 100 / total)
        if p != last:
            last = p
            print(f"PROGRESS {min(p, 100)}", file=sys.stderr, flush=True)
    rd.wait()
    run.close()
    locate.close()
    wr.stdin.close()
    if wr.wait() != 0:
        raise SystemExit("ffmpeg could not write the matte")
    print(json.dumps({"frames": n, "fps": fps, "width": W, "height": H, "from": a.start, "to": a.end, "seconds": round(time.time() - t0, 2)}))


if __name__ == "__main__":
    main()
