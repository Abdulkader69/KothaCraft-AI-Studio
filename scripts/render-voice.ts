/**
 * Step 5 — Voice cleanup: trim leading/trailing silence + loudness normalise
 * out/04-tts/<id>.mp3 -> out/05-voice/<id>.wav (48k mono, -16 LUFS)
 * Also records how much silence was cut, so TTS word timings stay in sync.
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, hasFlag, loadEnv, loadProject } from "../src/config";
import { ensureDir, ffmpeg, leadingSilence, log, probeDuration, upToDate, warn, writeJson } from "../src/util";

const TRIM = [
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08",
  "areverse",
  "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.08",
  "areverse",
].join(",");

function main() {
  loadEnv();
  const project = loadProject();
  const force = hasFlag("force");
  ensureDir(DIRS.voice);

  for (const scene of project.scenes) {
    const src = path.join(DIRS.tts, `${scene.id}.mp3`);
    const dest = path.join(DIRS.voice, `${scene.id}.wav`);
    if (!fs.existsSync(src)) { warn("voice", `missing tts for ${scene.id}`); continue; }
    if (upToDate(dest, src, force)) { log("voice", `${scene.id} cached`); continue; }

    ffmpeg(["-i", src, "-af", `${TRIM},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000`, "-ac", "1", dest], `voice-${scene.id}`);

    let lead = leadingSilence(src);
    // A fully silent placeholder track gets erased by silenceremove — keep its length.
    if (probeDuration(dest) < 0.15) {
      ffmpeg(["-i", src, "-af", "aresample=48000", "-ac", "1", dest], `voice-${scene.id}-raw`);
      lead = 0;
      warn("voice", `${scene.id} is silent (placeholder TTS) — kept untouched`);
    }
    writeJson(path.join(DIRS.voice, `${scene.id}.trim.json`), { lead: Number(lead.toFixed(3)) });
    log("voice", `${scene.id} ${probeDuration(dest).toFixed(2)}s (trimmed ${lead.toFixed(2)}s off the head)`);
  }
}

main();
