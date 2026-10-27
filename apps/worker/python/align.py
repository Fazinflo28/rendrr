"""Where each word really starts and ends in the sound: CTC forced alignment of the transcript with wav2vec2 (ONNX), then
each edge moved onto the sound itself (the 10 ms loudness in audio.bin). Without the model only the edges are moved.
Measurements only: the transcriber's own times stay as they are, next to these.

Usage: align.py --pcm16 <f32le mono 16 kHz> --words <json [[id, text, start, end], ...]> --frames <audio.bin>
                --floor <room dBFS> [--model <wav2vec2.onnx> --vocab <vocab.json>]
Prints JSON on the last line: {"model", "words": [[id, start_audio, end_audio, confidence|null], ...], "unaligned": [...]}.
"""
import argparse, json, re, sys, time
import numpy as np

STRIDE = 0.02  # wav2vec2: one frame of logits per 320 samples at 16 kHz


def progress(p):
    print(f"PROGRESS {int(p)}", file=sys.stderr, flush=True)


def log_softmax(x):
    m = x.max(axis=1, keepdims=True)
    return x - m - np.log(np.exp(x - m).sum(axis=1, keepdims=True))


def viterbi(emission, tokens, blank=0):
    """CTC forced alignment (the trellis of torchaudio's tutorial, MIT): for each token, the frames it is spoken on.
    emission: (T, C) log probabilities; tokens: N ids. Returns [(token index, frame, log prob)] in time order, or None
    when the tokens cannot fit in the frames."""
    T, N = emission.shape[0], len(tokens)
    if N == 0 or T < N:
        return None
    tok = np.asarray(tokens)
    trellis = np.full((T + 1, N + 1), -np.inf, np.float64)
    trellis[0, 0] = 0.0
    trellis[1:, 0] = np.cumsum(emission[:, blank])
    for t in range(T):
        stay = trellis[t, 1:] + emission[t, blank]
        move = trellis[t, :-1] + emission[t, tok]
        trellis[t + 1, 1:] = np.maximum(stay, move)
    if not np.isfinite(trellis[T, N]):
        return None
    path, j = [], N
    for t in range(T, 0, -1):
        if j == 0:
            break
        stayed = trellis[t - 1, j] + emission[t - 1, blank]
        changed = trellis[t - 1, j - 1] + emission[t - 1, tok[j - 1]]
        if changed > stayed:
            path.append((j - 1, t - 1, float(emission[t - 1, tok[j - 1]]), True))
            j -= 1
        else:
            # A frame after token j - 1 started: the token still held (its own score beats the blank's) or a blank.
            held = emission[t - 1, tok[j - 1]] >= emission[t - 1, blank]
            path.append((j - 1, t - 1, float(emission[t - 1, tok[j - 1]] if held else emission[t - 1, blank]), bool(held)))
    if j > 0:
        return None
    return path[::-1]


def token_spans(path, n):
    """Per token: the first frame it is emitted on, the frame after it stops being held (blanks after it are not part
    of it: they are the pause before the next one), and its mean probability."""
    spans = [None] * n
    by = {}
    for i, f, lp, said in path:
        by.setdefault(i, []).append((f, lp, said))
    for i, fs in by.items():
        fs.sort()
        start, end, lps = fs[0][0], fs[0][0] + 1, [fs[0][1]]
        for f, lp, said in fs[1:]:
            if not said or f != end:
                break
            end = f + 1
            lps.append(lp)
        spans[i] = (start, end, float(np.mean(np.exp(lps))))
    return spans


def chars_of(text, vocab):
    s = re.sub(r"[^A-Z']", "", text.upper().replace("’", "'"))
    return [vocab[c] for c in s if c in vocab]


def align_window(sess, inp, out, audio, t0, words, vocab):
    """Aligns the words said in one stretch of audio starting at t0. Returns {word index: (start, end, conf)}."""
    x = audio.astype(np.float32)
    x = (x - x.mean()) / (x.std() + 1e-7)  # wav2vec2's feature extractor normalises each input
    logits = sess.run([out], {inp: x[None, :]})[0][0]
    em = log_softmax(logits.astype(np.float64))
    toks, owner = [], []
    sep = vocab.get("|")
    for k, (_, text, _, _) in enumerate(words):
        cs = chars_of(text, vocab)
        if not cs:
            continue
        if toks and sep is not None:
            toks.append(sep); owner.append(-1)
        toks += cs; owner += [k] * len(cs)
    path = viterbi(em, toks, blank=vocab.get("<pad>", 0))
    if path is None:
        return {}
    spans = token_spans(path, len(toks))
    res = {}
    for k in set(o for o in owner if o >= 0):
        idx = [i for i, o in enumerate(owner) if o == k and spans[i] is not None]
        if not idx:
            continue
        a = min(spans[i][0] for i in idx)
        b = max(spans[i][1] for i in idx)
        conf = float(np.mean([spans[i][2] for i in idx]))
        res[k] = (t0 + a * STRIDE, t0 + b * STRIDE, conf)
    return res


