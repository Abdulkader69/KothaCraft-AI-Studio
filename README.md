# KothaCraft AI Studio 🎬💬

> **The complete local-first AI video & dialogue production suite.**  
> Turn stories, multi-character conversations, scripture verses, and text prompts into finished cinematic reels with native voice synthesis, diffusion video (LTX-2 / Wan 2.2), word-level animated captions, and multi-platform publishing.

Turn a prompt, script, or conversation into a broadcast-ready 9:16 or 16:9 reel with AI imagery/video, narration, word-level captions, and a ducked music bed. Runs natively on Apple Silicon with zero cloud costs.

Every step writes files, and every step skips work that already exists, so you can re-run
one piece without redoing the expensive ones.

```
project.json
   │
   ├─ render:images    →  01-images/<id>.png     AI image per scene
   ├─ generate:tts     →  04-tts/<id>.mp3        narration (+ word alignment, if available)
   ├─ render:voice     →  05-voice/<id>.wav      trim silence + loudness normalise
   ├─ transcribe       →  06-words/<id>.json     word timings (only if TTS gave none)
   ├─ align            →  timeline.json          ← source of truth for all timing
   ├─ pick:stock       →  stock.json             footage reels only: a clip from stock/ per scene
   ├─ render:motion    →  02-motion/<id>.mp4     ken-burns pan/zoom, a generated clip (motion "ai"), or a footage cut
   ├─ render:texture   →  03-texture/<id>.mp4    grade, grain, vignette
   ├─ render:captions  →  captions.ass           word-level cues
   ├─ render:music     →  music-bed.wav          looped, faded, level-matched
   └─ master           →  final.mp4              concat + mix + burn-in (captions, cards, watermark)
```

Everything lands in `out/reels/<slug>/`, one folder per reel.

---

## Requirements

**Node 18+** (uses built-in `fetch`) and **ffmpeg with libass + freetype**.

> **The ffmpeg trap.** Homebrew split its formula. Plain `brew install ffmpeg` gives a
> codecs-only build with **no `drawtext` and no `ass` filter**, and the pipeline dies on
> step one with `No such filter: 'drawtext'`. You need:
>
> ```bash
> brew install ffmpeg-full
> echo 'export PATH="/opt/homebrew/opt/ffmpeg-full/bin:$PATH"' >> ~/.zshrc
> ```
>
> `ffmpeg-full` is keg-only, hence the PATH line. On Debian/Ubuntu `sudo apt install
ffmpeg` is fine. Run `npm run doctor` to confirm — it checks every filter used.

---

## Quick start

```bash
npm install
cp .env.example .env
npm run doctor      # tells you exactly what is missing
npm run ui          # → http://localhost:5180
```

That's enough to render immediately: images come from **Pollinations** (free, no account)
and narration from **kokoro** if installed, otherwise silent placeholder audio of the
right length — which is still enough to design timing, captions and layout.

### Adding the local voice (optional, free)

kokoro needs Python 3.11 or 3.12 — not the system 3.9 on macOS:

```bash
brew install python@3.12
/opt/homebrew/opt/python@3.12/bin/python3.12 -m venv .venv
./.venv/bin/python -m pip install kokoro-tts
npm run kokoro:setup        # ~350 MB of model files, one time
```

Then set `KOKORO_BIN` in `.env` to `<project>/.venv/bin/kokoro-tts`, since the venv is
not on your PATH.

---

## What it uses

Nothing here is required — each row is a swappable provider, and the free ones are the
defaults.

### Images — `IMAGE_PROVIDER`

| Provider                            | Cost                         | Notes                                                                                                                                                                             |
| ----------------------------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mflux` _(optional, not installed)_ | free, fully local, no limits | Apple Silicon only, ~6.8 GB. `npm run mflux:setup` to try it; `mflux:remove` to drop it                                                                                           |
| **`pollinations`** _(default)_      | free, **no account**         | Only the `sana` model is offered. Ignores requested size (a 1080×1920 ask returns ~576×1024) so output is upscaled. Anonymous tier is rate-limited to **1 image / 15s**; no quota |
| **`cloudflare`**                    | free daily tier              | Better prompt adherence. Needs `CF_ACCOUNT_ID` + `CF_API_TOKEN`                                                                                                                   |
| `fal`                               | paid                         | Any model id via `image.model`, e.g. `fal-ai/flux/dev`                                                                                                                            |
| `openai`                            | paid                         | `gpt-image-1`                                                                                                                                                                     |
| `placeholder`                       | free, offline                | Gradient cards with the prompt drawn on them                                                                                                                                      |

### Voice — `TTS_PROVIDER`

| Provider                 | Cost                                           | Languages                                    | Word timings          |
| ------------------------ | ---------------------------------------------- | -------------------------------------------- | --------------------- |
| **`kokoro`** _(default)_ | free, **fully local**                          | `en-us`, `en-gb`, `fr-fr`, `it`, `ja`, `cmn` | ❌                    |
| **`piper`**              | free, **fully local**                          | **Bangladeshi** Bangla, 16 voices            | ❌                    |
| **`vits-bd`**            | free, **fully local**                          | **Bangladeshi** Bangla, 1 natural voice      | ❌                    |
| `mms`                    | free, local, ⚠️ **non-commercial licence**     | ~1,100 incl. Bangla                          | ❌                    |
| `gemini`                 | free on the flash preview models (~15 req/day) | Bangla + 20 more, 30 generic voices          | ❌                    |
| `elevenlabs`             | free tier / paid                               | 29 (v2) or 70+ (v3, incl. Bangla)            | ✅ **free alignment** |
| `placeholder`            | free                                           | silence of the right length                  | ❌                    |

### Captions — `WORD_TIMING`

Timings come from the first source available:

1. **ElevenLabs alignment** — returned with the audio, no extra call or cost. Automatic
   when `TTS_PROVIDER=elevenlabs`.
2. **Whisper** — `WORD_TIMING=local` (offline, needs whisper installed) or
   `WORD_TIMING=openai`. This is the path for kokoro and MMS, which return no timings.
3. **Estimate** — words spread across the take by character length. Fine for designing
   the look, not tight enough to publish.

---

## The UI

```bash
npm run ui     # → http://localhost:5180
```

Binds to `127.0.0.1` only, runs one job at a time, and drives the same scripts as the CLI.
Three pages share one stylesheet (`public/ui.css`): `/` for reels, `/stock` for reels cut
from local video (see _Local video_ below), `/cards` for photo cards.

- **Scenes** — a row per scene: image prompt, narration, motion, seed. Thumbnails appear
  as they render.
- **Reroll** — re-rolls one scene's image, pins the new seed, and clears that scene's
  downstream clips so the next render picks it up.
- **Replace** — upload your own image for a stubborn scene; normalised to the frame.
- **Import / export** — load any project JSON, or drag files onto the scene list. Several
  files (or a bundle) offer a choice: load one to edit, or _Render all_ to queue every
  project for batch render straight away.
- **Preview a line** — synthesize one sentence with the current voice settings (or scene
  1's narration if the box is empty) and play it in the page. Instant on kokoro/piper, a
  few credits on ElevenLabs — catches a wrong voice or a mispronunciation before a full
  render. Writes to `out/tmp/voice-preview/`, never to a reel.
- **Publish** — connect YouTube and a Facebook Page (+ its Instagram account) once,
  then post the loaded reel to any of them with a title, caption and hashtags. Links and
  dates are recorded next to the project. See _Publishing_ below — it has the two
  one-time setups and the YouTube private-lock caveat.
- **Analytics** — _Refresh from platforms_ pulls views, average watch time and, where
  offered, the retention curve for every published reel into a table (and
  `out/analytics.json`), so you can see which hooks held attention.
- **Batch render** — queue many reels and let them render one after another. _From
  content/ folder…_ lists every project file in `content/` — tick the days you want — or
  _Load file(s)…_ picks any number of JSON files from disk; then tick reels → _Queue
  selected_; or _Queue current reel_. The queue shows each reel's status and time, with pause / skip / remove,
  skips reels that already have a video unless told otherwise, and survives a server
  restart (`out/reels/.queue.json`). Renders use the provider settings as they are when
  you queue. See _Batch rendering_ below for the overnight recipe.
- **Photo cards** — its own page at `/cards` (link in the header): a JSON set of quotes
  becomes finished images, no video. Text, source and heading through the caption font,
  a generated background per card (Cloudflare by default — pick the provider on the
  page), your style and watermark. Import / export the JSON, or fill the set from the
  current reel's scenes. See _Photo cards_ below.
- **Hook variants** — up to three alternative openings for scene 1 (prompt, line, seed).
  Each renders a full reel — `final-b.mp4`, `final-c.mp4` — sharing scenes 2+, so a
  variant costs one image, one narration and one master. Tabs above the video switch
  between them; publish the one that holds.
- **Platform safe area** — Instagram / TikTok / YouTube Shorts. Pushes captions,
  citations, cards and the watermark out of the strips those apps draw their own UI
  over, and tints those strips on the preview so you can see what will be covered.
- **Captions** — show, or hide for a voice-only reel (citations and cards still show;
  transcription is skipped).
- **Intro & outro** — on by default: the title over the first scene for 3 s before
  narration starts, and a 6 s follow card (`প্রতিদিন একটি গল্প / ফলো করুন / facebook//হিকমাহ-Wisdom`)
  held on the last scene. The scene's own ken-burns keeps running underneath, so there is
  no cut. Blank = default, `0` = off, any text overrides.
