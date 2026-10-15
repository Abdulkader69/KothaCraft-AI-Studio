# Setup notes — state of this machine

Written 2026-09-06. What was installed, why, and what's still open.

## Run it

```bash
npm run ui         # local page at http://localhost:5173 — easiest way in
npm run doctor     # preflight — tells you exactly what's missing
npm run all        # terminal render → out/final.mp4
```

The UI (`scripts/serve.ts` + `public/index.html`) drives the same scripts; it adds
per-scene image reroll, per-scene image replace, import/export of `demo.json`-style
project files, and live logs. It prepends the `ffmpeg-full` path itself, so it works
even from a shell that lacks it.

Importing preserves fields the form does not show (`music`, `texture`,
`image.negative`, caption colours, `voice.voiceId`…) — the page keeps the imported
object and the server merges form edits onto it.

Settings survive reloads: ordinary fields and draft scenes in browser storage,
credentials via *Save keys to .env*. Only an allowlist of variables can be written from
the page. **`scripts/serve.ts` is not watched — restart `npm run ui` after editing it**,
or the page will look updated while the server behaves as it did at boot.

`.env` is already configured. Everything below is local and free — no API keys.

## ffmpeg: you need `ffmpeg-full`, not `ffmpeg`

Homebrew split the formula. The plain `ffmpeg` bottle is **codecs-only** — no
`libfreetype`, no `libass` — so the `drawtext` and `ass` filters don't exist and the
pipeline dies on step one with `No such filter: 'drawtext'`. Both are load-bearing:
`drawtext` for placeholder cards, `ass` for caption burn-in.

`ffmpeg-full` is keg-only, so this was appended to `~/.zshrc`:

```bash
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH"
```

**Open a new terminal** (or `source ~/.zshrc`) or you'll silently get the minimal build.

## Voice — kokoro, local and free

kokoro-tts needs Python `>=3.11,<3.13`; system Python is 3.9.6. So:

- `brew install python@3.12`
- venv at `.venv/` with `kokoro-tts` 2.3.2 (gitignored)
- `.env` sets `KOKORO_BIN` to the venv binary, since `.venv/bin` isn't on PATH
- `kokoro-v1.0.onnx` (326 MB) + `voices-v1.0.bin` (26 MB) in the project root,
  fetched by `npm run kokoro:setup` (gitignored)

### One gotcha worth keeping

kokoro intermittently crashes at interpreter shutdown:

```
libc++abi: terminating due to uncaught exception of type std::__1::system_error:
recursive_mutex lock failed: Invalid argument
```

This happens **after** the wav is fully written — the audio is fine. So the provider in
`src/providers/tts.ts` judges a run by its output (wav present and >1 KB), not by its
exit code. Don't revert that to a plain exit-code check; the pipeline would then fail
at random on whichever scene loses the race.

## Images — pollinations, free, no account

`IMAGE_PROVIDER=pollinations`. A plain HTTP GET, no key.

Two quirks handled in `src/providers/images.ts`:

- It **ignores the requested size** — a 1080x1920 request comes back ~576x1024 — so
  the result is upscaled and cropped to the project frame.
- It does **not** take `image.model`; that field holds a fal id (`fal-ai/flux/dev`).
  Use `POLLINATIONS_MODEL` instead.

Seeds are derived from the prompt, so re-runs reproduce the same frames. Retries 3x,
since it's a free community service with real rate limits.

**Only `sana` is available on the free tier** — no FLUX — so prompt adherence is weak.
When an image comes out wrong:

```bash
npm run render:images -- --reroll 02,04   # new seeds for just those scenes
```

Pin a good roll with `"seed": 445566` on the scene. If re-rolling keeps giving the
same *kind* of wrong image, fix the prompt instead — `image.style` applies to every
scene and "volumetric light" in particular overpowers individual prompts, turning most
underwater scenes into a light shaft.

## .env parsing

`loadEnv` strips inline comments from unquoted values, so `CF_STEPS=  # max 20` reads as
empty rather than as the comment text. Before that fix it produced `num_steps: NaN`,
which serialised to JSON `null` and got a puzzling `400 Type mismatch` from Cloudflare.
Quote a value to keep a literal `#` (`PRIMARY="#FFD166"`). Numeric settings are also
clamped defensively in `src/providers/images.ts`, so a bad value falls back instead of
reaching an API as `null`.

## Reels and music

Renders go to `out/reels/<slug>/`, one self-contained folder per reel (`OUT_DIR` picks
it; `src/config` reads that from the real environment at import time, so it cannot come
from `.env`). The UI's gallery lists them, loads one back on click, and deletes on ✕.

`music/` is the shared library. A project's `music.file` wins; otherwise a track is
picked by hashing the title so it stays stable. The bed is loudness-normalised to
−16 LUFS **before** `gainDb`, so quiet tracks are no longer inaudible — don't remove
that `loudnorm` or music will silently vanish for quietly-mastered files.

## Still open

| Item | Status |
|---|---|
| mflux local images | Wired + tested, **removed for disk** after an A/B showed SDXL holds its own. `npm run mflux:setup` brings it back |
| **Word-accurate captions** | `WORD_TIMING=off`. kokoro returns no alignment; `local` needs openai-whisper (~2.5 GB of torch) |
| ~~Bangla narration~~ | **Done, twice.** `piper` (16 Bangladeshi voices, MIT) and `vits-bd` (natural, Apache-2.0). Default is now `piper` speaker 0. **MMS is CC-BY-NC — don't use it for monetized reels** |
| **ElevenLabs** | Fully wired and untouched — set `TTS_PROVIDER=elevenlabs` + a key when you want it. It's the only provider that returns free word alignment |

### Bangla note

Text rendering is *not* the blocker — only the voice is. `ffmpeg-full` is built
`--enable-libharfbuzz`, and Bengali conjuncts shape correctly. If you do get a Bangla
voice, set these so captions don't render as tofu boxes:

```bash
FONT_FILE=/System/Library/Fonts/Supplemental/Bangla Sangam MN.ttc
CAPTION_FONT=Kohinoor Bangla
```