def snap(words, times, db, room):
    """Moves each word's edges onto the sound: its start to the nearest rise out of the room (within 100 ms before or
    50 ms after), its end to the nearest fall back into it (within 120 ms either side). Where two words touch (less
    than 150 ms apart), the boundary goes into the quietest stretch between them, when there is a real dip. An edge still
    in the quiet moves onto the first or last sound inside the word."""
    n = len(db)
    rise, fall = room + 10.0, room + 6.0
    fr = lambda t: int(round(t / 0.01))
    out = []
    for k, w in enumerate(words):
        s, e = times[k]
        f0, best = fr(s), None
        for f in range(max(1, f0 - 10), min(n, f0 + 5)):
            if db[f - 1] <= rise < db[f]:
                g = f
                while g > max(1, f0 - 12) and db[g - 1] > fall:
                    g -= 1  # back to where the sound leaves the room
                if best is None or abs(g - f0) < abs(best - f0):
                    best = g
        s2 = best * 0.01 if best is not None else s
        f1, best = fr(e), None
        for f in range(max(0, f1 - 12), min(n - 1, f1 + 12)):
            if db[f] > fall >= db[f + 1] and (best is None or abs(f + 1 - f1) < abs(best - f1)):
                best = f + 1
        e2 = best * 0.01 if best is not None else e
        # An edge left in the quiet (the model can start a word in the pause before it, or end it in the pause after):
        # onto the first and last sound inside the word, a frame over the room that leads to the voice within 150 ms.
        fs, fe = min(n - 1, max(0, fr(s2))), min(n, max(1, fr(e2)))
        if fe > fs and db[fs] <= fall:
            g = next((g for g in range(fs, fe) if db[g] > fall and db[g:min(fe, g + 15)].max() >= rise), None)
            if g is not None:
                s2 = g * 0.01
        fs = min(n - 1, max(0, fr(s2)))
        if fe > fs and db[fe - 1] <= fall:
            h = next((h for h in range(fe - 1, fs, -1) if db[h] > fall and db[max(fs, h - 14):h + 1].max() >= rise), None)
            if h is not None:
                e2 = (h + 1) * 0.01
        out.append([w[0], s2, max(e2, s2 + 0.02)])
    for k in range(1, len(out)):
        a, b = out[k - 1], out[k]
        if b[1] - a[2] >= 0.15:
            continue
        lo, hi = max(fr(a[1]) + 2, fr(min(a[2], b[1]) - 0.05)), min(fr(b[2]) - 2, fr(max(a[2], b[1]) + 0.08))
        if hi - lo >= 2:
            seg = db[lo:hi]
            m0 = int(np.argmin(seg))
            m1 = m0
            while m1 + 1 < len(seg) and seg[m1 + 1] <= seg[m0] + 1:
                m1 += 1
            around = np.concatenate([db[max(0, lo + m0 - 5):lo + m0], db[lo + m1 + 1:lo + m1 + 6]])
            if len(around) and float(np.mean(around)) - float(seg[m0]) >= 6:  # a real dip between the words
                a[2] = max(a[1] + 0.02, (lo + m0) * 0.01)
                b[1] = min(max(a[2], (lo + m1 + 1) * 0.01), b[2] - 0.02)
                continue
        if b[1] < a[2]:
            mid = (a[2] + b[1]) / 2
            a[2], b[1] = max(a[1] + 0.02, mid), max(a[1] + 0.02, mid)
    return [[w, round(s, 3), round(e, 3)] for w, s, e in out]


def main():
    a = argparse.ArgumentParser()
    a.add_argument("--pcm16", required=True)
    a.add_argument("--words", required=True)
    a.add_argument("--frames", required=True)
    a.add_argument("--floor", type=float, required=True)
    a.add_argument("--model")
    a.add_argument("--vocab")
    o = a.parse_args()
    t_start = time.time()
    words = json.load(open(o.words))
    audio = np.fromfile(o.pcm16, dtype="<f4")
    rec = np.fromfile(o.frames, dtype=np.int8).reshape(-1, 4)
    db = rec[:, 2].astype(np.float32)
    times = [(w[2], w[3]) for w in words]
    conf = [None] * len(words)
    model_name, error = None, None

    if o.model and o.vocab:
        try:
            import onnxruntime as ort
            vocab = json.load(open(o.vocab))
            so = ort.SessionOptions()
            so.intra_op_num_threads = max(1, min(4, __import__("os").cpu_count() or 1))
            sess = ort.InferenceSession(o.model, sess_options=so, providers=["CPUExecutionProvider"])
            inp, out = sess.get_inputs()[0].name, sess.get_outputs()[0].name
            model_name = o.model.split("/")[-2] if "/" in o.model else o.model
            # Windows of words said close together (gaps under 1 s, at most 20 s), with 0.4 s of sound each side.
            windows, cur = [], []
            for k, w in enumerate(words):
                if cur and (w[2] - words[cur[-1]][3] > 1.0 or w[3] - words[cur[0]][2] > 20):
                    windows.append(cur); cur = []
                cur.append(k)
            if cur:
                windows.append(cur)
            for wi, ks in enumerate(windows):
                t0 = max(0.0, words[ks[0]][2] - 0.4)
                t1 = min(len(audio) / 16000, words[ks[-1]][3] + 0.4)
                seg = audio[int(t0 * 16000):int(t1 * 16000)]
                if len(seg) < 1600:
                    continue
                got = align_window(sess, inp, out, seg, t0, [words[k] for k in ks], vocab)
                for local, (s, e, c) in got.items():
                    k = ks[local]
                    times[k] = (s, e)
                    conf[k] = round(c, 3)
                if wi % 20 == 0:
                    progress(5 + 85 * wi / max(1, len(windows)))
        except Exception as ex:  # the model failed: the edges are still moved onto the sound
            error = f"{type(ex).__name__}: {str(ex)[:200]}"
            times = [(w[2], w[3]) for w in words]
            conf = [None] * len(words)
            model_name = None

    snapped = snap(words, times, db, o.floor)
    progress(100)
    print(json.dumps({
        "v": 1, "model": model_name, "error": error, "seconds": round(time.time() - t_start, 1),
        "words": [[w[0], round(w[1], 3), round(w[2], 3), conf[k]] for k, w in enumerate(snapped)],
        "unaligned": [words[k][0] for k in range(len(words)) if model_name and conf[k] is None],
    }))


if __name__ == "__main__":
    main()
