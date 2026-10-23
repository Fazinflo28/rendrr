"""Reads a video the way Claude needs it: frames and numbers, no thinking.

Prints one JSON object:
  samples   frames we looked at: t, brightness b, saturation s, motion m (change over 0.2 s), colours c, shot index
  loudness  dBFS per second of audio
  tempo     {bpm, confidence, beats} when the audio has a steady beat, else null
  sheets    contact sheets written to --out: file, times on its tiles

Usage: breakdown.py VIDEO --seconds S --cuts '[1.2, 4.5]' [--audio raw_s16le_mono --sr 8000] --out DIR
"""
import argparse
import json
import os
import sys

import cv2
import numpy as np

COLS, ROWS = 4, 4  # 16 frames per contact sheet
MAX_FRAMES = 400   # long videos: one frame every 5 s at most, capped here


def frame_times(seconds: float, cuts: list[float]) -> tuple[list[float], float, list[int]]:
    """Every `interval` seconds, plus the middle of every shot so even a 0.3 s shot is seen once."""
    interval = 5.0
    for step in (0.5, 1.0, 2.0, 3.0):
        if seconds / step <= 64:
            interval = step
            break
    end = max(0.0, seconds - 0.05)
    grid = [round(i * interval, 2) for i in range(int(end // interval) + 1)]
    bounds = [0.0] + [c for c in cuts if 0 < c < seconds] + [seconds]
    mids = [round((a + b) / 2, 2) for a, b in zip(bounds, bounds[1:]) if b > a]
    times = sorted(set(grid) | set(mids))
    # Drop grid frames that sit right next to a shot middle (keeps sheets readable).
    keep: list[float] = []
    mid_set = set(mids)
    for t in times:
        if keep and t - keep[-1] < 0.2 and t not in mid_set and keep[-1] not in mid_set:
            continue
        keep.append(min(t, end))
    if len(keep) > MAX_FRAMES:
        stride = len(keep) / MAX_FRAMES
        keep = [keep[int(i * stride)] for i in range(MAX_FRAMES)]
    shot_of = [max(0, sum(1 for c in bounds[1:-1] if c <= t)) for t in keep]
    return keep, interval, shot_of


def colours(small: np.ndarray, n: int = 3) -> list[str]:
    """Most common colours, from a 4-level-per-channel histogram."""
    q = (small // 64).reshape(-1, 3).astype(np.int32)
    codes = q[:, 0] * 16 + q[:, 1] * 4 + q[:, 2]
    counts = np.bincount(codes, minlength=64)
    out = []
    px = small.reshape(-1, 3)
    for code in np.argsort(counts)[::-1][:n]:
        if counts[code] == 0:
            break
        mean = px[codes == code].mean(axis=0)  # BGR
        out.append("#%02x%02x%02x" % (int(mean[2]), int(mean[1]), int(mean[0])))
    return out


def tile_size(w: int, h: int) -> tuple[int, int]:
    if w > h * 1.15:
        return 320, max(2, round(320 * h / w))
    if h > w * 1.15:
        return 200, max(2, round(200 * h / w))
    return 270, 270


def fmt(t: float) -> str:
    return f"{int(t // 60)}:{t % 60:04.1f}"


def measure(frame, later, t: float, shot: int) -> dict:
    small = cv2.resize(frame, (64, 36), interpolation=cv2.INTER_AREA)
    hsv = cv2.cvtColor(small, cv2.COLOR_BGR2HSV)
    grey = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY).astype(np.float32)
    m = 0.0
    if later is not None:
        g2 = cv2.cvtColor(cv2.resize(later, (64, 36), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY).astype(np.float32)
        m = float(np.abs(grey - g2).mean() / 255.0)
    return {
        "t": t, "shot": shot,
        "b": round(float(grey.mean() / 255.0), 3),
        "s": round(float(hsv[:, :, 1].mean() / 255.0), 3),
        "m": round(m, 4),
        "c": colours(small),
    }


def read_frames(path: str, times: list[float], shot_of: list[int]):
    """Measures each frame as it is read and keeps only its small tile, so a long video stays light in memory."""
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        raise SystemExit("could not open video")
    fps = cap.get(cv2.CAP_PROP_FPS) or 30.0
    ahead = max(1, round(fps * 0.2))
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 1280
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 720
    tw, th = tile_size(w, h)
    samples, tiles = [], []
    for t, shot in zip(times, shot_of):
        cap.set(cv2.CAP_PROP_POS_MSEC, t * 1000)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        later = None
        for _ in range(ahead):
            ok2, f2 = cap.read()
            if not ok2:
                break
            later = f2
        samples.append(measure(frame, later, t, shot))
        tiles.append((cv2.resize(frame, (tw, th), interpolation=cv2.INTER_AREA), t))
    cap.release()
    return samples, tiles, w, h


def sheets(tiles, w, h, out_dir: str):
    tw, th = tile_size(w, h)
    per = COLS * ROWS
    written = []
    for n in range(0, len(tiles), per):
        chunk = tiles[n:n + per]
        rows = (len(chunk) + COLS - 1) // COLS
        sheet = np.full((rows * th + (rows - 1) * 4, COLS * tw + (COLS - 1) * 4, 3), 24, np.uint8)
        for i, (tile, t) in enumerate(chunk):
            r, c = divmod(i, COLS)
            tile = tile.copy()
            label = fmt(t)
            (lw, lh), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.5, 1)
            cv2.rectangle(tile, (0, 0), (lw + 10, lh + 10), (0, 0, 0), -1)
            cv2.putText(tile, label, (5, lh + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
            y, x = r * (th + 4), c * (tw + 4)
            sheet[y:y + th, x:x + tw] = tile
        name = f"sheet-{len(written) + 1:03d}.jpg"
        cv2.imwrite(os.path.join(out_dir, name), sheet, [cv2.IMWRITE_JPEG_QUALITY, 80])
        written.append({"file": name, "times": [t for _, t in chunk], "cols": COLS, "rows": rows, "tile": [tw, th]})
    return written


def loudness(pcm: np.ndarray, sr: int) -> list[float]:
    out = []
    for i in range(0, len(pcm), sr):
        seg = pcm[i:i + sr].astype(np.float64)
        if len(seg) < sr // 4:
            break
        rms = np.sqrt(np.mean(seg * seg)) if len(seg) else 0.0
        out.append(round(max(-90.0, 20 * np.log10(rms / 32768.0)) if rms > 0 else -90.0, 1))
    return out


TEMPO_WINDOW = 120  # seconds of audio the beat is measured on (keeps memory small); the grid is extended after


def tempo(pcm: np.ndarray, sr: int):
    """A steady beat (music) from spectral flux autocorrelation. None when there is no clear beat."""
    if len(pcm) < sr * 6:
        return None
    total = len(pcm) / sr
    x = pcm[: sr * TEMPO_WINDOW].astype(np.float32) / 32768.0
    hop, win = 128, 512  # 16 ms hops at 8 kHz
    n = 1 + (len(x) - win) // hop
    if n < 200:
        return None
    idx = np.arange(win)[None, :] + hop * np.arange(n)[:, None]
    spec = np.abs(np.fft.rfft(x[idx] * np.hanning(win), axis=1))
    flux = np.maximum(0.0, np.diff(np.log1p(spec * 10), axis=0)).sum(axis=1)
    flux = flux - np.convolve(flux, np.ones(32) / 32, mode="same")  # remove slow loudness changes
    flux = np.maximum(flux, 0)
    if flux.std() == 0:
        return None
    flux = (flux - flux.mean()) / flux.std()
    rate = sr / hop  # onset frames per second
    lo, hi = int(np.ceil(rate * 60 / 180)), int(np.floor(rate * 60 / 70))  # 70 to 180 BPM
    ac = np.correlate(flux, flux, mode="full")[len(flux) - 1:]
    ac = ac / ac[0]
    lag = lo + int(np.argmax(ac[lo:hi + 1]))
    conf = float(ac[lag])
    bpm = 60.0 * rate / lag
    # Beat phase: the offset whose beat grid hits the most onset energy.
    phases = [flux[p::lag].sum() for p in range(lag)]
    p0 = int(np.argmax(phases))
    period = lag / rate
    beats = [round(p0 / rate + k * period, 2) for k in range(int((total - p0 / rate) / period) + 1)]
    return {"bpm": round(bpm, 1), "confidence": round(conf, 2), "beats": beats[:600]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("--seconds", type=float, required=True)
    ap.add_argument("--cuts", default="[]")
    ap.add_argument("--audio")
    ap.add_argument("--sr", type=int, default=8000)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    cuts = [float(c) for c in json.loads(a.cuts) if isinstance(c, (int, float))]
    times, interval, shot_of = frame_times(a.seconds, cuts)
    samples, tiles, w, h = read_frames(a.video, times, shot_of)
    result = {
        "interval": interval,
        "size": [w, h],
        "samples": samples,
        "sheets": sheets(tiles, w, h, a.out),
        "loudness": [],
        "tempo": None,
    }
    if a.audio and os.path.exists(a.audio) and os.path.getsize(a.audio) > 0:
        pcm = np.fromfile(a.audio, dtype="<i2")
        result["loudness"] = loudness(pcm, a.sr)
        result["tempo"] = tempo(pcm, a.sr)
    sys.stdout.write(json.dumps(result) + "\n")


if __name__ == "__main__":
    main()
