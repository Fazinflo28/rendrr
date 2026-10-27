"""What the picture does, measured: faces 10 times a second (YuNet finds them, MediaPipe's face landmarker reads each
one on a crop: how open the mouth is, where the head turns) tracked across frames, and every 0.5 s the motion, camera
shake, sharpness, brightness, main colours and how well the face is exposed. Measurements only.

Usage: vision.py --video <proxy> --w <frame width> --h <frame height> --seconds <s> --yunet <onnx> --landmarker <task>
                 --out <details.json>
Writes the per-frame details to --out and prints the summary as JSON on the last line. Progress: "PROGRESS <0-100>".
"""
import argparse, json, subprocess, sys
import cv2
import numpy as np

FPS = 10
EVERY = 5  # metrics every 5th frame (0.5 s)


def progress(p):
    print(f"PROGRESS {int(p)}", file=sys.stderr, flush=True)


def iou(a, b):
    ax, ay, aw, ah = a; bx, by, bw, bh = b
    x0, y0, x1, y1 = max(ax, bx), max(ay, by), min(ax + aw, bx + bw), min(ay + ah, by + bh)
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    return inter / (aw * ah + bw * bh - inter + 1e-9)


def head_pose(m):
    """Yaw (+ = the head turns to the frame's left), pitch (+ = down) and roll in degrees from MediaPipe's matrix."""
    m = np.asarray(m)
    yaw = float(np.degrees(np.arctan2(m[0, 2], m[2, 2])))
    pitch = float(np.degrees(np.arcsin(np.clip(-m[1, 2], -1, 1))))
    roll = float(np.degrees(np.arctan2(m[1, 0], m[1, 1])))
    return yaw, pitch, roll


def colours(bgr):
    small = cv2.resize(bgr, (48, 27), interpolation=cv2.INTER_AREA).reshape(-1, 3).astype(np.float32)
    _, labels, centers = cv2.kmeans(small, 3, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 10, 1.0), 2, cv2.KMEANS_PP_CENTERS)
    order = np.argsort(-np.bincount(labels.reshape(-1), minlength=3))
    return ["#%02x%02x%02x" % (int(centers[i][2]), int(centers[i][1]), int(centers[i][0])) for i in order]


