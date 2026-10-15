"""
Meta MMS-TTS — free, offline speech for languages kokoro does not cover (Bangla).

  python scripts/mms_tts.py <input.txt> <output.wav> [--lang ben] [--speed 1.0]

Weights come from Hugging Face on first use and are cached in ~/.cache/huggingface,
so later runs are offline. Prints the sample rate it wrote, for the caller's logs.
"""
import argparse
import sys
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("input")
    ap.add_argument("output")
    ap.add_argument("--lang", default="ben", help="ISO 639-3 code, e.g. ben, hin, eng")
    ap.add_argument("--speed", type=float, default=1.0)
    args = ap.parse_args()

    text = Path(args.input).read_text(encoding="utf-8").strip()
    if not text:
        print("mms: empty input text", file=sys.stderr)
        return 1

    try:
        import numpy as np
        import torch
        from scipy.io import wavfile
        from transformers import VitsModel, AutoTokenizer
    except ImportError as e:
        print(f"mms: missing dependency ({e.name}) — pip install torch transformers", file=sys.stderr)
        return 1

    model_id = f"facebook/mms-tts-{args.lang}"
    try:
        tokenizer = AutoTokenizer.from_pretrained(model_id)
        model = VitsModel.from_pretrained(model_id)
    except Exception as e:
        print(f"mms: could not load {model_id} — {e}", file=sys.stderr)
        return 1

    # Some MMS languages need Latin romanisation first; Bangla does not, but say so
    # clearly rather than emitting silence if a caller picks one that does.
    if getattr(tokenizer, "is_uroman", False):
        try:
            import uroman as ur
            text = ur.Uroman().romanize_string(text)
        except ImportError:
            print(f"mms: {args.lang} needs romanisation — pip install uroman", file=sys.stderr)
            return 1

    inputs = tokenizer(text, return_tensors="pt")
    # VITS exposes rate as a divisor: higher speaking_rate = faster speech.
    if args.speed and args.speed != 1.0:
        model.speaking_rate = args.speed

    with torch.no_grad():
        waveform = model(**inputs).waveform

    audio = waveform.squeeze().cpu().numpy()
    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    if peak < 1e-4:
        print("mms: model produced silence", file=sys.stderr)
        return 1
    # Normalise to a sane level; render-voice loudness-normalises properly later.
    audio = (audio / peak) * 0.95

    rate = int(model.config.sampling_rate)
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    wavfile.write(args.output, rate=rate, data=(audio * 32767).astype(np.int16))
    print(f"mms: wrote {args.output} @ {rate} Hz, {audio.size / rate:.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
