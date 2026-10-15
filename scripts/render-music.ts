/**
 * Step 8 — Background Music
 * Prepares a bed that exactly matches the timeline: looped, gained, faded.
 * With no music file it synthesises a soft pad so the mix/duck path still runs.
 */
import fs from "node:fs";
import path from "node:path";
import { MUSIC_BED, MUSIC_DIR, ROOT, TIMELINE, hasFlag, loadEnv, loadProject } from "../src/config";
import type { Timeline } from "../src/types";
import { ensureDir, exists, ffmpeg, log, probeDuration, readJson, skippable, warn } from "../src/util";

const AUDIO = /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i;
/** The voice is normalised to -16 LUFS in render-voice; match it, then offset. */
const MUSIC_REF = -16;

/**
 * An explicit `music.file` wins. Otherwise fall back to the shared `music/`
 * library, choosing by a hash of the title so the same reel keeps the same
 * track across re-renders instead of shuffling every time.
 */
function pickTrack(explicit: string | undefined, title: string): string | null {
  if (explicit) {
    const p = path.isAbsolute(explicit) ? explicit : path.join(ROOT, explicit);
    if (fs.existsSync(p)) return p;
    warn("music", `music.file not found: ${explicit} — falling back to the library`);
  }
  if (!fs.existsSync(MUSIC_DIR)) return null;
  const tracks = fs.readdirSync(MUSIC_DIR).filter((f) => AUDIO.test(f)).sort();
  if (!tracks.length) return null;
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) >>> 0;
  const chosen = tracks[h % tracks.length];
  log("music", `no music.file — picked ${chosen} from ${path.basename(MUSIC_DIR)}/`);
  return path.join(MUSIC_DIR, chosen);
}

function main() {
  loadEnv();
  const project = loadProject();
  if (!exists(TIMELINE)) throw new Error("timeline.json not found — run `npm run align` first");
  const timeline = readJson<Timeline>(TIMELINE);
  const total = timeline.total;
  const gain = project.music?.gainDb ?? -18;
  const force = hasFlag("force");
  ensureDir(path.dirname(MUSIC_BED));
  // A bed is only reusable while it still spans the timeline — a re-rolled scene
  // or an added intro/outro changes `total`, and a short bed drops out mid-reel.
  if (skippable(MUSIC_BED, force) && Math.abs(probeDuration(MUSIC_BED) - total) < 0.25) { log("music", "cached"); return; }

  const file = pickTrack(project.music?.file, project.title ?? "");
  const fade = Math.min(1.5, total / 6);

  if (file && fs.existsSync(file)) {
    // Normalise to the same reference the voice uses before applying gainDb, so
    // the bed sits at a predictable level whatever the track's own mastering is.
    // Without this a quiet source disappears and a loud one drowns the narration.
    ffmpeg([
      "-stream_loop", "-1", "-i", file, "-t", total.toFixed(3),
      "-af", `loudnorm=I=${MUSIC_REF}:TP=-2:LRA=11,volume=${gain}dB,` +
        `afade=t=in:st=0:d=${fade},afade=t=out:st=${(total - fade).toFixed(3)}:d=${fade},aresample=48000`,
      "-ac", "2", MUSIC_BED,
    ], "music-bed");
    log("music", `${path.basename(file)} → ${total.toFixed(2)}s bed at ${MUSIC_REF + gain} LUFS (${gain}dB under voice)`);
    return;
  }

  warn("music", "no music.file set — synthesising a placeholder pad");
  const chord = ["110", "164.81", "220", "329.63"];
  const inputs = chord.flatMap((f) => ["-f", "lavfi", "-i", `sine=frequency=${f}:duration=${total.toFixed(3)}:sample_rate=48000`]);
  const mix = chord.map((_, i) => `[${i}:a]`).join("");
  ffmpeg([
    ...inputs,
    "-filter_complex",
    `${mix}amix=inputs=${chord.length}:normalize=1,tremolo=f=0.4:d=0.35,lowpass=f=900,volume=${gain}dB,` +
      `afade=t=in:st=0:d=${fade},afade=t=out:st=${(total - fade).toFixed(3)}:d=${fade},aformat=channel_layouts=stereo[a]`,
    "-map", "[a]", "-t", total.toFixed(3), MUSIC_BED,
  ], "music-synth");
  log("music", `synth pad → ${total.toFixed(2)}s bed at ${gain}dB`);
}

main();
