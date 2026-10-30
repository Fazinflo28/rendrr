"""
The subject's matte: where the person is, frame by frame, as a grey video (white = subject), for remove_background.

  python matte.py --input VIDEO --from S --to S --turn 0|90|180|270 --model selfie_segmenter.tflite --out matte.mp4

Reads [from, to) of the video at its own size and frame rate, turns each frame upright (the footage's turn) for the
model, and writes the matte in the footage's own orientation, so the render puts it through the same steps as the
picture. MediaPipe's selfie segmenter (Apache-2.0) sees a 256x256 square: a tall or wide frame is read as overlapping
squares, so neither side is squashed. Its confidence is smoothed over time where the picture is still (no flicker,
moving edges follow at once), turned into a matte (smoothstep), and its edges fitted to the picture's own edges with a
guided filter at the frame's size (hair and hands follow the picture, not the model's 256 px grid).
Progress: "PROGRESS p" lines on stderr (0-100). Prints a JSON summary on stdout.
"""
import argparse, json, os, subprocess, sys, time

import cv2
import numpy as np

cv2.setNumThreads(2)
TILE = 256  # the model's input size


def probe(path):
    out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate:stream_side_data=rotation",
                          "-of", "json", path], capture_output=True, text=True, check=True).stdout
    s = json.loads(out)["streams"][0]
    num, den = (s.get("avg_frame_rate") or s.get("r_frame_rate") or "30/1").split("/")
    fps = float(num) / float(den or 1) if float(num) else 30.0
    return int(s["width"]), int(s["height"]), fps


def segmenter(model):
    import mediapipe as mp
    from mediapipe.tasks.python import BaseOptions, vision
    opts = vision.ImageSegmenterOptions(base_options=BaseOptions(model_asset_path=model), output_confidence_masks=True, output_category_mask=False,
                                        running_mode=vision.RunningMode.IMAGE)
    seg = vision.ImageSegmenter.create_from_options(opts)

    def run(rgb):
        m = seg.segment(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(rgb))).confidence_masks
        return np.asarray(m[0].numpy_view(), dtype=np.float32)
    run.close = seg.close  # closed before Python exits (its own clean-up then fails)
    return run


def squares(h, w):
    """Overlapping squares covering an h x w frame: two for a frame more than 1.25 times longer than wide, else one."""
    if h > w * 1.25:
        return [(0, 0, w), (h - w, 0, w)] + ([((h - w) // 2, 0, w)] if h > w * 1.9 else [])
    if w > h * 1.25:
        return [(0, 0, h), (0, w - h, h)] + ([(0, (w - h) // 2, h)] if w > h * 1.9 else [])
    return None


_ramps = {}


def ramp(s, n, tall):
    """A square's weight (n x n, for a square of side s): most at its centre, fading to its edges, so seams do not show."""
    key = (s, n, tall)
    if key not in _ramps:
        r = np.minimum(np.arange(n), np.arange(n)[::-1]).astype(np.float32) + 1
        k = np.minimum(r / (n * 0.15), 1)
        _ramps[key] = np.ascontiguousarray(np.broadcast_to(k[:, None] if tall else k[None, :], (n, n)))
    return _ramps[key]


def confidence(run, rgb, h, w):
    """
    The model's confidence over the whole upright frame, at h x w (the work size). A tall or wide frame: its squares
    give the detail, the whole frame (squashed into one square) says where the person is: a square that holds only a
    torso guesses at the floor and walls around it, the whole frame does not.
    """
    H, W = rgb.shape[:2]
    whole = cv2.resize(run(cv2.resize(rgb, (TILE, TILE), interpolation=cv2.INTER_AREA)), (w, h), interpolation=cv2.INTER_LINEAR)
    sq = squares(H, W)
    if not sq:
        return whole
    f = w / W
    acc = np.zeros((h, w), np.float32)
    wt = np.zeros((h, w), np.float32)
    for y, x, s in sq:
        y1, x1, n = int(round(y * f)), int(round(x * f)), min(int(round(s * f)), h, w)
        y1, x1 = min(y1, h - n), min(x1, w - n)
        c = cv2.resize(run(cv2.resize(rgb[y:y + s, x:x + s], (TILE, TILE), interpolation=cv2.INTER_AREA)), (n, n), interpolation=cv2.INTER_LINEAR)
        k = ramp(s, n, H > W)
        acc[y1:y1 + n, x1:x1 + n] += c * k
        wt[y1:y1 + n, x1:x1 + n] += k
    return acc / np.maximum(wt, 1e-6) * smoothstep(0.15, 0.5, cv2.GaussianBlur(whole, (0, 0), max(1.5, min(h, w) / 120)))


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
    ap.add_argument("--model", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--max", type=int, default=1280, help="longest side the matte is made at")
    a = ap.parse_args()

    W0, H0, fps = probe(a.input)
    k = min(1.0, a.max / max(W0, H0))
    W, H = int(round(W0 * k / 2) * 2), int(round(H0 * k / 2) * 2)
    seconds = max(0.0, a.end - a.start)
    total = max(1, int(round(seconds * fps)))
    run = segmenter(a.model)
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
        c = confidence(run, rgb, h, w)
        # Over time: where the picture has not changed, the confidence is averaged with the frame before (no flicker);
        # where it moved, the new one counts (edges follow at once).
        g = cv2.resize(cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY), (w // 2, h // 2), interpolation=cv2.INTER_AREA).astype(np.float32)
        if prev_c is not None:
            moved = cv2.GaussianBlur(cv2.resize(np.clip(np.abs(g - prev_g) / 12.0, 0, 1), (w, h), interpolation=cv2.INTER_LINEAR), (0, 0), 2)
            w_new = 0.45 + 0.55 * moved
            c = w_new * c + (1 - w_new) * prev_c
        prev_c, prev_g = c, g
        m = guided(rgb.astype(np.float32) * (1 / 255), smoothstep(0.3, 0.7, c), r, 1e-4)
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
    wr.stdin.close()
    if wr.wait() != 0:
        raise SystemExit("ffmpeg could not write the matte")
    print(json.dumps({"frames": n, "fps": fps, "width": W, "height": H, "from": a.start, "to": a.end, "seconds": round(time.time() - t0, 2)}))


if __name__ == "__main__":
    main()
