/**
 * Step 6 — Timing & Sync
 * Measures the real narration length of every scene and writes out/timeline.json,
 * the single source of truth for captions, music and the final master.
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, FPS, TIMELINE, cardsFor, dims, loadEnv, loadProject } from "../src/config";
import type { Timeline, TimelineEntry } from "../src/types";
import { estimateSeconds, log, probeDuration, writeJson } from "../src/util";

function main() {
  loadEnv();
  const project = loadProject();
  const { width, height } = dims(project);
  const gap = project.gap ?? 0.35;
  const entries: TimelineEntry[] = [];
  const cards = cardsFor(project);
  const intro = cards.intro.seconds, outro = cards.outro.seconds;
  let cursor = intro;

  project.scenes.forEach((scene, index) => {
    const voiceFile = path.join(DIRS.voice, `${scene.id}.wav`);
    const ttsFile = path.join(DIRS.tts, `${scene.id}.mp3`);
    const file = fs.existsSync(voiceFile) ? voiceFile : fs.existsSync(ttsFile) ? ttsFile : null;

    const voiceDuration = file ? probeDuration(file) : estimateSeconds(scene.narration);
    const duration = Math.max(scene.seconds ?? 0, voiceDuration + gap, 2);

    entries.push({
      id: scene.id, index, start: Number(cursor.toFixed(3)),
      duration: Number(duration.toFixed(3)),
      voiceDuration: Number(voiceDuration.toFixed(3)),
      narration: scene.narration,
      voiceFile: file,
    });
    cursor += duration;
  });

  cursor += outro;
  const timeline: Timeline = { total: Number(cursor.toFixed(3)), intro, outro, fps: FPS(project), width, height, entries };
  writeJson(TIMELINE, timeline);
  if (intro) log("align", `intro card ${intro.toFixed(2)}s`);
  entries.forEach((e) => log("align", `${e.id}  ${e.start.toFixed(2)}s → ${(e.start + e.duration).toFixed(2)}s`));
  if (outro) log("align", `outro card ${outro.toFixed(2)}s`);
  log("align", `total ${timeline.total.toFixed(2)}s → ${TIMELINE}`);
}

main();
