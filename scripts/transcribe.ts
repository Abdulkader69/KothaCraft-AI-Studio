/**
 * Optional step — word-level timings by transcribing the cleaned voice track.
 * out/05-voice/<id>.wav -> out/06-words/<id>.json
 *
 * Only needed when the TTS provider does not return alignment data.
 * ElevenLabs already writes this file during `generate:tts`.
 *
 *   WORD_TIMING=openai   OpenAI whisper-1 with word granularity (needs OPENAI_API_KEY)
 *   WORD_TIMING=local    local CLI, e.g. WHISPER_CMD="whisper --model base"
 *   WORD_TIMING=off      skip (captions fall back to length-weighted estimates)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DIRS, env, hasFlag, loadEnv, loadProject } from "../src/config";
import type { WordFile } from "../src/words";
import { wordsFromWhisper } from "../src/words";
import { ensureDir, log, readJson, upToDate, warn, writeJson } from "../src/util";

async function openaiWhisper(file: string): Promise<any> {
  const key = env("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY missing in .env");
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(file)]), path.basename(file));
  form.append("model", env("WHISPER_MODEL", "whisper-1"));
  form.append("response_format", "verbose_json");
  form.append("timestamp_granularities[]", "word");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST", headers: { Authorization: `Bearer ${key}` }, body: form,
  });
  if (!res.ok) throw new Error(`whisper ${res.status}: ${await res.text()}`);
  return res.json();
}

function localWhisper(file: string): any {
  const cmd = env("WHISPER_CMD", "whisper --model base").split(/\s+/);
  const outDir = path.join(DIRS.tmp, "whisper");
  ensureDir(outDir);
  execFileSync(cmd[0], [...cmd.slice(1), file, "--word_timestamps", "True", "--output_format", "json", "--output_dir", outDir], { stdio: "inherit" });
  const json = path.join(outDir, `${path.basename(file, path.extname(file))}.json`);
  return readJson<any>(json);
}

async function main() {
  loadEnv();
  const project = loadProject();
  const mode = env("WORD_TIMING", "off");
  if (project.captions?.show === false) { log("transcribe", "captions hidden — skipping word timing"); return; }
  if (mode === "off") { warn("transcribe", "WORD_TIMING=off — using estimated word timings"); return; }
  const force = hasFlag("force");
  ensureDir(DIRS.words);

  for (const scene of project.scenes) {
    const src = path.join(DIRS.voice, `${scene.id}.wav`);
    const dest = path.join(DIRS.words, `${scene.id}.json`);
    if (!fs.existsSync(src)) { warn("transcribe", `missing voice for ${scene.id}`); continue; }
    if (upToDate(dest, src, force)) { log("transcribe", `${scene.id} cached`); continue; }

    const json = mode === "local" ? localWhisper(src) : await openaiWhisper(src);
    const file: WordFile = { basis: "voice", words: wordsFromWhisper(json) };
    writeJson(dest, file);
    log("transcribe", `${scene.id} ${file.words.length} words`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