def ranges(flags, times, min_len, gap=0.6, step=1 / FPS, end=None):
    """Stretches where flags is true for at least min_len seconds (gaps under `gap` joined); each sample covers `step`
    seconds from its time, and nothing runs past `end`."""
    out = []
    for f, t in zip(flags, times):
        if not f:
            continue
        if out and t - out[-1][1] <= gap:
            out[-1][1] = t
        else:
            out.append([t, t])
    res = [[round(a, 2), round(min(b + step, end if end is not None else b + step), 2)] for a, b in out]
    return [r for r in res if r[1] - r[0] >= min_len - 1e-9]


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--video", required=True)
    a.add_argument("--w", type=int, required=True)
    a.add_argument("--h", type=int, required=True)
    a.add_argument("--seconds", type=float, required=True)
    a.add_argument("--yunet", required=True)
    a.add_argument("--landmarker", required=True)
    a.add_argument("--out", required=True)
    o = a.parse_args()
    W, H = o.w, o.h

    det = cv2.FaceDetectorYN.create(o.yunet, "", (W, H), 0.6, 0.3, 5000)
    lm = None
    try:
        import mediapipe as mp
        from mediapipe.tasks.python import BaseOptions, vision as mpv
        lm = mpv.FaceLandmarker.create_from_options(mpv.FaceLandmarkerOptions(
            base_options=BaseOptions(model_asset_path=o.landmarker), running_mode=mpv.RunningMode.IMAGE, num_faces=1,
            output_face_blendshapes=True, output_facial_transformation_matrixes=True, min_face_detection_confidence=0.3))
    except Exception as ex:  # no landmarker: faces are still found and tracked
        print(f"landmarker unavailable: {ex}", file=sys.stderr)

    cmd = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", o.video, "-an",
           "-vf", f"fps={FPS},scale={W}:{H}", "-f", "rawvideo", "-pix_fmt", "bgr24", "pipe:1"]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
    size = W * H * 3
    total = max(1, int(o.seconds * FPS))
    frames, metrics = [], []
    tracks, next_id = [], 1  # live tracks: {id, box, last}
    prev_small, prev_gray, shifts = None, None, []
    i = 0
    while True:
        buf = proc.stdout.read(size)
        if len(buf) < size:
            break
        img = np.frombuffer(buf, np.uint8).reshape(H, W, 3)
        t = i / FPS
        _, found = det.detect(img)
        faces = []
        for f in (found if found is not None else [])[:3]:
            x, y, w, h = [float(v) for v in f[:4]]
            box = (max(0.0, x), max(0.0, y), min(w, W - max(0.0, x)), min(h, H - max(0.0, y)))
            # Track: the live track it overlaps most, else a new one.
            best, bi = 0.0, None
            for k, tr in enumerate(tracks):
                v = iou(box, tr["box"])
                if v > best:
                    best, bi = v, k
            if bi is not None and best > 0.3:
                tid = tracks[bi]["id"]; tracks[bi].update(box=box, last=t)
            else:
                tid = next_id; next_id += 1; tracks.append({"id": tid, "box": box, "last": t})
            jaw = yaw = pitch = blink = None
            if lm is not None:
                cx, cy, side = x + w / 2, y + h / 2, max(w, h) * 2.2
                x0, y0 = int(max(0, cx - side / 2)), int(max(0, cy - side / 2))
                x1, y1 = int(min(W, cx + side / 2)), int(min(H, cy + side / 2))
                if x1 - x0 > 8 and y1 - y0 > 8:
                    crop = cv2.cvtColor(cv2.resize(img[y0:y1, x0:x1], (256, 256)), cv2.COLOR_BGR2RGB)
                    r = lm.detect(mp.Image(image_format=mp.ImageFormat.SRGB, data=np.ascontiguousarray(crop)))
                    if r.face_landmarks:
                        bs = {c.category_name: c.score for c in r.face_blendshapes[0]}
                        jaw = round(float(bs.get("jawOpen", 0.0)), 3)
                        blink = round(float((bs.get("eyeBlinkLeft", 0.0) + bs.get("eyeBlinkRight", 0.0)) / 2), 3)
                        yw, pt, _ = head_pose(r.facial_transformation_matrixes[0])
                        yaw, pitch = round(yw, 1), round(pt, 1)
            faces.append([tid, round(box[0] / W, 4), round(box[1] / H, 4), round(box[2] / W, 4), round(box[3] / H, 4), round(float(f[14]), 3), jaw, yaw, pitch, blink])
        tracks = [tr for tr in tracks if t - tr["last"] <= 1.0]
        frames.append([round(t, 2), faces])

        # Camera shake: the frame-to-frame shift of the whole picture (phase correlation), every frame.
        gray = cv2.cvtColor(cv2.resize(img, (160, int(160 * H / W))), cv2.COLOR_BGR2GRAY).astype(np.float32)
        if prev_gray is not None:
            (dx, dy), _ = cv2.phaseCorrelate(prev_gray, gray)
            shifts.append((dx / 160, dy / 160))
        else:
            shifts.append((0.0, 0.0))
        prev_gray = gray

        if i % EVERY == 0:
            g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
            sharp = float(cv2.Laplacian(g, cv2.CV_64F).var())
            small = cv2.resize(g, (160, int(160 * H / W))).astype(np.float32)
            motion = float(np.mean(np.abs(small - prev_small)) / 255) if prev_small is not None else 0.0
            prev_small = small
            sh = np.array(shifts[-EVERY:])
            # Shake is the jitter of the shift (a steady pan is not shake): its spread around its own mean.
            shake = float(np.sqrt(np.mean(np.sum((sh - sh.mean(axis=0)) ** 2, axis=1)))) if len(sh) > 1 else 0.0
            skin = None
            if faces:
                fb = max(faces, key=lambda q: q[3] * q[4])
                fx0, fy0 = int(fb[1] * W), int(fb[2] * H)
                fx1, fy1 = fx0 + max(1, int(fb[3] * W)), fy0 + max(1, int(fb[4] * H))
                skin = round(float(np.mean(g[fy0:fy1, fx0:fx1]) / 255), 3) if fy1 > fy0 and fx1 > fx0 else None
            metrics.append([round(t, 2), round(float(np.mean(g) / 255), 3), round(sharp, 1), round(motion, 4), round(shake, 4), skin, colours(img), round(float(np.std(g) / 255), 3)])
        i += 1
        if i % 100 == 0:
            progress(min(99, 100 * i / total))
    proc.wait()
    if lm is not None:
        lm.close()
    if not frames:
        raise SystemExit("no frames could be read from the video")

    # ---- the summary ----
    ft = [f[0] for f in frames]
    dur = round(len(frames) / FPS, 2)
    has = [len(f[1]) > 0 for f in frames]
    main_face = [max(f[1], key=lambda q: q[3] * q[4]) if f[1] else None for f in frames]
    present = float(np.mean(has))
    lost = ranges([not h for h in has], ft, 0.5, end=dur) if present > 0.2 else []
    turned = [mf is not None and mf[7] is not None and abs(mf[7]) > 30 for mf in main_face]
    off_camera = ranges(turned, ft, 0.5, end=dur)
    for r in off_camera:
        ys = [abs(mf[7]) for mf, t in zip(main_face, ft) if mf is not None and mf[7] is not None and r[0] <= t < r[1]]
        r.append(round(max(ys), 1) if ys else None)
    # Head turns: the main face's yaw moves 25 degrees or more within a second.
    turns, last_turn = [], -9.0
    yaws = [(t, mf[7]) for t, mf in zip(ft, main_face) if mf is not None and mf[7] is not None]
    for k in range(len(yaws)):
        t, y = yaws[k]
        j = k
        while j > 0 and t - yaws[j - 1][0] <= 1.0:
            j -= 1
        if j < k and abs(y - yaws[j][1]) >= 25 and t - last_turn > 1.0:
            turns.append([round(yaws[j][0], 2), round(t, 2), round(yaws[j][1], 1), round(y, 1)])
            last_turn = t
    jaws = [mf[6] for mf in main_face if mf is not None and mf[6] is not None]
    mt = [m[0] for m in metrics]
    sharp = np.array([m[2] for m in metrics])
    med_sharp = float(np.median(sharp)) if len(sharp) else 0.0
    # Soft: far less detail than usual in a picture that has something in it (a plain wall or a dark frame is not
    # out of focus).
    contrast = np.array([m[7] for m in metrics])
    med_con = float(np.median(contrast)) if len(contrast) else 0.0
    bright0 = np.array([m[1] for m in metrics])
    soft = ranges([s < 0.35 * med_sharp and c > 0.5 * med_con and b > 0.18 for s, c, b in zip(sharp, contrast, bright0)], mt, 1.0, gap=0.6, step=EVERY / FPS, end=dur) if med_sharp > 0 else []
    shake = np.array([m[4] for m in metrics])
    # A shake value covers the half second before its sample.
    shaky = ranges([s > 0.01 for s in shake], [max(0.0, t - EVERY / FPS) for t in mt], 1.0, gap=0.6, step=EVERY / FPS, end=dur)
    bright = np.array([m[1] for m in metrics])
    dark = ranges([b < 0.18 for b in bright], mt, 1.0, gap=0.6, step=EVERY / FPS, end=dur)
    blown = ranges([b > 0.85 for b in bright], mt, 1.0, gap=0.6, step=EVERY / FPS, end=dur)
    skins = [m[5] for m in metrics if m[5] is not None]
    # Where the main face sits (10th-90th percentile of its box over the video), and what is free for text.
    boxes = np.array([[mf[1], mf[2], mf[1] + mf[3], mf[2] + mf[4]] for mf in main_face if mf is not None])
    safe = None
    if len(boxes):
        fx0, fy0 = np.percentile(boxes[:, 0], 10), np.percentile(boxes[:, 1], 10)
        fx1, fy1 = np.percentile(boxes[:, 2], 90), np.percentile(boxes[:, 3], 90)
        face = [round(float(v), 3) for v in (fx0, fy0, fx1, fy1)]
        safe = {"face": face, "free": {"top": [0, 0, 1, face[1]], "bottom": [0, round(min(1.0, face[3] + 0.08), 3), 1, 1],
                                       "left": [0, 0, face[0], 1], "right": [face[2], 0, 1, 1]}}
    summary = {
        "v": 1, "fps": FPS, "metricsEvery": EVERY / FPS, "size": [W, H], "frames": len(frames), "landmarks": lm is not None,
        "faces": {"present": round(present, 3), "tracks": len({q[0] for f in frames for q in f[1]}), "lost": lost, "offCamera": off_camera,
                  "turns": turns[:200], "mouthOpenShare": round(float(np.mean([j > 0.25 for j in jaws])), 3) if jaws else None,
                  "medianShare": round(float(np.median([mf[4] for mf in main_face if mf is not None])), 3) if any(main_face) else None},
        "sharpness": {"median": round(med_sharp, 1), "soft": soft},
        "shake": {"median": round(float(np.median(shake)), 4) if len(shake) else 0, "shaky": shaky},
        "light": {"median": round(float(np.median(bright)), 3) if len(bright) else None, "dark": dark, "blown": blown,
                  "skinMedian": round(float(np.median(skins)), 3) if skins else None},
        "motion": {"median": round(float(np.median([m[3] for m in metrics])), 4) if metrics else 0},
        "safeArea": safe,
    }
    with open(o.out, "w") as fh:
        json.dump({"v": 1, "fps": FPS, "size": [W, H],
                   "faceFields": "track,x,y,w,h,score,jawOpen,yaw,pitch,blink", "frames": frames,
                   "metricFields": "t,brightness,sharpness,motion,shake,skin,colours,contrast", "metrics": metrics}, fh, separators=(",", ":"))
    progress(100)
    print(json.dumps(summary))


if __name__ == "__main__":
    main()