- **Brand / watermark** — defaults to the channel name `হিকমাহ-Wisdom` top right; switch to a logo,
  change the text, or turn it off from `assets/brand/` (upload
  from the page). Pick the corner, size, opacity and margin; see below.
- **Live logs** — the same output you'd see in the terminal, streamed.
- **Your reels** — every reel at the bottom of the page. The page opens as a new, empty
  reel (settings remembered, nothing loaded); click a card to load that reel and its video,
  ✕ to delete, _+ New reel_ to clear again.
- **Capability chips** — ffmpeg and kokoro status up front, so a missing dependency shows
  as a banner instead of a mid-render failure.

### Import shapes

| Shape                         | Result                                  |
| ----------------------------- | --------------------------------------- |
| `{ title, scenes: [...] }`    | loaded straight in                      |
| `[ {project}, {project}, … ]` | picker appears — choose one             |
| `{ projects: [ … ] }`         | same picker                             |
| `[ {prompt, narration}, … ]`  | bare scene list, keeps current settings |

Selecting several files pools them into one picker. Fields the form doesn't show —
`music`, `texture`, `image.negative`, `image.model`, caption colours, `fps`, `gap`,
`scenes[].seconds` — are carried through untouched rather than dropped.

One project renders at a time; the picker chooses which.

### Settings and keys

Ordinary settings and your in-progress scenes persist in the browser, so a reload loses
nothing. **Credentials go to `.env`** via _Save keys to .env_ (gitignored). After that the
password boxes stay blank and read _"saved in .env — leave blank to use it"_ — empty
fields fall through to `.env` rather than overriding it. _Forget_ clears browser settings
and leaves `.env` alone.

> `scripts/serve.ts` is **not** watched. Restart `npm run ui` after editing it, or the page
> will look updated while the server behaves as it did at boot.

---

## Verse reels (`/verses`)

A different shape of video from a reel: **one animated background runs the whole
length**, and only the text changes over it. Built for Quran ayat — the Arabic
held large and centred, the translation under it, the ayat marker closing the
line the way a mushaf does.

```bash
npm run verses -- --project content/verses/demo.json
```

…or open <http://localhost:5180/verses> after `npm run ui`.

### The audio is recitation, not TTS

No speech engine recites Quran — tajwid, maqam and breath are a performance, not
pronunciation — so verse reels play **real per-ayat recordings**. Each ayat is
held on screen for exactly as long as its recording takes. The translation is
**caption only**; it is spoken solely when `voiceover: "bangla"`, and then it is
mixed under the recitation rather than replacing it.

```bash
npm run fetch:recitation -- --list                                  # the qaris
npm run fetch:recitation -- --project content/verses/demo.json      # get the clips
npm run verses           -- --project content/verses/demo.json
```

The set needs `surah`, and each verse needs its `ayah` number — that pair is how
a clip is located. Clips cache in `assets/recitation/<reciter>/` and are shared
by every set, so an ayat is only ever fetched once. A verse can also point at
its own file with `audio`, and `recitation.dir` uses a local folder instead.

`style` is what decides how a reel feels: **mujawwad** is the slow, melodic,
emotive classical style (Abdul Basit, Al-Minshawi) — pick it when the reel
should move someone; **murattal** is measured and even, so more ayat fit in a
short reel. The registry is `src/reciters.ts`.

Recordings are levelled per clip, then the finished mix is measured once and
corrected with a flat gain to `DELIVER_LUFS` (default −14, matching what social
platforms expect). Single-pass `loudnorm` is a dynamic filter and does not land
on its target, which is why the correction is a separate measured step.

> The recitations belong to the reciters and their publishers. They are shared
> freely for da'wah; whether that covers a monetised post is the channel owner's
> call. The same goes for the **translation** — modern published translations are
> copyrighted, so use one you have the rights to.

### The background

Backgrounds are drawn in JavaScript and rendered by headless Chrome, not
generated by an image model: the artwork is flat vector work, so a model can
neither hold it steady nor make the clouds drift.

```bash
npm run render:bg -- --theme ramadan-gold --seconds 12
npm run render:bg -- --still --phase 0.5 --out /tmp/look.png   # check any moment
npm run bg:all                                                 # every theme
```

Themes live in `scripts/bg/themes/*.json` — drop a new file in and it appears in
the dropdown. The artwork itself is `scripts/bg/scene.html`, parametric at the
top (`DEFAULTS`): palette, horizon, star and firefly counts, speed, and toggles
for the arch, palms, lanterns, grain and reflection.

`render-verses` renders the background for a theme at the output size the first
time it is used (~2 min) and caches it as
`assets/bg/<theme>-<w>x<h>.mp4`; every later reel on that theme is instant.
`--rebuild-bg` forces a re-render after you edit the scene.

**Seamless loops.** The scene is a pure function of loop phase `t`, and every
moving thing is periodic in it. When checking a seam, compare **source renders**
(`--still --phase`), not frames pulled out of the encoded mp4 — frame 0 is an
I-frame and the last frame is a predicted one, so the mp4 shows a false ~8 dB
PSNR gap that is compression, not drift.

### How it opens

Recitation begins with the ta'awwudh, and a surah opens with the basmala. Set
`opening` and both are prepended as ordinary held verses — captioned, timed and
recited like any ayat:

| `opening` | when |
|---|---|
| `"taawwudh"` | starting mid-surah (Al-Waqiah from ayat 8, Ayat al-Kursi) |
| `"both"` | opening a surah from its first ayat |
| `"basmala"` / `"none"` | as needed |

The per-ayat host numbers each surah's basmala as **ayah 000**, so it arrives in
that reciter's own voice and maqam rather than borrowed from al-Fatiha.
Surah 9 (At-Tawbah) has no basmala and is skipped automatically. There is no
per-ayat file for the ta'awwudh — drop one at
`assets/recitation/taawwudh.mp3` or it is shown silently.

