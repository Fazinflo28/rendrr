"""The sound of a video measured every 10 ms: peaks, loudness, whether someone speaks (Silero VAD), and from those the
speech regions, onsets, breaths, clicks and clipping. Measurements only: nothing is decided here.

Usage: deep_audio.py --pcm48 <s16le mono 48 kHz> --pcm16 <f32le mono 16 kHz> --vad <silero_vad.onnx> --out <dir>
       [--joins <json list of seconds> --min-speech <s> --edges]
The options are for a rendered preview (Engine Part 3): clicks within 20 ms of a join are listed (joinClicks), speech
from min-speech seconds (default 0.25) counts, and with --edges each stretch of speech ends where its level falls.
Writes <dir>/audio.bin (4 bytes per 10 ms frame: min peak, max peak as int8 of full scale, loudness in dBFS as int8,
speech probability as uint8 0-255) and prints the summary as JSON on the last line of stdout. Progress goes to stderr
as "PROGRESS <0-100>".
"""
import argparse, base64, json, sys
import numpy as np

FRAME = 0.01  # seconds


def progress(p):
    print(f"PROGRESS {int(p)}", file=sys.stderr, flush=True)


def frames_of(x, n):
    """x cut into frames of n samples (the last partial frame padded with zeros)."""
    pad = (-len(x)) % n
    if pad:
        x = np.concatenate([x, np.zeros(pad, x.dtype)])
    return x.reshape(-1, n)


def vad_probs(pcm16, model):
    """Silero VAD (v5, ONNX) over 16 kHz audio: one probability per 512 samples (32 ms), with its 64-sample context."""
    import onnxruntime as ort
    so = ort.SessionOptions()
    so.intra_op_num_threads = 1
    so.inter_op_num_threads = 1
    sess = ort.InferenceSession(model, sess_options=so, providers=["CPUExecutionProvider"])
    state = np.zeros((2, 1, 128), np.float32)
    ctx = np.zeros(64, np.float32)
    sr = np.array(16000, np.int64)
    n = len(pcm16) // 512
    out = np.zeros(n, np.float32)
    for i in range(n):
        chunk = pcm16[i * 512:(i + 1) * 512]
        x = np.concatenate([ctx, chunk])[None, :]
        prob, state = sess.run(None, {"input": x, "state": state, "sr": sr})
        out[i] = float(prob.reshape(-1)[0])
        ctx = chunk[-64:]
        if i % 2000 == 0:
            progress(30 + 50 * i / max(1, n))
    return out


def regions(mask, min_on, min_off):
    """Runs of True in a frame mask, gaps shorter than min_off joined and runs shorter than min_on dropped (frames)."""
    runs, start = [], None
    for i, m in enumerate(np.append(mask, False)):
        if m and start is None:
            start = i
        elif not m and start is not None:
            runs.append([start, i])
            start = None
    joined = []
    for r in runs:
        if joined and r[0] - joined[-1][1] < min_off:
            joined[-1][1] = r[1]
        else:
            joined.append(r)
    return [r for r in joined if r[1] - r[0] >= min_on]


