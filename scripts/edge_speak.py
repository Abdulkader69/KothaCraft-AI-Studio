"""
Edge TTS — Microsoft neural voices via the Edge read-aloud endpoint (edge-tts).

  python scripts/edge_speak.py <input.txt> <output.mp3> [words.json]

Run from .venv-edge. Writes the MP3 the service streams back (24 kHz mono) and,
when asked, the word boundaries it sends alongside — start/end in seconds,
relative to the audio — so captions can be word-accurate.

  EDGE_VOICE   bn-BD-NabanitaNeural (default) | bn-BD-PradeepNeural | any `edge-tts --list-voices` name
  EDGE_RATE    "+0%" … e.g. "-8%" a touch slower, "+10%" faster
  EDGE_PITCH   "+0Hz" … e.g. "-20Hz"
"""
import asyncio
import json
import os
import sys
import time
from pathlib import Path


async def synth(text: str, voice: str, rate: str, pitch: str):
    import edge_tts
    audio = bytearray()
    words = []
    com = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, boundary="WordBoundary")
    async for chunk in com.stream():
        if chunk["type"] == "audio":
            audio += chunk["data"]
        elif chunk["type"] == "WordBoundary":
            # offsets are in 100-nanosecond ticks
            start = chunk["offset"] / 1e7
            words.append({"word": chunk["text"], "start": round(start, 3), "end": round(start + chunk["duration"] / 1e7, 3)})
    return bytes(audio), words


def main() -> int:
    if len(sys.argv) not in (3, 4):
        print("usage: edge_speak.py <input.txt> <output.mp3> [words.json]", file=sys.stderr)
        return 2
    text = Path(sys.argv[1]).read_text(encoding="utf-8").strip()
    if not text:
        print("edge: empty input text", file=sys.stderr)
        return 1
    voice = os.environ.get("EDGE_VOICE") or "bn-BD-NabanitaNeural"
    rate = os.environ.get("EDGE_RATE") or "+0%"
    pitch = os.environ.get("EDGE_PITCH") or "+0Hz"

    # The endpoint is shared and unofficial — a 403, DNS blip or dropped stream
    # now and then is normal. Retry with progressive backoff before giving up.
    last = None
    delays = [3, 5, 8, 12, 16]
    max_attempts = len(delays) + 1
    for attempt in range(1, max_attempts + 1):
        try:
            audio, words = asyncio.run(synth(text, voice, rate, pitch))
            if len(audio) < 1024:
                raise RuntimeError("no audio returned")
            break
        except Exception as err:  # noqa: BLE001
            last = err
            delay = delays[attempt - 1] if attempt <= len(delays) else 15
            is_dns = "ClientConnectorDNSError" in type(err).__name__ or "nodename nor servname" in str(err)
            dns_hint = " (DNS/network hiccup — waiting for reconnection)" if is_dns else ""
            print(f"edge: attempt {attempt}/{max_attempts} failed{dns_hint} — {type(err).__name__}: {str(err)[:120]} (retrying in {delay}s)", file=sys.stderr)
            time.sleep(delay)
    else:
        print(f"edge: giving up after {max_attempts} attempts ({last}). If this keeps happening the endpoint is blocking or offline — switch TTS_PROVIDER for now.", file=sys.stderr)
        return 1

    out = Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(audio)
    if len(sys.argv) == 4:
        Path(sys.argv[3]).write_text(json.dumps(words, ensure_ascii=False), encoding="utf-8")
    end = words[-1]["end"] if words else 0
    print(f"edge: wrote {out} ({len(audio) // 1024} KB, {voice}, rate {rate}), {len(words)} word boundaries, last ends {end:.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
