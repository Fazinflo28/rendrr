#!/usr/bin/env python3
"""
Studio voice: the dialogue made clean and dry, like a voice recorded close on a good microphone, in blocks of
footage (block seconds from the video's start, each kept once made). Two steps, both on the CPU:

1. Echo out (dereverb): WPE, weighted prediction error (Nakatani et al. 2010; Yoshioka and Nakatani 2012), the
   classic dereverberation: per frequency, the late echo is predicted from the sound some frames before and taken
   away, iteratively weighted by the voice's own power. Written here after nara_wpe (MIT, github.com/fgnt/nara_wpe).
2. Noise and room out (denoise): DeepFilterNet3 (Schroeter et al. 2023; MIT or Apache-2.0,
   github.com/Rikorose/DeepFilterNet), its official ONNX export run with onnxruntime: an ERB-band gain over the whole
   spectrum and a deep filter (5 frames, complex) under 4.8 kHz, trained on speech with noise and room echo. Its
   features (vorbis-window STFT, ERB energies and unit-normalized spectrum with exponential means) are written here as
   libDF computes them, with the model's offline alignment (features 2 frames ahead, deep filter 2 frames ahead).

The tone (EQ, compression, leveling, loudness) is the render's own FFmpeg chain, so it changes without making the
voice again.

Usage:
  voice.py --input <file or link> --blocks 0,1,5 --block 30 --seconds <video length> --denoise 100 --dereverb 60
           --models <dir with enc.onnx, erb_dec.onnx, df_dec.onnx> --out <dir>
Writes <out>/voice-<k>.flac per block: 48 kHz mono, exactly the block (the last one to the video's end) plus
OVERLAP seconds past its end (the join crossfades there). Prints PROGRESS <0-100> lines and a JSON summary last.
  voice.py --join --dir <dir> --blocks 0,1,5 --block 30 --seconds <length> --out <file.flac>
Joins the blocks into one file from the video's start (silence where no block was made), crossfading at each join.
"""
import argparse
import json
import os
import subprocess
import sys
import time

import numpy as np

SR = 48000
# DeepFilterNet3's [df] and [deepfilternet] settings (its config.ini).
FFT, HOP, NB_ERB, NB_DF, DF_ORDER, DF_LOOKAHEAD, CONV_LOOKAHEAD, MIN_ERB_FREQS = 960, 480, 32, 96, 5, 2, 2, 2
# The exponential means' factor: exp(-hop / (sr * tau)) with tau 1 s, rounded to 3 places as libDF does (0.99).
NORM_ALPHA = 0.99
MEAN_NORM_INIT, UNIT_NORM_INIT = (-60.0, -90.0), (0.001, 0.0001)
# Context read either side of a block, so the models and the echo statistics are settled at its edges.
PRE, POST = 3.0, 1.0
# Each block carries this much past its end; the join crossfades the next block in over it.
OVERLAP = 0.02