Ready-made sets live in `content/verses/`: al-fatihah, al-ikhlas, al-falaq,
an-nas, ayat-al-kursi and the Al-Waqiah demo. They are listed in the page's
**Import** panel, which also opens a `.json` file, takes pasted JSON, and
exports the current set back out.

### Fonts

```bash
npm run fonts:setup          # ~2 MB into assets/fonts, nothing installed system-wide
```

Bundled faces, all SIL OFL: **Amiri Quran** for the ayat (cut for Quranic text,
so the tashkeel sits properly instead of colliding at display size), with Amiri
and Scheherazade New alongside, and **Hind Siliguri** plus Noto Serif Bengali
for the translation. They reach libass through the `ass` filter's `fontsdir`, so
nothing touches the system font directory and the repo stays portable. Without
them it falls back to the OS faces. Override with `ARABIC_FONT` / `BANGLA_FONT`.

One ASS style is one font, and no Latin or Bangla face draws Arabic, so the
Arabic line gets its own style.

Arabic faces differ a lot in how much of the em they fill — Amiri draws far
smaller than a UI face at the same point size, which would leave the translation
visually louder than the ayat. The default Arabic size is scaled per face to
correct for that; an explicit `type.arabicSize` is taken literally.

Separately, the burned-in watermark goes through ffmpeg's `drawtext`, which
needs a **font file**, not a family name. Point `FONT_FILE` at one that has your
script or the watermark comes out as empty boxes:

```
FONT_FILE=/System/Library/Fonts/KohinoorBangla.ttc
```

## Output layout

```
out/reels/
  day-29 - সদকা-সম্পদ-কমায়-না/   01-images/ … final.mp4  "সদকা সম্পদ কমায় না.mp4"  project.json
  the-deep-ocean/                 01-images/ … final.mp4  "The Deep Ocean.mp4"       project.json
```

The folder is `<file> - <title>` when the reel came from a file (`day-29.json`; the 17th
project of a bundle gets `bundle-17 - …`), or just the title slug when it was typed into
the form. A reel loaded from the gallery renders back into its own folder as long as its
title is unchanged; a new title is a new reel. `"folder": "…"` in a project file pins the
name outright.

`final.mp4` is the video every tool looks for; beside it, `master` writes the same video
under the **real title** — a hard link, so no extra disk — for Finder and uploads. Hook
variants become `Title (B).mp4`.

Each reel is self-contained — images, audio, captions, timeline, music bed, video, and the
project file that defines it. Footage reels also carry `stock.json` (which clip each scene
got) and `02-motion/<id>.src.mp4` (the extracted stretch, cached across re-fits).

For CLI runs, `OUT_DIR` picks the folder:

```bash
OUT_DIR=out/reels/my-reel npm run all
```

It must come from the real environment, **not `.env`** — `src/config` resolves it at import
time, before any script reads `.env`.

### Cleaning up

```bash
npm run clean            # clears rendered artifacts; project.json kept
npm run clean -- --all   # deletes out/ entirely, reels and all
```

The default deliberately keeps `project.json`, since that is what makes a reel exist.

---

## Music

Drop tracks into `music/`, or use _Upload track_ in the UI. Precedence:

1. `music.file` on the project, if it exists
2. otherwise a track from `music/`, chosen by hashing the title — so a reel keeps the
   **same** music across re-renders instead of shuffling
3. otherwise a synthesised pad

The bed is **loudness-normalised to −16 LUFS before `music.gainDb` is applied**, so any
track lands at a predictable level whatever its own mastering. Without that a quiet source
vanishes (−29 dB source + default −18 dB gain = −51 dB, inaudible) and a loud one buries
the narration. `gainDb` therefore means "dB below the voice", default −18.

Music ducks under speech automatically via `sidechaincompress`, with a limiter on the mix.

---

## Non-English narration (Bangla, Hindi, …)

kokoro covers only six languages. For **Bangla** there are two local providers trained
on Bangladeshi speech — pick by ear with the comparison in `out/tts-compare/`:

|               | Voices | Licence               | Size   | Speed       | Notes                                                                  |
| ------------- | ------ | --------------------- | ------ | ----------- | ---------------------------------------------------------------------- |
| **`piper`**   | 16     | MIT (+ CC-BY-SA data) | 250 MB | 0.6 s/scene | Google's OpenSLR-37 Bangladesh corpus. Slightly synthetic, very robust |
| **`vits-bd`** | 1      | Apache-2.0            | 1.6 GB | 1.2 s/scene | More natural. Runs a frozen Coqui stack — don't `pip upgrade` it       |

```bash
npm run piper:setup      /  npm run piper:remove
npm run vits-bd:setup    /  npm run vits-bd:remove
```

Both live in their own venv inside the project and are removed exactly. The UI's
**Audition all 16** button renders one line in every Piper speaker so you can choose.

### Edge TTS — Microsoft's bn-BD voices, free, unofficial

`TTS_PROVIDER=edge` (`npm run edge:setup`, ~20 MB, no account) speaks through the
endpoint the Edge browser's *Read aloud* uses, via the `edge-tts` package. That gives you
Microsoft's neural **bn-BD-Nabanita** (female) and **bn-BD-Pradeep** (male) — the best
Bangladeshi Bangla voices available anywhere for free — plus ~300 other voices
(`EDGE_VOICE`, with a speed control in `EDGE_RATE`). It also returns **word boundaries**
with the audio, so captions are word-accurate with `WORD_TIMING=off`, like ElevenLabs.

The catch is in the name: it is not an API Microsoft offers. It works today, it may be
throttled or change tomorrow, and there is no licence to point to. The provider retries
a few times and then fails the scene with a clear message; when that happens, switch to
`piper` and try Edge again later. Don't make it the *only* voice a batch depends on.

`mms` (Meta) still works for ~1,100 other languages, but it is **CC-BY-NC-4.0 — not
licensed for commercial use**. Don't publish monetized reels voiced by it.

Two things matter for non-Latin scripts, both handled for you:

- **Fonts.** Helvetica has no Bengali glyphs, so captions render as empty boxes. Set
  `FONT_FILE` and `CAPTION_FONT` to a Bengali-capable pair — the UI fills in
  `Bangla Sangam MN.ttc` / `Kohinoor Bangla` automatically when you pick a Bangla voice.
- **Letter spacing is dropped automatically.** ASS `Spacing` makes libass position every
  glyph individually, which shatters Indic, Arabic and Thai clusters — Bangla comes out as
  consonants with dotted-circle vowel signs. `render-captions` detects a complex script and
  sets tracking to 0; Latin keeps it.

### Pronunciation fixes (`content/pronounce.json`)

Some spellings read wrong in every Bangla TTS — the past-habitual `-ত` (জানত, করত) comes
out as a dead consonant, and words like এত / মৃত / মুক্ত lose their final *o*. The fix is
to respell them **for the voice only**:

```json
{ "জানত": "জানতো", "করত": "করতো", "এত": "এতো", "মৃত": "মৃতো" }
```

`generate:tts` and the voice preview send narration through this map (whole words,
punctuation attached to the word is kept: জানত। → জানতো।). The narration itself never
changes, so captions, post text and exports keep the real spelling; the log shows
`pronounced: জানত→জানতো` for each scene it touched, and only those scenes re-voice when
the file changes. Keys starting with `_` are comments; a key starting with `*` is a suffix rule
(`"*ছিল": "ছিলো"` respells every word ending in ছিল). The shipped file covers the `-ত`,
`-ল` and `-ব` verb forms and the final-*o* words — about a hundred entries — and
deliberately skips look-alikes such as আসল (the adjective *ashol*).

**One file per engine.** Each voice gets different things wrong, so a spelling tuned by
ear on one is noise on another:

