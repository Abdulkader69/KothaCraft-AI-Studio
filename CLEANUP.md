# What this project installed on this Mac

Everything added on 2026-09-06 to get the pipeline running, and how to remove it.
Measured, not estimated. **Total added: ~1.7 GB.**

## Homebrew — ~687 MB

Three formulas installed on request, which pulled in **76 dependencies that exist
only for this project**:

| Formula | Why | Cellar size |
|---|---|---|
| `ffmpeg-full` | The one that matters. Plain `ffmpeg` is codecs-only and lacks `drawtext`/`ass` | 57 MB |
| `ffmpeg` | Installed first, before I found it was the minimal build. **Now redundant** | 52 MB |
| `python@3.12` | kokoro-tts needs >=3.11,<3.13; system Python is 3.9.6 | 80 MB |

Biggest of the 76 pulled-in deps: `icu4c@78` (84 MB), `rav1e` (48 MB),
`vulkan-headers` (40 MB), `glib` (39 MB), `tesseract` (33 MB), `shaderc` (31 MB).

Nothing else on this machine depends on any of the three — verified with
`brew uses --installed`. Your `node`, `php`, `mariadb`, `nginx`, `composer`,
`dnsmasq`, `wget`, `yarn`, `wp-cli` and `opencode` are untouched and share only
common libraries (`openssl@3`, `freetype`, `sqlite`, `webp`…) that must stay.

## Project directory — ~1.0 GB

| Path | Size | Notes |
|---|---|---|
| `.venv/` | 674 MB | kokoro-tts + onnxruntime, scipy, numba, torch-free stack |
| `kokoro-v1.0.onnx` | 310 MB | voice model |
| `voices-v1.0.bin` | 25 MB | voice data |
| `out/` | 96 MB | generated frames, audio, final.mp4 — regenerable any time |

`node_modules/` (37 MB) was already here before this work.

## mflux (local image generation) — ~6.8 GB, optional, **currently removed**

| Path | Size | Notes |
|---|---|---|
| `.venv-mflux/` | 1.3 GB | dedicated Python env |
| `.mflux/` | 5.5 GB | Z-Image-Turbo 4-bit weights + mflux cache |

Removed with **one command**, which touches nothing else:

```bash
npm run mflux:remove
```

Verified: deletes exactly those two folders, leaves `.venv/` (kokoro/MMS) and
`~/.cache/huggingface` untouched, safe to run twice. `npm run mflux:setup` brings it back.

## Bangla voices — optional, each removed with one command

| Provider | Paths | Size | Remove |
|---|---|---|---|
| Piper bn_BD | `.venv-piper/`, `.piper/` | ~250 MB | `npm run piper:remove` |
| VITS-BD | `.venv-vits-bd/`, `.vits-bd/` | ~1.6 GB | `npm run vits-bd:remove` |

Same isolation as mflux: nothing outside the project, safe to run twice, `*:setup` brings
it back.

## Shell config

Two lines appended to `~/.zshrc` (around line 147):

```bash
# ffmpeg-full (keg-only) — needed for drawtext/ass filters
export PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH"
```

## Files added to the repo

`.env`, `HANDOVER.md`, `CLEANUP.md`, `scripts/kokoro-setup.ts`. Plus edits to
`src/providers/tts.ts`, `src/providers/images.ts`, `scripts/render-images.ts`,
`scripts/doctor.ts`, `src/types.ts`, `content/demo.json`, `.env.example`,
`.gitignore`, `README.md`.

---

# Cleanup

## Free space now, keep everything working — ~455 MB

```bash
brew cleanup                    # ~359 MB of stale downloads
npm run clean                   # ~96 MB of generated output
```

Both are safe and repeatable. `npm run clean` just deletes `out/`.

## Drop the redundant ffmpeg — ~52 MB

Plain `ffmpeg` is dead weight now that `ffmpeg-full` is installed:

```bash
brew uninstall ffmpeg
brew autoremove
```

## Pause the voice, keep the code — ~1.0 GB

```bash
rm -rf .venv kokoro-v1.0.onnx voices-v1.0.bin
```

Restore later with:

```bash
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv .venv
./.venv/bin/python -m pip install kokoro-tts
npm run kokoro:setup
```

Set `TTS_PROVIDER=placeholder` in `.env` meanwhile, or the pipeline will fail at
`generate-tts`.

## Remove everything — ~1.7 GB

```bash
# project artifacts
rm -rf .venv out kokoro-v1.0.onnx voices-v1.0.bin

# homebrew formulas and their now-orphaned dependencies
brew uninstall ffmpeg ffmpeg-full python@3.12
brew autoremove
brew cleanup
```

Then delete the two `ffmpeg-full` lines from `~/.zshrc`.

> **Careful:** `brew autoremove` removes every orphaned dependency on the machine,
> not only ours. Run `brew autoremove --dry-run` first and read the list.

## Do NOT remove

`ffmpeg-full` on its own while still expecting the pipeline to work — the plain
`ffmpeg` bottle has no `drawtext` or `ass` filter, so step one fails with
`No such filter: 'drawtext'`. If you uninstall `ffmpeg-full`, the pipeline is done
until you reinstall it.
