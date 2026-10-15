"""
Bangladeshi Bangla VITS (EMTIAZZ/bangladeshi-bangla-tts-vits) via Coqui TTS.

  python scripts/vits_bd_tts.py <input.txt> <output.wav>

Run from .venv-vits-bd, which pins the Coqui stack — upstream is unmaintained
and breaks with current transformers/torch, so those pins are the whole point.
"""
import os
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: vits_bd_tts.py <input.txt> <output.wav>", file=sys.stderr)
        return 2
    text = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
    if not text:
        print("vits-bd: empty input text", file=sys.stderr)
        return 1

    os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
    import warnings
    warnings.filterwarnings("ignore")
    from huggingface_hub import hf_hub_download
    from TTS.utils.synthesizer import Synthesizer

    repo = "EMTIAZZ/bangladeshi-bangla-tts-vits"
    syn = Synthesizer(
        tts_checkpoint=hf_hub_download(repo, "pytorch_model.pth"),
        tts_config_path=hf_hub_download(repo, "config.json"),
        use_cuda=False,
    )
    # The model runs sentences together with no breath between them. Synthesise
    # one sentence at a time and put a short silence after each — the danda,
    # question mark, exclamation mark and full stop all count as sentence ends.
    import re
    import numpy as np
    # Three pause lengths: full stop after । ! ? ., dramatic pause after — …, shorter breath after , ;
    pause = float(os.environ.get("VITS_BD_PAUSE", "0.38"))
    dramatic = float(os.environ.get("VITS_BD_DRAMATIC", "0.28"))
    breath = float(os.environ.get("VITS_BD_BREATH", "0.18"))
    sr = syn.output_sample_rate
    # split keeping the separator so each chunk knows what ended it
    chunks = [c for c in re.split(r"([।!?\.]+|[—…]+|[,;]+)\s*", text) if c is not None]
    sentences = []   # (text, seconds of silence after it)
    for i in range(0, len(chunks), 2):
        body = chunks[i].strip()
        sep = chunks[i + 1] if i + 1 < len(chunks) else ""
        if not body:
            continue
        # keep the punctuation on the chunk — the model phrases slightly better with it
        silence = (
            pause if re.search(r"[।!?\.]", sep)
            else dramatic if re.search(r"[—…]", sep)
            else breath if sep
            else 0.0
        )
        sentences.append((body + sep, silence))
    if not sentences:
        sentences = [(text, 0.0)]

    def trim(a, thresh=0.01, keep=0.08):
        """Cut the model's own silence off both ends, keeping a short natural tail."""
        loud = np.flatnonzero(np.abs(a) > thresh)
        if not len(loud):
            return a
        lo = max(0, loud[0] - int(sr * keep))
        hi = min(len(a), loud[-1] + int(sr * keep))
        return a[lo:hi]

    parts = []
    for i, (sentence, silence) in enumerate(sentences):
        parts.append(trim(np.asarray(syn.tts(sentence), dtype=np.float32)))
        if i < len(sentences) - 1 and silence > 0:
            parts.append(np.zeros(int(sr * silence), dtype=np.float32))
    wav = np.concatenate(parts)
    Path(sys.argv[2]).parent.mkdir(parents=True, exist_ok=True)
    syn.save_wav(wav, sys.argv[2])
    print(f"vits-bd: wrote {sys.argv[2]} @ {syn.output_sample_rate} Hz, {len(wav)/syn.output_sample_rate:.2f}s, {len(sentences)} chunk(s), {pause}s / {breath}s pauses")
    return 0


if __name__ == "__main__":
    sys.exit(main())