| file | applies to |
| --- | --- |
| `content/pronounce.json` | every provider — abbreviations and the like |
| `content/pronounce.edge.json` | only `TTS_PROVIDER=edge` |
| `content/pronounce.<provider>.json` | only that provider |

The provider's file is merged on top of the shared one, so a provider entry wins, and
mapping a key to its own spelling there cancels a shared rule for that provider. Today
the shared file holds only the honorifics — an abbreviation is an abbreviation whoever
reads it — and the ~100 respellings confirmed by ear on the bn-BD voices live in
`pronounce.edge.json`.

Three kinds of entry, in order of priority:

| key | means | example |
| --- | --- | --- |
| `"জানত"` | this whole word | `জানত → জানতো` |
| `"*ছিল"` | any word with this ending | `গিয়েছিল → গিয়েছিলো` |
| `"~য"` | this letter, inside any word | `যখন → য়খন` |

Letter rules run last — over a word's respelling too, so an expansion that itself
contains a troublesome letter is fixed as well. They fire in **one pass, longest key
first**, so `"~য়": "য"` and `"~য": "য়"` swap the two letters instead of undoing each
other, and an identity rule shields a sequence from a shorter one: `"~্য": "্য"` is why
the jo-phola conjunct in জন্য and ধৈর্য survives the bare-য swap. The shipped file uses
this to undo the Edge voices reading য় as *j* and য as *y*.

**Honorifics** are short on screen and full in the voice: `(রাঃ)` → রাদিয়াল্লাহু আনহু,
`(রাহাঃ)` → রাদিয়াল্লাহু আনহা (the female form), plus `(আঃ)`, `(সাঃ)`, `(রহঃ)`. Written
with a dot (`রা.`), a colon, or bare inside brackets works the same — but note that the
visarga `ঃ` is a *combining mark*, so `রাঃ` is a different word from `রা` and each
spelling needs its own entry. The trailing dot or colon is dropped when a word expands
into several, so the voice does not hear a sentence ending mid-sentence.

**Finding the right spelling** — `npm run say` auditions a word several ways through the
voice you actually render with:

```bash
npm run say -- সৌভাগ্য সৌভাগ্গো শৌভাগ্গো            # three spellings, back to back
npm run say -- সৌভাগ্য --in "এই সৌভাগ্য কেবল মুমিনেরই।"   # judged inside a sentence
npm run say -- জানত জানতো --voice bn-BD-PradeepNeural
```

Each take lands in `out/tts-compare/say-NN-<spelling>.mp3`, plus `say-all.mp3` with every
take in order. The dictionary is not applied (you are testing raw spellings) but the
current mapping is printed. Put the winner in `content/pronounce.json`.

Beware of over-correcting: the bn-BD voices already pronounce the inherent final *o*, so
adding `ো` to a word that was already right makes it over-articulated — which reads as
Kolkata Bangla rather than Dhaka. Respell only what you have heard go wrong.

Captions always display the narration's own words and take only their **timing** from
the voice — so respelled words, Edge's punctuation-less word boundaries and whisper's
guessed spellings all still show your text.

None of the local voices return word timings, so `WORD_TIMING` still applies.

### Bangla via Gemini (free preview)

`TTS_PROVIDER=gemini` speaks Bangla and is free on the flash preview models, but its
voices are shared across languages — expressive, not a native accent — and the free tier
allows only ~15 requests a day, so preview a line before rendering a reel with it.

### Bangla via ElevenLabs

Possible on the **free plan**, with two catches:

- **Model.** Bengali is _not_ in `eleven_multilingual_v2`'s 29 languages. Use
  `ELEVENLABS_MODEL=eleven_v3`, the only model that lists it.
- **Voice.** Free accounts get `402 payment_required` on **library** voices. Use a
  _premade_ one — the UI's voice dropdown only lists usable ones.

The free tier gives 10,000 credits/month (~36 reels of typical length) but **no commercial
licence** — that starts at $6/month. Its real advantage over the local models is free
word-level alignment, which is the difference between estimated and truly synced captions.

---

## Re-rolling a bad image

Seeds derive from the prompt, so a plain re-run reproduces the same frame — including one
you hated.

```bash
npm run render:images -- --reroll        # every scene
npm run render:images -- --reroll 02,04  # only these; the rest stay cached
```

Each roll prints its seed; keep a good one with `"seed": 445566` on the scene.

If re-rolling keeps producing the same _kind_ of wrong image, the prompt is the problem,
not the seed. `image.style` applies to every scene and can overpower an individual prompt —
"volumetric light", for instance, turns most underwater scenes into a light shaft whatever
else you asked for.

---

## Running steps individually

```bash
npm run all                                   # everything
npm run render:images -- --project content/demo.json
npm run render:motion -- --force              # --force ignores cached output
npm run master
npm run doctor                                # preflight check
```

Every step takes `--project <file>`. `--force` applies to the steps that cache their
output — `render:images`, `pick:stock`, `render:motion`, `render:texture`, `generate:tts`,
`render:voice`, `transcribe`, `render:music`. `align`, `render:captions` and `master`
always rebuild, since they are cheap and depend on everything upstream.

---

## Project file reference

| Key                                                         | Meaning                                                                                                          |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `title`                                                     | also becomes the reel's folder name                                                                              |
| `aspect`                                                    | `9:16` (1080×1920), `16:9`, `1:1`                                                                                |
| `platform`                                                  | `instagram` \| `tiktok` \| `youtube` — keep text and logo out of that app's UI strips                            |
| `hooks[]`                                                   | alternative scene-1 openings: `prompt`, `narration`, `seed`, `motion`, `clip` (omitted fields inherit)           |
| `footage`                                                   | `"stock"` — cut every scene from local video in `stock/` instead of generating images (see _Local video_)        |
| `stock.zoom` / `stock.fade`                                 | push-in amount (`0.08`) and fade length in seconds (`0.25`) on footage cuts                                       |
| `stock.only`                                                | shortlist of clip names — auto-pick chooses only among these (the ticked clips in the UI)                         |
| `scenes[].clip`                                             | a file in `stock/` (or a repo path) for this scene; with `footage: "stock"` omitted = auto-pick by keywords       |
| `publish.title` / `.description` / `.hashtags` / `.privacy` | post text overrides; otherwise derived from title, first narration line and the citations                        |
| `poster.scene` / `.text` / `.tagline`                       | cover image source scene (default `01`), headline (default `title`), second line                                 |
| `gap`                                                       | silence added after each scene's narration                                                                       |
| `image.style`                                               | appended to every scene prompt for a consistent look                                                             |
| `image.negative`                                            | negative prompt (SDXL, fal, openai — ignored by pollinations/flux)                                               |
| `image.model`                                               | provider-specific model id (fal)                                                                                 |
| `voice.kokoroVoice` / `voice.lang`                          | kokoro voice and language                                                                                        |
| `voice.mmsLang`                                             | MMS language, ISO 639-3                                                                                          |
| `voice.voiceId`                                             | ElevenLabs voice — **overrides `.env`**, so leave it out to use the UI's pick                                    |
| `voice.speed`                                               | playback rate                                                                                                    |
| `scenes[].prompt`                                           | image prompt                                                                                                     |
| `scenes[].narration`                                        | TTS text; also the caption source                                                                                |
| `scenes[].seed`                                             | pin this scene's image roll                                                                                      |
| `scenes[].seconds`                                          | optional floor on scene length                                                                                   |
| `scenes[].motion`                                           | `in` \| `out` \| `left` \| `right` \| `ai` (generated clip, paid)                                                |
| `scenes[].motionPrompt`                                     | with `ai`: what should move — "mist drifting, slow push in"                                                      |
| `video.seconds` / `.prompt` / `.negative`                   | defaults for `ai` scenes: clip length asked of the model (5), motion prompt, negative                            |
| `scenes[].source`                                           | citation shown small at the top of frame while that scene plays                                                  |
| `music.file`                                                | path to a track; omit to auto-pick from `music/`                                                                 |
| `music.gainDb`                                              | dB below the voice (default −18)                                                                                 |
| `captions.style`                                            | `highlight` \| `word` \| `chunk`                                                                                 |
| `captions.show`                                             | `false` hides the word cues — voice-only reel; citations and cards remain                                        |
| `captions.wordsPerCue`                                      | 3 gives the usual fast reel rhythm                                                                               |
| `captions.primary` / `.highlight` / `.outline`              | hex colours                                                                                                      |
| `captions.fontName`                                         | ASS font **family name**, not a path                                                                             |
| `captions.showSource`                                       | set `false` to hide citations (default: shown when a scene has one)                                              |
| `captions.sourceColor` / `.sourceMarginV`                   | citation colour and distance from the top                                                                        |
| `texture.*`                                                 | grain, vignette, contrast, saturation, optional overlay PNG                                                      |
| `intro.seconds` / `intro.text`                              | title card before scene 1 — **default 3 s**, text defaults to `title`; `0` turns it off                          |
| `outro.seconds` / `outro.text`                              | closing card after the last scene — **default 6 s** with the follow-us text; `\n` breaks lines; `0` turns it off |
| `brand.text`                                                | watermark text — **default `হিকমাহ-Wisdom`, top right** when `brand` is absent; `brand.off: true` removes it     |
| `brand.image`                                               | watermark logo, e.g. `assets/brand/logo.png` (wins over `text`); transparent PNG looks best                      |
| `brand.position`                                            | `top-right` _(default)_ \| `top-left` \| `bottom-right` \| `bottom-left`                                         |
| `brand.size`                                                | logo width in px (default 140) or text font size (default 36)                                                    |
| `brand.opacity` / `.margin` / `.color`                      | 0–1 (default 0.85); px from the edge (default 64); text colour (default `white`)                                 |