def vorbis_window(n):
    i = np.arange(n, dtype=np.float64)
    s = np.sin(0.5 * np.pi * (i + 0.5) / (n // 2))
    return np.sin(0.5 * np.pi * s * s).astype(np.float32)


def erb_widths(sr=SR, fft=FFT, nb=NB_ERB, min_nb=MIN_ERB_FREQS):
    """Bins per ERB band, as libDF's erb_fb: equal steps on the ERB scale, at least min_nb bins each."""
    f2e = lambda f: 9.265 * np.log1p(f / (24.7 * 9.265))
    e2f = lambda e: 24.7 * 9.265 * (np.exp(e / 9.265) - 1)
    width, lo = sr / fft, f2e(0.0)
    step = (f2e(sr / 2) - lo) / nb
    out, prev, over = [], 0, 0
    for i in range(1, nb + 1):
        fb = int(np.floor(e2f(lo + i * step) / width + 0.5))
        n = fb - prev - over
        if n < min_nb:
            over, n = min_nb - n, min_nb
        else:
            over = 0
        out.append(n)
        prev = fb
    out[-1] += 1
    extra = sum(out) - (fft // 2 + 1)
    if extra > 0:
        out[-1] -= extra
    return np.array(out, dtype=np.int64)


class DeepFilterNet3:
    def __init__(self, models, threads=0):
        import onnxruntime as ort
        so = ort.SessionOptions()
        if threads:
            so.intra_op_num_threads = threads
            so.inter_op_num_threads = 1
        so.log_severity_level = 3
        mk = lambda n: ort.InferenceSession(os.path.join(models, n), sess_options=so, providers=["CPUExecutionProvider"])
        self.enc, self.erb_dec, self.df_dec = mk("enc.onnx"), mk("erb_dec.onnx"), mk("df_dec.onnx")
        self.win = vorbis_window(FFT)
        self.widths = erb_widths()
        self.starts = np.concatenate([[0], np.cumsum(self.widths)[:-1]])

    def analysis(self, x):
        n = len(x) // HOP
        xp = np.concatenate([np.zeros(FFT - HOP, np.float32), x[: n * HOP].astype(np.float32)])
        idx = np.arange(FFT)[None, :] + HOP * np.arange(n)[:, None]
        # libDF scales in the analysis only: 1 / (fft^2 / (2 hop)).
        return (np.fft.rfft(xp[idx] * self.win, axis=1) * (2 * HOP / FFT**2)).astype(np.complex64)

    def synthesis(self, spec):
        # libDF's inverse FFT is unnormalized (numpy's times fft), windowed, then overlap-added.
        y = (np.fft.irfft(spec, n=FFT, axis=1) * FFT * self.win).astype(np.float32)
        out = y[:, :HOP].copy()
        out[1:] += y[:-1, HOP:]
        return out.reshape(-1)

    def features(self, spec):
        t = spec.shape[0]
        power = spec.real**2 + spec.imag**2
        erb = 10 * np.log10(np.add.reduceat(power, self.starts, axis=1) / self.widths + 1e-10)
        a = NORM_ALPHA
        state = np.linspace(MEAN_NORM_INIT[0], MEAN_NORM_INIT[1], NB_ERB).astype(np.float32)
        feat_erb = np.empty((t, NB_ERB), np.float32)
        for i in range(t):
            state = erb[i] * (1 - a) + state * a
            feat_erb[i] = (erb[i] - state) / 40.0
        low = spec[:, :NB_DF]
        mag = np.abs(low)
        unit = np.linspace(UNIT_NORM_INIT[0], UNIT_NORM_INIT[1], NB_DF).astype(np.float32)
        feat_spec = np.empty((t, NB_DF), np.complex64)
        for i in range(t):
            unit = mag[i] * (1 - a) + unit * a
            feat_spec[i] = low[i] / np.sqrt(unit)
        return feat_erb, feat_spec

    def enhance(self, x, atten_lim_db=None):
        """x: 48 kHz mono float32. Returns the same length. atten_lim_db: the most noise is turned down by (None = all
        the model takes out)."""
        n0 = len(x)
        # Padded by one FFT so the last samples come out; the STFT delays by fft - hop (cut from the start).
        spec = self.analysis(np.concatenate([x, np.zeros(FFT, np.float32)]))
        t = spec.shape[0]
        fe, fs = self.features(spec)
        # The model reads its features CONV_LOOKAHEAD frames ahead (DeepFilterNet3's pad_feat).
        shift = lambda a: np.concatenate([a[CONV_LOOKAHEAD:], np.zeros((CONV_LOOKAHEAD,) + a.shape[1:], a.dtype)])
        fe, fs = shift(fe), shift(fs)
        feat_erb = fe[None, None]
        feat_spec = np.stack([fs.real, fs.imag])[None].astype(np.float32)
        e0, e1, e2, e3, emb, c0, _lsnr = self.enc.run(None, {"feat_erb": feat_erb, "feat_spec": feat_spec})
        m = self.erb_dec.run(None, {"emb": emb, "e3": e3, "e2": e2, "e1": e1, "e0": e0})[0]
        coefs = self.df_dec.run(None, {"emb": emb, "c0": c0})[0]
        # The ERB gains over every bin of their band.
        out = spec * np.repeat(m[0, 0], self.widths, axis=1)
        # The deep filter under NB_DF: each bin from DF_ORDER frames of the noisy spectrum, DF_LOOKAHEAD ahead.
        c = coefs[0].reshape(t, NB_DF, DF_ORDER, 2)
        c = (c[..., 0] + 1j * c[..., 1]).astype(np.complex64)
        pad = np.pad(spec[:, :NB_DF], ((DF_ORDER - 1 - DF_LOOKAHEAD, DF_LOOKAHEAD), (0, 0)))
        low = np.zeros((t, NB_DF), np.complex64)
        for k in range(DF_ORDER):
            low += pad[k : k + t] * c[:, :, k]
        out[:, :NB_DF] = low
        if atten_lim_db is not None and atten_lim_db > 0:
            lim = 10 ** (-abs(atten_lim_db) / 20)
            out = spec * lim + out * (1 - lim)
        y = self.synthesis(out)
        d = FFT - HOP
        return y[d : d + n0]


def stft(x, n, hop, win):
    m = 1 + max(0, (len(x) - n + hop - 1) // hop)
    xp = np.concatenate([x, np.zeros(n + (m - 1) * hop - len(x), np.float32)])
    idx = np.arange(n)[None, :] + hop * np.arange(m)[:, None]
    return np.fft.rfft(xp[idx] * win, axis=1).astype(np.complex64)


def istft(spec, n, hop, win, length):
    y = np.fft.irfft(spec, n=n, axis=1).astype(np.float32) * win
    m = spec.shape[0]
    out = np.zeros(n + (m - 1) * hop, np.float32)
    norm = np.zeros_like(out)
    for i in range(m):
        out[i * hop : i * hop + n] += y[i]
        norm[i * hop : i * hop + n] += win * win
    return (out / np.maximum(norm, 1e-6))[:length]


def wpe(x, strength=1.0, taps=20, delay=3, iterations=3, n=1536, hop=384, chunk=48):
    """Single-channel WPE on 48 kHz audio (32 ms frames, 8 ms hop: nara_wpe's 512/128 at 16 kHz): the late echo
    predicted from taps frames starting delay frames back, taken away (times strength, 0-1)."""
    if strength <= 0 or len(x) < n * 4:
        return x
    win = np.sqrt(np.hanning(n + 1)[:-1]).astype(np.float32)
    Y = stft(x, n, hop, win).T  # [F, T]
    F, T = Y.shape
    eps = 1e-10 * float(np.max(Y.real**2 + Y.imag**2) or 1.0)
    X = np.empty_like(Y)
    for f0 in range(0, F, chunk):
        y = Y[f0 : f0 + chunk]
        fc = y.shape[0]
        # The delayed frames each frame is predicted from: psi[:, k, t] = y[:, t - delay - k].
        psi = np.zeros((fc, taps, T), np.complex64)
        for k in range(taps):
            s = delay + k
            if s < T:
                psi[:, k, s:] = y[:, : T - s]
        est = y
        for it in range(iterations):
            inv = 1.0 / np.maximum(est.real**2 + est.imag**2, eps)
            wpsi = psi * inv[:, None, :]
            R = wpsi @ np.conj(psi).transpose(0, 2, 1)  # [fc, K, K]
            P = wpsi @ np.conj(y)[:, :, None]  # [fc, K, 1]
            load = (np.trace(R, axis1=1, axis2=2).real / taps * 1e-6 + 1e-20)[:, None, None]
            G = np.linalg.solve(R + load * np.eye(taps, dtype=np.complex64)[None], P)[..., 0]
            pred = np.einsum("fk,fkt->ft", np.conj(G), psi)
            est = y - (strength if it == iterations - 1 else 1.0) * pred
        X[f0 : f0 + chunk] = est
    return istft(X.T, n, hop, win, len(x))


def decode(src, start, seconds):
    """The source's sound from start, seconds long, as 48 kHz mono float32 (padded with silence past its end)."""
    args = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin"]
    if start > 0:
        args += ["-ss", f"{start:.6f}"]
    args += ["-i", src, "-t", f"{seconds:.6f}", "-vn", "-map", "0:a:0", "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"]
    raw = subprocess.run(args, check=True, capture_output=True).stdout
    x = np.frombuffer(raw, np.float32).copy()
    want = int(round(seconds * SR))
    return np.concatenate([x, np.zeros(max(0, want - len(x)), np.float32)])[:want]


def encode_flac(x, path):
    tmp = path + ".part"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-f", "f32le", "-ar", str(SR), "-ac", "1", "-i", "-",
                    "-c:a", "flac", "-sample_fmt", "s32", "-f", "flac", tmp], input=np.asarray(x, np.float32).tobytes(), check=True)
    os.replace(tmp, path)


def read_audio(path):
    raw = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-i", path, "-ac", "1", "-ar", str(SR), "-f", "f32le", "-"], check=True, capture_output=True).stdout
    return np.frombuffer(raw, np.float32).copy()


def block_span(k, block, seconds):
    a = k * block
    return a, max(a, min(seconds, (k + 1) * block))


def make_blocks(args):
    blocks = [int(b) for b in args.blocks.split(",") if b != ""]
    denoise, dereverb = max(0.0, min(100.0, args.denoise)), max(0.0, min(100.0, args.dereverb))
    model = DeepFilterNet3(args.models, args.threads) if denoise > 0 else None
    # The strength as the most the model may turn noise down: 100 = all it takes out; 50 about 18 dB, 20 about 7 dB.
    lim = None if denoise >= 100 else 6 + (denoise / 100) ** 1.5 * 34
    os.makedirs(args.out, exist_ok=True)
    took = {"read": 0.0, "dereverb": 0.0, "denoise": 0.0, "write": 0.0}
    done = 0
    for k in blocks:
        a, b = block_span(k, args.block, args.seconds)
        if b <= a:
            raise SystemExit(f"block {k} starts past the video's end ({args.seconds} s)")
        t0 = time.time()
        s0 = max(0.0, a - PRE)
        e0 = min(args.seconds, b + OVERLAP + POST)
        x = decode(args.input, s0, e0 - s0)
        t1 = time.time()
        y = wpe(x, dereverb / 100.0) if dereverb > 0 else x
        t2 = time.time()
        if model is not None:
            y = model.enhance(y, lim)
        t3 = time.time()
        i0 = int(round((a - s0) * SR))
        i1 = i0 + int(round((min(args.seconds, b + OVERLAP) - a) * SR))
        out = np.clip(y[i0:i1], -1.0, 1.0)
        encode_flac(out, os.path.join(args.out, f"voice-{k}.flac"))
        t4 = time.time()
        for key, v in zip(took, (t1 - t0, t2 - t1, t3 - t2, t4 - t3)):
            took[key] += v
        done += 1
        print(f"PROGRESS {round(100 * done / len(blocks))}", flush=True)
    print(json.dumps({"blocks": blocks, "seconds": {k: round(v, 2) for k, v in took.items()}}), flush=True)


def join(args):
    blocks = sorted(int(b) for b in args.blocks.split(",") if b != "")
    total = int(round(args.seconds * SR))
    out = np.zeros(total + int(round(OVERLAP * SR)), np.float32)
    ov = int(round(OVERLAP * SR))
    ramp = np.sin(0.5 * np.pi * (np.arange(ov) + 0.5) / ov).astype(np.float32) ** 2 if ov else np.zeros(0, np.float32)
    made = set()
    for k in blocks:
        a, b = block_span(k, args.block, args.seconds)
        i0 = int(round(a * SR))
        x = read_audio(os.path.join(args.dir, f"voice-{k}.flac"))
        x = x[: len(out) - i0]
        if k - 1 in made and ov:
            # The block before ran OVERLAP past this one's start: crossfade from it into this block there.
            n = min(ov, len(x))
            out[i0 : i0 + n] = out[i0 : i0 + n] * (1 - ramp[:n]) + x[:n] * ramp[:n]
            out[i0 + n : i0 + len(x)] = x[n:]
        else:
            out[i0 : i0 + len(x)] = x
        # What runs past this block's end is only kept if the next block crossfades over it.
        end = int(round(b * SR))
        if k + 1 not in blocks:
            out[end : end + ov] = 0
        made.add(k)
    encode_flac(out[:total], args.out)
    print(json.dumps({"joined": blocks, "samples": total}), flush=True)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--join", action="store_true")
    p.add_argument("--input")
    p.add_argument("--dir")
    p.add_argument("--blocks", required=True)
    p.add_argument("--block", type=float, required=True)
    p.add_argument("--seconds", type=float, required=True)
    p.add_argument("--denoise", type=float, default=100)
    p.add_argument("--dereverb", type=float, default=0)
    p.add_argument("--models")
    p.add_argument("--threads", type=int, default=int(os.environ.get("VOICE_THREADS", "0") or 0))
    p.add_argument("--out", required=True)
    args = p.parse_args()
    if args.join:
        join(args)
    else:
        if not args.input or (args.denoise > 0 and not args.models):
            p.error("--input and --models are needed")
        make_blocks(args)


if __name__ == "__main__":
    main()