def flatness(seg):
    """Spectral flatness (0-1) of a stretch of 16 kHz audio: noise (a breath) is flat, a voice is peaky."""
    if len(seg) < 256:
        return 0.0
    f = frames_of(seg, 512) * np.hanning(512)
    p = np.abs(np.fft.rfft(f, axis=1)) ** 2 + 1e-12
    p = p[:, 4:200]  # 125 Hz - 6 kHz
    return float(np.mean(np.exp(np.mean(np.log(p), axis=1)) / np.mean(p, axis=1)))


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--pcm48", required=True)
    a.add_argument("--pcm16", required=True)
    a.add_argument("--vad", required=True)
    a.add_argument("--out", required=True)
    a.add_argument("--joins")
    a.add_argument("--min-speech", type=float, default=0.25)
    a.add_argument("--edges", action="store_true")
    o = a.parse_args()
    joins = np.array(sorted(json.load(open(o.joins))), np.float64) if o.joins else None

    x48 = np.fromfile(o.pcm48, dtype="<i2")
    pcm16 = np.fromfile(o.pcm16, dtype="<f4")
    if len(x48) < 480:
        print(json.dumps({"v": 1, "frames": 0, "seconds": 0}))
        return
    seconds = len(x48) / 48000
    progress(2)

    # 1. Peaks and loudness every 10 ms (480 samples at 48 kHz).
    fr = frames_of(x48, 480).astype(np.float32) / 32768.0
    nfr = len(fr)
    mn, mx = fr.min(axis=1), fr.max(axis=1)
    rms = np.sqrt(np.mean(fr * fr, axis=1))
    db = np.clip(20 * np.log10(rms + 1e-9), -100, 0)
    progress(15)

    # 2. Clipping: 10 ms frames near full scale (peak -1 dBFS or more) whose tops are flat (a quarter of the samples
    #    within 3% of the frame's peak; a clean tone has 16%, speech under 6%). It holds after lossy coding, which
    #    softens the flat tops a lossless file would show as samples stuck at full scale.
    afr = np.abs(fr)
    pk = afr.max(axis=1)
    flat = (afr >= 0.97 * pk[:, None]).mean(axis=1)
    hot_frames = np.flatnonzero((pk >= 0.89) & (flat >= 0.25))
    del afr
    clip_events = []
    for f in hot_frames:
        t = f * FRAME
        if clip_events and t - clip_events[-1][1] <= 0.05:
            clip_events[-1][1] = round(t + FRAME, 2)
            clip_events[-1][2] = max(clip_events[-1][2], round(float(20 * np.log10(pk[f] + 1e-9)), 2))
        else:
            clip_events.append([round(t, 2), round(t + FRAME, 2), round(float(20 * np.log10(pk[f] + 1e-9)), 2)])
    del fr  # an hour of audio is large: keep only what is still needed

    # 3. Clicks: a 1 ms burst far above the high frequencies around it (a lip smack, a bump, a digital pop).
    hp = np.abs(np.diff(x48.astype(np.float32))) / 32768.0
    blocks = frames_of(hp, 48).max(axis=1)  # peak per 1 ms
    clicks = []
    w = 25
    for c0 in range(0, len(blocks), 200000):
        seg = blocks[max(0, c0 - w):c0 + 200000 + w]
        if len(seg) < 2 * w + 1:
            continue
        med = np.median(np.lib.stride_tricks.sliding_window_view(seg, 2 * w + 1), axis=1)
        core = seg[w:len(seg) - w]
        off = max(0, c0 - w) + w
        cand = np.flatnonzero((core > 6 * med + 1e-4) & (core > 0.02))
        for i in cand:
            j = i + off
            lo, hi = blocks[max(0, j - 4):j], blocks[j + 1:j + 5]
            if (len(lo) and lo.max() > 0.5 * blocks[j]) or (len(hi) and hi.max() > 0.5 * blocks[j]):
                continue  # not short: a consonant or music, not a click
            ratio = blocks[j] / (med[i] + 1e-4)
            clicks.append([round(j / 1000, 3), round(float(20 * np.log10(ratio)), 1)])
    del hp
    progress(28)

    # 4. Speech: Silero VAD every 32 ms, held on the 10 ms grid.
    vp = vad_probs(pcm16, o.vad) if len(pcm16) >= 512 else np.zeros(0, np.float32)
    t10 = (np.arange(nfr) + 0.5) * FRAME
    vad = vp[np.minimum((t10 * 16000 / 512).astype(int), max(0, len(vp) - 1))] if len(vp) else np.zeros(nfr, np.float32)
    # Hysteresis: speech starts above 0.5, ends below 0.35.
    on = np.zeros(nfr, bool)
    s = False
    for i, p in enumerate(vad):
        s = p > 0.5 if not s else p > 0.35
        on[i] = s
    speech = regions(on, max(1, int(round(o.min_speech / FRAME))), 15)  # at least 0.25 s, gaps under 0.15 s joined
    # From here "speech" is those regions: a blip the VAD took for a voice (a breath often is one) is not speech.
    on = np.zeros(nfr, bool)
    for r0, r1 in speech:
        on[r0:r1] = True
    progress(82)

    # Clicks 20 dB over the high frequencies around them; inside speech (plosives, sibilants) 30 dB.
    clicks = [c for c in clicks if c[1] >= (30 if on[min(nfr - 1, int(c[0] / FRAME))] else 20)]
    clicks.sort(key=lambda c: -c[1])
    clicks = sorted(clicks[:500])

    # At the joins of a rendered edit (--joins): the clicks above within 20 ms of a join at the in-speech bar, 30 dB (a
    # lip smack or bump kept at a clip's edge; a word starting right at the cut is speech, even where the detector has
    # not caught up yet: its consonant is sharp too), and the cut itself: the biggest sample-to-sample jump within 1 ms
    # of the join, 20 dB or more over the usual jump on the LOUDER side of it (2-25 ms before, 2-25 ms after), is a cut
    # that jumps the waveform. Against both sides together a word starting after a pause passed too (half the window
    # is the quiet pause: found live, 9 joins at 20-26 dB, all words after a pause).
    join_clicks = {}
    if joins is not None:
        for c in clicks:
            k = int(np.argmin(np.abs(joins - c[0]))) if len(joins) else -1
            if k >= 0 and c[1] >= 30 and abs(joins[k] - c[0]) <= 0.02 and (k not in join_clicks or c[1] > join_clicks[k][1]):
                join_clicks[k] = [c[0], c[1], "click"]
        for k, jt in enumerate(joins):
            i = int(round(jt * 48000))
            if i < 1250 or i > len(x48) - 1250:
                continue
            d = np.abs(np.diff(x48[i - 1200:i + 1200].astype(np.float32))) / 32768.0
            near = d[1200 - 48:1200 + 48].max()
            around = max(np.median(d[:1200 - 96]), np.median(d[1200 + 96:]))
            ratio = float(20 * np.log10((near + 1e-6) / (around + 1e-4)))
            if near > 0.02 and ratio >= 20 and (k not in join_clicks or ratio > join_clicks[k][1]):
                join_clicks[k] = [round(jt, 3), round(ratio, 1), "cut"]

    speech_db = db[on] if on.any() else db
    level = float(np.median(speech_db)) if len(speech_db) else -100.0
    quiet = db[~on] if (~on).any() else db
    floor = float(np.percentile(quiet, 10)) if len(quiet) else -100.0
    room = float(np.median(quiet)) if len(quiet) else -100.0  # the usual level when nobody speaks

    if o.edges and speech:
        # The detector's windows (32 ms) and its slow fall leave each stretch ending up to ~150 ms late: the end moves
        # back while the level is under the voice (30 dB under its median, at least 6 dB over the room), the start to
        # where the level is up (at most 50 ms either way).
        thr = max(room + 6, level - 30)
        moved = []
        for r0, r1 in speech:
            e, n = r1, 0
            while e > r0 + 1 and db[e - 1] < thr and n < 15:
                e -= 1; n += 1
            st, n = r0, 0
            while st > 0 and db[st - 1] >= thr and n < 5:
                st -= 1; n += 1
            n = 0
            while st < e - 1 and db[st] < thr and n < 5:
                st += 1; n += 1
            moved.append([st, e])
        speech = moved
        on = np.zeros(nfr, bool)
        for r0, r1 in speech:
            on[r0:r1] = True

    # 5. Onsets: the sound jumps 10 dB within 30 ms from well under the speech level (a word, a plosive, a bang).
    onsets = []
    for i in range(3, nfr):
        if db[i] - db[i - 3] >= 10 and db[i - 3] < level - 10 and db[i] > room + 12:
            if not onsets or i * FRAME - onsets[-1] > 0.08:
                onsets.append(round(i * FRAME, 2))

    # 6. Breaths: a short stretch with no speech, louder than the room but well under the voice, and noise-like.
    breaths = []
    for g0, g1 in regions(~on, 8, 3):
        if (g1 - g0) * FRAME > 0.9:
            # Inside a long pause: look for a breath just before the next speech starts.
            g0 = max(g0, g1 - 90)
        seg_db = db[g0:g1]
        loud = seg_db > room + 8
        if loud.sum() < 10:
            continue
        hot_runs = regions(loud, 10, 4)
        for h0, h1 in hot_runs:
            a0, a1 = g0 + h0, g0 + h1
            dur = (a1 - a0) * FRAME
            if not 0.12 <= dur <= 0.9:
                continue
            m = float(np.mean(db[a0:a1]))
            if m > level - 6:
                continue
            fl = flatness(pcm16[int(a0 * FRAME * 16000):int(a1 * FRAME * 16000)])
            if fl < 0.12:
                continue
            breaths.append([round(a0 * FRAME, 2), round(a1 * FRAME, 2), round(m, 1), round(min(1.0, fl * 2.5), 2)])
    progress(92)

    # The 10 ms frames: min, max, loudness, speech probability.
    q = lambda v: np.clip(np.round(v * 127), -127, 127).astype(np.int8)
    rec = np.zeros((nfr, 4), np.int8)
    rec[:, 0] = q(mn)
    rec[:, 1] = q(mx)
    rec[:, 2] = np.round(db).astype(np.int8)
    rec[:, 3] = np.clip(np.round(vad * 255), 0, 255).astype(np.uint8).view(np.int8)
    rec.tofile(f"{o.out}/audio.bin")

    # Loudness every 100 ms (int8 dBFS, base64) for the marks and checks that read it from the summary.
    n100 = nfr // 10
    rms100 = np.round(np.clip(20 * np.log10(np.sqrt(np.mean(rms[:n100 * 10].reshape(-1, 10) ** 2, axis=1)) + 1e-9), -100, 0)).astype(np.int8) if n100 else np.zeros(0, np.int8)
    peak = float(np.max(np.abs(x48))) / 32768.0
    out = {
        "v": 1, "frameMs": 10, "frames": int(nfr), "seconds": round(seconds, 3), "layout": "min,max,rmsDb,vad",
        "peakDb": round(20 * np.log10(peak + 1e-9), 2), "noiseFloorDb": round(floor, 1), "roomDb": round(room, 1), "speechDb": round(level, 1),
        "speech": [[round(r0 * FRAME, 2), round(r1 * FRAME, 2)] for r0, r1 in speech],
        "speechShare": round(float(on.mean()), 3),
        "onsets": onsets, "breaths": breaths, "clicks": clicks, "clipping": clip_events,
        "rms100": base64.b64encode(rms100.tobytes()).decode(),
    }
    if joins is not None:
        out["joinClicks"] = [join_clicks[k] for k in sorted(join_clicks)]
    progress(100)
    print(json.dumps(out))


if __name__ == "__main__":
    main()