### Intro and outro cards

`align` reserves the card time — scene 1's narration starts at `intro.seconds`, `total`
includes both cards — so voice, captions and the music bed all line up without special
cases. `render:motion` renders the first and last clips longer by the card length, so
the title plays over scene 1's own pan and the outro over the last scene's; `master`
trims to match. `render:captions` writes the text as ASS events (`Title` / `Outro`
styles, centred, same font and outline as the captions, so Bangla shapes correctly).
Cached clips are re-rendered automatically when they are shorter than the timeline now
needs. Changing only the card text needs `align` → `render:captions` → `master`.

### Publishing

`npm run publish -- --project out/reels/<slug>/project.json --to youtube,facebook,instagram`
uploads that reel's `final.mp4` and writes `publish.json` beside it (ids, links, dates). The
UI's _Publish_ section does the same for the loaded reel. Each platform is posted once;
`--again` (or the _repost_ box) forces a repost. Post text comes from `publish.*` in the
project, or — when absent — the title, the first narration line and the citations, plus a
default hashtag set.

#### Quick checklist (come back to this)

|                      | YouTube                                                                                                                                                   | Facebook Page + Instagram                                                                     |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Where                | console.cloud.google.com                                                                                                                                  | developers.facebook.com                                                                       |
| Create               | project → enable _YouTube Data API v3_ + _YouTube Analytics API_ → OAuth consent (External, add yourself as test user) → OAuth client **Web application** | app of type **Business** → add **Facebook Login**                                             |
| Redirect URI         | `http://localhost:5180/oauth/youtube/callback`                                                                                                            | `http://localhost:5180/oauth/meta/callback`                                                   |
| Keys → `.env`        | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`                                                                                                              | `META_APP_ID`, `META_APP_SECRET`                                                              |
| Account prerequisite | a channel on the Google account you connect                                                                                                               | Instagram **professional** account linked to the Page (Business Suite → Settings → Instagram) |
| Connect              | UI → Publish → _Connect YouTube_                                                                                                                          | UI → Publish → _Connect Facebook / Instagram_ → tick all permissions → pick the Page          |
| Review needed?       | **Yes for public uploads** — see the private lock below                                                                                                   | No — Development mode covers your own Pages                                                   |
| Tokens stored        | `.publish/youtube.json`                                                                                                                                   | `.publish/meta.json` (user token 60 days; Page tokens long-lived)                             |

**First publish:** load a rendered reel → Publish → set YouTube privacy to `private`, tick
YouTube + Facebook, leave Instagram for a second run → _Publish_ → watch the log. Each
platform is one line: a link on success, the platform's error message on failure.

**What has and has not been verified.** The OAuth round-trips, the job flow, the post
text, the recorded `publish.json` and the analytics table are tested. The uploads
themselves follow the documented request sequences (YouTube resumable insert; Facebook
`video_reels` start → upload → finish; Instagram resumable container → `media_publish`)
but were written without live accounts — the first real run may need a small fix, so keep
the log open.

#### One-time setup — YouTube

1. [console.cloud.google.com](https://console.cloud.google.com) → create a project.
2. _APIs & Services → Library_ → enable **YouTube Data API v3** and **YouTube Analytics API**.
3. _OAuth consent screen_ → External → add your own Google account under _Test users_.
4. _Credentials → Create credentials → OAuth client ID → Web application_ → add
   `http://localhost:5180/oauth/youtube/callback` as an authorised redirect URI.
5. Put the client ID and secret in `.env` (`YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`) —
   or paste them in the UI's _App credentials_ panel and _Save keys to .env_.
6. UI → _Publish → Connect YouTube_ → approve the three scopes. Tokens land in
   `.publish/youtube.json` (gitignored) and refresh themselves.

**The private lock.** Google locks every video uploaded through an API project that has
not passed its compliance audit to **private** — the owner cannot make it public from
Studio. Two ways through: apply for the audit (YouTube API Services → _Compliance_,
2–4 weeks; a demo video of the OAuth flow and a use-case description) and publish
freely afterwards; or keep publishing as `private` from here and post public Shorts
manually until then. Facebook and Instagram have no such gate.

#### One-time setup — Facebook Page + Instagram

