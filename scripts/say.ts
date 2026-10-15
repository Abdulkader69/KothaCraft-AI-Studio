/**
 * Audition spellings — hear a word (or a line) several ways through the voice
 * you actually render with, so you can pick the spelling that sounds right and
 * put it in content/pronounce.json.
 *
 *   npm run say -- সৌভাগ্য সৌভাগ্গো শৌভাগ্গো      three spellings, one after another
 *   npm run say -- "সে জানত।" "সে জানতো।"         whole lines work too
 *   npm run say -- সৌভাগ্য --voice bn-BD-NabanitaNeural
 *   npm run say -- সৌভাগ্য --in "এই সৌভাগ্য কেবল মুমিনেরই।"   hear it in a sentence
 *
 * Writes out/tts-compare/say-<n>-<spelling>.mp3 plus say-all.mp3 (every take in
 * order, with a gap between). The dictionary is NOT applied — you are testing
 * raw spellings — but the current mapping is printed so you can see it.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, env, loadEnv } from "../src/config";
import { spoken } from "../src/pronounce";
import { synthesize } from "../src/providers/tts";
import { ensureDir, ffmpeg, log, probeDuration, warn } from "../src/util";

const OUT = path.join(ROOT, "out", "tts-compare");

/** A filename-safe, short tag for a spelling. */
const tag = (s: string) => s.replace(/[\\/:*?"<>|\x00-\x1f]+/g, "").replace(/\s+/g, "_").slice(0, 40) || "take";

function args() {
  const argv = process.argv.slice(2);
  const words: string[] = [];
  let voice = "", inSentence = "";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--voice") { voice = argv[++i] ?? ""; continue; }
    if (argv[i] === "--in") { inSentence = argv[++i] ?? ""; continue; }
    if (argv[i].startsWith("--")) continue;
    words.push(argv[i]);
  }
  return { words, voice, inSentence };
}

async function main() {
  loadEnv();
  const { words, voice, inSentence } = args();
  if (!words.length) {
    console.error(`usage: npm run say -- <spelling> [more spellings…] [--voice <name>] [--in "sentence with WORD"]

  npm run say -- সৌভাগ্য সৌভাগ্গো শৌভাগ্গো
  npm run say -- সৌভাগ্য --in "এই সৌভাগ্য কেবল মুমিনেরই।"`);
    process.exit(1);
  }
  if (voice) {
    process.env.EDGE_VOICE = voice;
    process.env.GEMINI_VOICE = voice;
  }
  const provider = env("TTS_PROVIDER", "kokoro");
  log("say", `${words.length} spelling(s) through ${provider}${provider === "edge" ? ` / ${env("EDGE_VOICE", "bn-BD-NabanitaNeural")}` : ""}`);

  ensureDir(OUT);
  const takes: string[] = [];
  for (const [i, word] of words.entries()) {
    // --in puts each spelling into the same sentence, so you judge it in context:
    // the first spelling is the one replaced in that sentence.
    const text = inSentence ? inSentence.replace(words[0], word) : word;
    const dest = path.join(OUT, `say-${String(i + 1).padStart(2, "0")}-${tag(word)}.mp3`);
    fs.rmSync(dest, { force: true });
    await synthesize({ text, id: `say-${i + 1}`, dest });
    const dict = spoken(word);
    log("say", `${i + 1}. ${word}${dict !== word ? `   (dictionary currently says → ${dict})` : ""}   ${path.basename(dest)}  ${probeDuration(dest).toFixed(1)}s`);
    takes.push(dest);
  }

  if (takes.length > 1) {
    // one file, each take separated by silence — easiest way to hear the difference
    const all = path.join(OUT, "say-all.mp3");
    const inputs = takes.flatMap((t) => ["-i", t]);
    const parts = takes.map((_, i) => `[${i}:a]aformat=sample_rates=24000:channel_layouts=mono,apad=pad_dur=0.7[a${i}]`);
    ffmpeg([...inputs, "-filter_complex",
      `${parts.join(";")};${takes.map((_, i) => `[a${i}]`).join("")}concat=n=${takes.length}:v=0:a=1[out]`,
      "-map", "[out]", "-c:a", "libmp3lame", "-q:a", "2", all], "say-all");
    log("say", `all takes in order → ${path.relative(ROOT, all)}`);
  }
  log("say", `keep the winner: add "${words[0]}": "<the spelling that sounded right>" to content/pronounce.json`);
}

main().catch((e) => { warn("say", e.message); process.exit(1); });
