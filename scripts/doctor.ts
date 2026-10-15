/**
 * Preflight check — run this first when something fails on a new machine.
 *   npm run doctor
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import { loadEnv, env } from "../src/config";
import { mfluxInstalled, MFLUX_STORE } from "../src/providers/images";
import { kokoroMissingModels, kokoroModelDir, piperInstalled, vitsBdInstalled } from "../src/providers/tts";
import { defaultFontName, findFont, hasFilter } from "../src/util";

const ok = (m: string) => console.log(`\x1b[32m  ok\x1b[0m  ${m}`);
const bad = (m: string, fix: string) => console.log(`\x1b[31m fail\x1b[0m  ${m}\n        → ${fix}`);

function version(bin: string): string | null {
  try {
    return execFileSync(bin, ["-version"], { stdio: ["ignore", "pipe", "ignore"] }).toString().split("\n")[0];
  } catch {
    return null;
  }
}

loadEnv();
console.log(`\nfaceless-pipeline doctor — ${os.platform()} ${os.arch()}, node ${process.version}\n`);

const ff = version("ffmpeg");
ff ? ok(ff.slice(0, 60)) : bad("ffmpeg not found", os.platform() === "darwin" ? "brew install ffmpeg" : "install ffmpeg from your package manager");
version("ffprobe") ? ok("ffprobe found") : bad("ffprobe not found", "it ships with ffmpeg — check your PATH");

for (const filter of ["drawtext", "gradients", "zoompan", "ass", "sidechaincompress", "loudnorm", "silenceremove"]) {
  hasFilter(filter)
    ? ok(`filter ${filter}`)
    : bad(`filter ${filter} missing`, filter === "ass" || filter === "drawtext"
        ? "your ffmpeg build lacks libass/freetype — on macOS use `brew install ffmpeg` (the full build)"
        : "upgrade ffmpeg to 5.0 or newer");
}

const font = findFont();
font ? ok(`font file ${font}`) : bad("no font file found", "set FONT_FILE=/path/to/font.ttf in .env");
ok(`caption font family "${defaultFontName()}" (override with CAPTION_FONT)`);

const tts = env("TTS_PROVIDER", "kokoro");
ok(`IMAGE_PROVIDER=${env("IMAGE_PROVIDER", "placeholder")}  TTS_PROVIDER=${tts}  WORD_TIMING=${env("WORD_TIMING", "off")}`);

const img = env("IMAGE_PROVIDER", "pollinations");
if (img === "mflux") {
  mfluxInstalled()
    ? ok(`mflux installed (${MFLUX_STORE.replace(process.cwd() + "/", "")}/)`)
    : bad("mflux not installed", "npm run mflux:setup   (Apple Silicon only, ~6 GB)");
}


if (tts === "piper") {
  piperInstalled() ? ok("piper installed (.piper/, bn_BD, 16 speakers)") : bad("piper not installed", "npm run piper:setup   (~150 MB)");
}
if (tts === "vits-bd") {
  vitsBdInstalled() ? ok("vits-bd installed (.vits-bd/)") : bad("vits-bd not installed", "npm run vits-bd:setup   (~1.6 GB)");
}
if (tts === "mms") {
  console.log("\x1b[33m note\x1b[0m  MMS is CC-BY-NC-4.0 — not licensed for commercial use. piper / vits-bd are.");
}

if (tts === "kokoro") {
  const bin = env("KOKORO_BIN", "kokoro-tts");
  try {
    execFileSync(bin, ["--help"], { stdio: "ignore" });
    ok(`${bin} found`);
  } catch {
    bad(`${bin} not found`, "pip install kokoro-tts   (or: uv tool install kokoro-tts)");
  }
  const missing = kokoroMissingModels();
  missing.length
    ? bad(`kokoro model files missing: ${missing.join(", ")}`, `npm run kokoro:setup   (downloads them into ${kokoroModelDir()})`)
    : ok(`kokoro model files in ${kokoroModelDir()}`);
  if (env("WORD_TIMING", "off") === "off") {
    console.log(`\x1b[33m note\x1b[0m  kokoro has no word timings — WORD_TIMING=local gives word-accurate captions`);
  }
}
if (env("IMAGE_PROVIDER") === "fal" && !env("FAL_KEY")) bad("FAL_KEY empty", "add it to .env");
if (env("TTS_PROVIDER") === "elevenlabs" && !env("ELEVENLABS_API_KEY")) bad("ELEVENLABS_API_KEY empty", "add it to .env");
if (env("WORD_TIMING") === "openai" && !env("OPENAI_API_KEY")) bad("OPENAI_API_KEY empty", "add it to .env");

console.log("");