1. [developers.facebook.com](https://developers.facebook.com) → _My Apps → Create app_ →
   type **Business** → name it.
2. Add the **Facebook Login** product → _Settings_ → _Valid OAuth Redirect URIs_ =
   `http://localhost:5180/oauth/meta/callback` → save.
3. _App settings → Basic_ → copy **App ID** and **App Secret** into `.env`
   (`META_APP_ID`, `META_APP_SECRET`) or the UI panel.
4. Your Instagram must be a **professional account linked to the Facebook Page**
   (Meta Business Suite → Settings → Instagram accounts → connect).
5. UI → _Publish → Connect Facebook / Instagram_ → tick every permission it asks for →
   pick the Page if you manage several. The long-lived user token and the Page tokens
   go to `.publish/meta.json`.

In _Development_ mode the app's admins can publish to Pages they manage and read their
insights without App Review, which is all a personal channel needs. Facebook Reels must
be 3–90 s, 9:16, ≥540×960; Instagram Reels 3 s–15 min. The pipeline's output already fits.

If a connection goes stale (Meta user tokens expire after ~60 days, YouTube tokens
refresh on their own), _Disconnect_ and _Connect_ again. Files: `.publish/*.json` hold the
tokens (delete to forget), `out/reels/<slug>/publish.json` records what was posted where.

#### Analytics

`npm run analytics` (or _Analytics → Refresh from platforms_ in the UI) reads every reel
with a `publish.json` and writes `analytics.json` beside it and a set-wide
`out/analytics.json`: views, likes/comments/shares, average watch time, average
percentage watched, and the retention curve where the platform provides one (YouTube
`audienceWatchRatio` by elapsed ratio; Facebook `post_video_retention_graph`; Instagram
gives averages only). YouTube needs about a day and a minimum number of views before
retention appears. Read the curve for the first three seconds first — that is the hook.

### Batch rendering

Two ways to render the whole 60-day set (or any list of project files) unattended:

**From the UI** — Reels page → _Batch render_ → _From content/ folder…_ → tick
`60-days/day-11.json` … `day-60.json` (or the whole bundle) → _Load selected files_ → tick
the reels → _Queue selected_. _Load file(s)…_ does the same from a file dialog and accepts
many files at once. The server works through
the queue one reel at a time (it uses the same single-job lock, so a manual render waits
its turn). Close the tab; the queue keeps going. Reopen it to watch progress, pause,
skip the current reel, or remove queued ones. If the Mac sleeps or the server restarts,
pending reels resume where they left off.

**From the terminal** — no browser, good for `caffeinate` overnight runs:

```bash
caffeinate -i npm run batch -- content/60-days-all.json               # all 60
caffeinate -i npm run batch -- content/60-days-all.json --only 11-30  # a range
npm run batch -- content/60-days/day-1*.json                          # any files
npm run batch -- content/60-days-all.json --force                     # re-render finished ones too
```

Provider choices come from `.env`. A failing reel is logged and the batch continues; a
summary with timings prints at the end. Both paths skip reels that already have a
`final.mp4`, so re-running after a crash only does what is left.

Rough budget for 60 reels on this Mac with local voices and Cloudflare images: 3–5
minutes a reel, so 3–5 hours end to end. Generated motion (`motion: "ai"`) adds 1–3
minutes per marked scene on fal, 2–5 locally.

### Local video (stock footage)

The **Local video** page (`/stock`) is the Reels page with the image provider taken out:
every scene is cut from a clip in `stock/` instead of a generated image. Nothing is
billed, nothing is downloaded, and everything else — voice, captions, music, cards,
hooks, watermark, publish, batch — is exactly the same code.

**Setup:** put free, copyright-free clips in `stock/` (Pexels, Pixabay, Mixkit and Coverr
all allow commercial use), or upload / drag them into the _Footage library_ panel. Name
files by what they show — `ocean-waves-sunset.mp4`, `city-night-traffic.mp4` — because
that is how the picker matches them. Subfolders work and their names count as words.

**How a clip is chosen** (`scripts/pick-stock.ts`, run after `align` so it knows the
real scene lengths):

1. A scene that names a `clip` gets that clip.
2. Otherwise every file is scored by how many of its name words appear in the scene's
   keywords (the prompt box, weighted double) and narration. Clips already used in
   the reel go to the back, so nothing repeats within a reel. Ties break by a stable
   hash — the same reel picks the same clips on every run, but not "the first file
   alphabetically" every time.
3. A start second is chosen inside the clip so the scene fits without looping, skipping
   the first moments (stock clips often fade in) and spread by hash so long clips are not
   always cut to their opening.
4. A still frame goes to `01-images/<id>.png`, so the poster, thumbnails and intro/outro
   cards work unchanged.

Scenes whose words match something are assigned first (best match first), then the
rest fill by rotation — so a scene with no match never takes, by chance, the one clip a
later scene was written for. **Tick** clips in the library to make a per-reel shortlist:
auto-pick then chooses only among the ticked ones (`stock.only` in the project file);
pinned clips may still be anything.

The choice is recorded in `out/reels/<slug>/stock.json`; the page shows it under each
scene ("`forest-fog.mp4` — from 6.3 s of 20 s"). **Reroll clip** asks for the next-best
one; the **Clip** dropdown pins a specific file (or goes back to _auto_); **Upload clip**
adds a video to the library and pins it in one go.

**How it is cut** (`render:motion`): the stretch is extracted at frame size with the
audio dropped, then fitted like a generated clip — trimmed when long, slowed a little
when slightly short, ping-ponged when much shorter. Every cut then gets a slow push-in
(or pull-out / pan, per the scene's _Motion_ — the same `zoompan` the images use, so
the two kinds of scene match) and a short fade at each end, so a cut lands softly
instead of jumping. `stock.zoom` (default `0.08`) and `stock.fade` (seconds, default
`0.25`; `0` for hard cuts) tune it per project. Wide clips are centre-cropped to the
frame; 4K sources are fine, just slower.

From the CLI:

```bash
npm run all -- --project content/stock-demo.json          # "footage": "stock" in the file
npm run pick:stock -- --project … --reroll 02              # a different clip for scene 02
STOCK_DIR=/Volumes/Footage npm run all -- --project …      # a library somewhere else
```

Mixed reels work too: a normal image project may give any single scene a `"clip"`.

### Photo cards

The same machinery, without the timeline: `content/cards/<set>.json` → `out/cards/<slug>/<id>.png`.

```bash
npm run cards -- --project content/cards/demo.json              # every card
npm run cards -- --project content/cards/demo.json --reroll 02  # new background for card 02
```

```json
{
  "title": "আজকের আয়াত",
  "aspect": "1:1", // 1:1 (1080²) | 4:5 (1080×1350) | 9:16 (1080×1920)
  "layout": "center", // center: whole image dimmed | bottom: dark ramp under the text
  "heading": "আজকের আয়াত", // small label at the top (optional)
  "prompt": "…", // default background when a card has none (optional)
  "image": { "style": "…", "negative": "…" },
  "captions": {
    "fontName": "Kohinoor Bangla",
    "primary": "#FFFFFF",
    "highlight": "#EBCB80"
  },
  "brand": {
    "image": "assets/brand/profile-400.png",
    "position": "bottom-right",
    "size": 110
  },
  "cards": [
    {
      "text": "নিশ্চয়ই কষ্টের সাথে স্বস্তি আছে।",
      "source": "সূরা ইনশিরাহ ৯৪:৬",
      "prompt": "…"
    },
    {
      "text": "…",
      "source": "…",
      "prompt": "…",
      "layout": "bottom",
      "seed": 4242
    }
  ]
}
```

Only `text` is required per card. The face size adapts to the length of the text; the
source sits under it in the accent colour. `content/cards/60-days.json` holds one card per
day of the 60-day set — the day's key verse or hadith with a background written for text
to sit on — generated from `scripts/content/cards60.py` by `make-content.py`. Backgrounds
are generated once per card id
(`01-images/`), so editing text and re-making costs nothing — `--reroll` or the UI's
_Reroll background_ draws a new one. `content/cards/demo.json` is a starting point.

### Poster (CLI only)

`render:poster` writes `poster.png` (the reel's aspect), `poster-1x1.png` (1080²) and
`poster-16x9.png` (1280×720) — `-b`, `-c` suffixed for hook variants. Other aspects are
built as a blurred fill with the still fitted on top, so a vertical image becomes a wide
thumbnail without a brutal crop. Text goes through libass with the caption font, so it
shapes exactly like the captions do. Not part of `npm run all` — run it when you want one.
`poster.scene` / `.text` / `.tagline` in the project file pick the image and words.

```bash
OUT_DIR=out/reels/<slug> npm run render:poster -- --project out/reels/<slug>/project.json
```

### Generated motion (`motion: "ai"`)

By default every scene moves with a ken-burns pan/zoom — free, instant, exact length.
A scene with `"motion": "ai"` instead asks an image-to-video model for a real clip:
mist drifts, flames flicker, the camera moves through the space. It is a per-scene
choice, so spend it where it matters — the hook, the most atmospheric shot — and leave
the rest on ken-burns.

- **Remote** — `VIDEO_PROVIDER=fal` (the default) calls fal.ai's queue with `VIDEO_MODEL`
  (`fal-ai/wan/v2.2-5b/image-to-video`), using the same `FAL_KEY` as the fal image
  provider. Nothing is installed. Roughly 5–10¢ and 1–3 minutes per clip.
- **Local** — `VIDEO_PROVIDER=local` runs Wan 2.2 TI2V-5B on this Mac through
  [mlx-video](https://github.com/Blaizzy/mlx-video). `npm run wan:setup` makes a venv,
  downloads the checkpoint (~22 GB), converts it to MLX (~21 GB kept in `.wan/`, the
  download is deleted), and renders a test clip; `npm run wan:remove` deletes it all.
  Needs Apple Silicon with 32 GB+ unified memory. Free and offline, 2–5 minutes a clip
  at the model's native 704×1280; the model loads for the clip and is released when the
  step exits — nothing stays in RAM between renders. `VIDEO_LOCAL_SECONDS` (3.4) and
  `VIDEO_LOCAL_STEPS` (30) trade time for length and quality. Either way, a reel with no
  `ai` scenes never touches a video model.
- **Cached raw.** The model's clip is kept as `02-motion/<id>.ai.mp4` and reused until the
  scene's image changes (a reroll or replace deletes it), so re-running after a timeline
  change never re-pays.
- **Fitted to the scene.** Models return ~5 s; scenes run 3–9 s. `render:motion` trims if
  the scene is shorter, slows down with frame interpolation up to 1.6×, and beyond that
  ping-pongs (forward, reverse, forward…) from a cached `<id>.pp.mp4`. Ambient motion —
  mist, water, stars, light — hides all three; fast, directional motion does not.
- **Prompting.** `motionPrompt` (or `video.prompt`) says what should move; the scene's
  image prompt is appended for context. Keep it slow: "gentle wind moving sand, stars
  drifting, slow camera push in".

### Hook variants

`hooks[0]` renders as variant **B**, `hooks[1]` as **C**. The pipeline runs the main cut,
then one pass per hook with `HOOK=b` in the environment: `loadProject` swaps scene 1 for
the hook (id `01b`, so its image, narration and clip cache beside scene 1's) and every
whole-reel file takes the suffix — `timeline-b.json`, `captions-b.ass`, `music-bed-b.wav`,
`final-b.mp4`. Scenes 2+ are unchanged and stay cached, so each variant is one image,
one line of TTS and one master.

```bash
HOOK=b OUT_DIR=out/reels/<slug> npm run master -- --project out/reels/<slug>/project.json
```

TTS files carry a sidecar (`01.mp3.txt`) holding the narration and voice that produced
them; a changed line re-synthesises just that scene, and a changed voice re-synthesises
the reel. Files from before sidecars existed are adopted as-is.

### One cut per platform

Each app draws its own UI over a different strip of the frame, so a single caption
position cannot clear them all — captions that sit well on YouTube disappear behind
Instagram's bottom bar. `platforms` renders the same video again for each app, with the
captions and watermark lifted above that app's furniture:

```json
"platforms": ["instagram", "facebook", "youtube"]
```

→ `final-ig.mp4`, `final-fb.mp4`, `final-yt.mp4` beside `final.mp4` (and title-named
copies `Title (IG).mp4` …). Only `render-captions` and `master` re-run — images, motion,
voice and the timeline are shared — so each extra cut costs seconds, not a render. Hook
variants combine: hook B for Instagram is `final-b-ig.mp4`.

`publish` uploads the matching cut automatically when it exists, falling back to
`final.mp4`. In the UI the cuts appear as tabs under the video.

**If captions are invisible on Instagram, this is why** — a reel with no `platform` set
puts them 307 px up, and Instagram's UI covers the bottom 422 px. Either set
`platform: instagram`, or tick the platform here and post the cut made for it.

### Covers and thumbnails

`render:poster` runs at the end of every render, so a cover always exists:
`poster.png` at the reel's aspect, plus `poster-1x1.png` and `poster-16x9.png`.

- **YouTube** gets `poster-16x9.png` as a custom thumbnail. This only works on a
  **verified channel** — an unverified one answers 403, which is reported as a warning
  and leaves YouTube's own auto-frame in place. `publish.thumbnail` points somewhere
  else; `""` turns it off.
- **Instagram and Facebook** cannot be given an image from here: their API takes a
  `cover_url` that must be publicly reachable, and this runs on a laptop. They use a
  **frame of the video** instead — `publish.coverAt` in seconds (default 1), or the
  *Reels cover* box in the publish panel.

### Platform safe areas

`src/safe.ts` holds the strips each app covers (bottom ~20–24 %, right ~15 %, top ~6–10 %).
With `platform` set, captions sit above the bottom strip, citations below the top one,
cards keep clear of the right column, and a watermark's margin grows by the strip on its
side (bottom corners also clear the caption band). Explicit `captions.marginV` /
`brand.margin` still win.

### Watermark

`master` burns the brand block in last, over the captions. Only the final step re-runs
when you change it:

```bash
OUT_DIR=out/reels/<slug> npm run master -- --project out/reels/<slug>/project.json
```

Top corners are the safe choice — Instagram and TikTok draw their own controls over the
bottom ~15% and the right edge.

### Caption styles

| Style                   | Look                                                                             |
| ----------------------- | -------------------------------------------------------------------------------- |
| `highlight` _(default)_ | a 3-word cue sits on screen; the spoken word turns accent-coloured and scales up |
| `word`                  | one word at a time, centre screen, with a pop-in                                 |
| `chunk`                 | plain cue, no per-word highlight                                                 |

---

## Configuration (`.env`)

| Variable                                      | Values                                                                     | Notes                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `IMAGE_PROVIDER`                              | `pollinations` \| `cloudflare` \| `fal` \| `openai` \| `placeholder`       | first two free                                                         |
| `POLLINATIONS_MODEL` / `POLLINATIONS_SEED`    |                                                                            | optional; blank derives a stable per-prompt seed                       |
| `CF_ACCOUNT_ID` / `CF_API_TOKEN`              |                                                                            | token needs the Workers AI permission                                  |
| `CF_MODEL`                                    | SDXL _(default)_ or `@cf/black-forest-labs/flux-1-schnell`                 | see below                                                              |
| `CF_STEPS`                                    | SDXL max 20, flux max 8                                                    |                                                                        |
| `FAL_KEY` / `OPENAI_API_KEY`                  |                                                                            |                                                                        |
| `VIDEO_PROVIDER` / `VIDEO_MODEL`              | `fal` \| `local`; fal endpoint id                                          | only for scenes with `motion: "ai"`; `local` needs `npm run wan:setup` |
| `VIDEO_LOCAL_SECONDS` / `VIDEO_LOCAL_STEPS`   | `3.4`, `30`                                                                | local clip length and diffusion steps                                  |
| `TTS_PROVIDER`                                | `kokoro` \| `piper` \| `vits-bd` \| `mms` \| `elevenlabs` \| `placeholder` | first four local and free                                              |
| `KOKORO_VOICE`                                | `af_sarah`, or blends like `af_sarah:60,am_adam:40`                        | `kokoro-tts --help-voices`                                             |
| `KOKORO_LANG`                                 | `en-us`                                                                    | `kokoro-tts --help-languages`                                          |
| `KOKORO_BIN` / `KOKORO_MODEL_DIR`             |                                                                            | needed if the CLI is off-PATH (it is, in a venv)                       |
| `PIPER_SPEAKER`                               | `0`–`15`                                                                   | bn_BD voice; audition in the UI                                        |
| `MMS_LANG` / `MMS_PYTHON`                     | `ben`, `hin`, `urd`, `eng`…                                                | blank python uses `.venv/bin/python`                                   |
| `VITS_BD_PAUSE` / `VITS_BD_BREATH`            | silence after a sentence (`0.35`) and after a comma / dash (`0.18`)        | vits-bd runs everything together otherwise                             |
| `GEMINI_API_KEY`                              |                                                                            | from AI Studio                                                         |
| `GEMINI_TTS_MODEL` / `GEMINI_VOICE`           | `gemini-2.5-flash-preview-tts`; `Kore`, `Charon`, `Sulafat`…               | flash previews are free; `GEMINI_TTS_STYLE` steers delivery            |
| `YOUTUBE_CLIENT_ID` / `YOUTUBE_CLIENT_SECRET` | Google OAuth web client                                                    | publishing; see _Publishing_                                           |
| `META_APP_ID` / `META_APP_SECRET`             | Meta app with Facebook Login                                               | publishing to a Page + Instagram                                       |
| `ELEVENLABS_API_KEY`                          |                                                                            |                                                                        |
| `ELEVENLABS_MODEL`                            | `eleven_v3` for Bangla; `eleven_multilingual_v2` otherwise                 |                                                                        |
| `ELEVENLABS_VOICE_ID`                         | must be a **premade** voice on free plans                                  |                                                                        |
| `WORD_TIMING`                                 | `off` \| `local` \| `openai`                                               | `local` needs whisper installed                                        |
| `FONT_FILE` / `CAPTION_FONT`                  |                                                                            | file path and family name; needed for non-Latin scripts                |
| `MUSIC_DIR`                                   | default `music`                                                            |                                                                        |
| `UI_PORT`                                     | default `5180`                                                             |                                                                        |

Inline comments are stripped, so `KEY=value   # note` works. Quote a value to keep a
literal `#`, e.g. `PRIMARY="#FFD166"`.

### Local images with mflux — optional, try later

Not installed by default. Adds fully local, unlimited generation on Apple Silicon:

```bash
npm run mflux:setup      # dedicated venv + a 4-bit model, ~6.8 GB
npm run mflux:remove     # deletes exactly that, nothing else
```

Everything lives inside the project — `.venv-mflux/` and `.mflux/` with `HF_HOME` pinned
there — so removal is exact and cannot touch kokoro, MMS or the Bangla voices.

**How it compared to Cloudflare SDXL** (same prompts, same seed, this machine):

|                              | mflux (Z-Image-Turbo)       | SDXL (Cloudflare)      |
| ---------------------------- | --------------------------- | ---------------------- |
| Photorealism, fine detail    | better                      | softer, more painterly |
| Cinematic mood, colour       | flatter                     | better                 |
| Hitting every prompt element | missed some at 4 steps      | reliable               |
| Speed                        | 60 s at 4 steps, 120 s at 8 | 12 s                   |

Neither dominates. SDXL's colour and drama suit reels seen for four seconds on a phone;
mflux wins on close-ups and texture, and needs `MFLUX_STEPS=8` to show its best. It was
removed to reclaim disk after that comparison — the wiring stays, so it is one command
to bring back when there is space or a need for offline rendering.

Default model is **Z-Image-Turbo 4-bit** (5.9 GB, Apache-2.0). `MFLUX_MODEL` switches
to `dhairyashil/FLUX.1-schnell-mflux-4bit` (9.6 GB). Both licences permit commercial use.

### Cloudflare model note

|                                            | size control         | negative prompt | response    |
| ------------------------------------------ | -------------------- | --------------- | ----------- |
| `stable-diffusion-xl-base-1.0` _(default)_ | yes, 256–2048        | yes             | raw PNG     |
| `flux-1-schnell`                           | **no** — square only | **no**          | JSON base64 |

SDXL is the default because this pipeline is vertical and projects carry `image.negative`.
Asking SDXL for a raw 1080×1920 produces stretched, duplicated subjects, so requests snap
to its native bucket — 768×1344 for 9:16, 1024×1024 for 1:1 — then ffmpeg scales up.

---

## How the timing works

`align` measures the real length of each narration file and writes `timeline.json`.
Everything downstream reads that file, so scenes, captions and music cannot drift. Change a
line of narration, re-run `generate:tts → render:voice → align`, and the rest re-times
itself.

`master` trims or clone-pads each clip to its timeline duration, so a mismatch between a
rendered clip and its narration is corrected locally rather than shifting the whole reel.

`render:voice` trims silence off the head of each take and records how much in
`05-voice/<id>.trim.json`, so TTS-based word timings stay in sync. Whisper timings are
measured on the trimmed file and used as-is.

---

## Troubleshooting

Run `npm run doctor` first — it prints exactly which piece is missing.

**`Unknown filter 'ass'` or `'drawtext'`.** Your ffmpeg lacks libass/freetype. On macOS
install `ffmpeg-full` and put it on PATH (see Requirements).

**Captions render in the wrong font.** libass resolves fonts by _family name_, not path.
Set `captions.fontName`, or `CAPTION_FONT` in `.env`.

**Bangla captions show dotted circles.** Letter spacing is breaking glyph clusters. This is
handled automatically now; if you set `Spacing` by hand, set it back to 0.

**ElevenLabs `402 payment_required`.** The voice is a library voice, which free accounts
cannot use via the API. Pick a premade voice. If it persists, `voice.voiceId` in the
project file is overriding your choice — remove it.

**kokoro crashed but the audio is fine.** kokoro intermittently dies in native teardown
_after_ writing a complete wav. The provider judges the run by its output, not its exit
code, and warns instead of failing. Don't "fix" that back.

**Paths with spaces.** Supported — arguments never go through a shell, and filter-graph
paths are escaped. Don't add your own quotes.

Failures print the last lines of ffmpeg's own stderr plus the exact command, so you can
paste it into a terminal and debug directly.

---

## Adding a provider

One function in `src/providers/images.ts` or `src/providers/tts.ts`. The contract is just
"write a PNG here" / "write an MP3 here" — nothing else in the pipeline changes.

## Ideas to extend

Roughly in order of value-per-effort. Each is a provider swap or one new step — the
`timeline.json` contract means nothing downstream needs rewriting.

### Better output

- **Local image generation** — wired and tested (`IMAGE_PROVIDER=mflux`), currently
  removed for disk. `npm run mflux:setup` brings it back; see the section above for how it
  compared.
- **Per-platform loudness** — each service normalises differently. A target per platform
  (rather than one -16 LUFS for all) avoids their processing squashing the mix.
- **local video genration** — is there anything for Windows OS system. I have i5 8th gen cpu, RX580 2048SP graphics card. and 32gb ram. I want to run this pipeline in windows system too.

### Faster iteration

- **Script generation** — a `write.ts` step that turns a topic into a project file. See
  the warning below.

### Reach

- **Multi-language from one project** — the visuals, timeline and motion are language
  independent. Swapping only `narration` would produce a Bangla and an English cut of the
  same reel from one source file, roughly doubling reach for the cost of a second TTS run.
- **Subtitle sidecar export** — write `.srt` alongside the burned-in captions. Some
  platforms rank on uploaded captions, and it helps accessibility.

### For sourced content

- **Citation checking** — a step that validates each `scenes[].source` against a reference
  index before the reel renders, failing loudly on anything unrecognised. If you publish
  under a promise that every narration is sourced, this is the guard rail that keeps it.
- ⚠️ **On LLM script generation** — a language model will invent hadith citations that look
  entirely real: right shape, plausible collection, wrong or non-existent. If you add
  `write.ts`, let the model write _scenes and phrasing_ from source text you supply, and
  copy the `source` field verbatim from your input. Never let it generate a citation.

Not a production system — a harness meant to be taken apart.
