/**
 * Step 9 — Final Video
 * timeline + textured clips + voice + music + captions -> out/final.mp4
 */
import fs from "node:fs";
import path from "node:path";
import { CAPTIONS, DIRS, FINAL, HOOK, MUSIC_BED, OUT, PLAT, TIMELINE, loadEnv, loadProject } from "../src/config";
import type { Timeline } from "../src/types";
import { buildBrand } from "../src/brand";
import { cardExtra, ensureDir, exists, ffmpeg, log, probeDuration, readJson, warn } from "../src/util";

function buildClips(timeline: Timeline): string[] {
  const clips: string[] = [];
  // The first/last clips carry the intro/outro card time on top of their entry.
  for (const [i, entry] of timeline.entries.entries()) {
    const seconds = entry.duration + cardExtra(timeline, i);
    const src = path.join(DIRS.texture, `${entry.id}.mp4`);
    const fallback = path.join(DIRS.motion, `${entry.id}.mp4`);
    const input = fs.existsSync(src) ? src : fallback;
    if (!fs.existsSync(input)) throw new Error(`No clip for scene ${entry.id} — run render:motion / render:texture`);

    const dest = path.join(DIRS.tmp, `clip-${entry.id}.mp4`);
    ffmpeg([
      "-i", input,
      "-vf", `tpad=stop_mode=clone:stop_duration=10,trim=0:${seconds},setpts=PTS-STARTPTS,fps=${timeline.fps}`,
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", dest,
    ], `clip-${entry.id}`);
    clips.push(dest);
  }
  return clips;
}

function buildVideo(clips: string[]): string {
  const list = path.join(DIRS.tmp, "concat.txt");
  fs.writeFileSync(list, clips.map((c) => `file '${c}'`).join("\n"));
  const dest = path.join(DIRS.tmp, "video.mp4");
  ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", dest], "concat");
  return dest;
}

function buildVoiceTrack(timeline: Timeline): string {
  const dest = path.join(DIRS.tmp, "voice.wav");
  const withVoice = timeline.entries.filter((e) => e.voiceFile && fs.existsSync(e.voiceFile));
  if (!withVoice.length) {
    ffmpeg(["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-t", timeline.total.toFixed(3), dest], "voice-silence");
    return dest;
  }
  const inputs = withVoice.flatMap((e) => ["-i", e.voiceFile!]);
  const parts = withVoice.map((e, i) =>
    `[${i}:a]aformat=channel_layouts=stereo:sample_rates=48000,adelay=${Math.round(e.start * 1000)}|${Math.round(e.start * 1000)}[v${i}]`
  );
  const mix = withVoice.map((_, i) => `[v${i}]`).join("");
  ffmpeg([
    ...inputs, "-filter_complex",
    `${parts.join(";")};${mix}amix=inputs=${withVoice.length}:normalize=0:dropout_transition=0,apad[a]`,
    "-map", "[a]", "-t", timeline.total.toFixed(3), dest,
  ], "voice-track");
  return dest;
}

function buildMix(voice: string, timeline: Timeline): string {
  if (!exists(MUSIC_BED)) { warn("master", "no music bed — using the voice track alone"); return voice; }
  const dest = path.join(DIRS.tmp, "audio.wav");
  ffmpeg([
    "-i", voice, "-i", MUSIC_BED, "-filter_complex",
    "[0:a]aformat=channel_layouts=stereo:sample_rates=48000,asplit=2[vo][sc];" +
    "[1:a]aformat=channel_layouts=stereo:sample_rates=48000[mu];" +
    "[mu][sc]sidechaincompress=threshold=0.04:ratio=8:attack=15:release=350[duck];" +
    "[vo][duck]amix=inputs=2:normalize=0:dropout_transition=0,alimiter=limit=0.95,aresample=48000[a]",
    "-map", "[a]", "-t", timeline.total.toFixed(3), dest,
  ], "mix");
  return dest;
}

/**
 * A second name for the video: the real title, as a hard link beside final.mp4 —
 * same bytes, no extra disk — so the folder reads "সদকা সম্পদ কমায় না.mp4" in
 * Finder. final.mp4 stays the name everything else looks for; hook and platform
 * cuts get the variant in brackets, "Title (IG).mp4".
 *
 * Which name each cut wrote last is recorded in .titled.json, so a retitled reel
 * cleans up its own old name and never touches another cut's file. Anything not
 * in that record is left alone — it is not ours to delete.
 */
function titledCopy(title: string): void {
  const safe = title.replace(/[\\/:*?"<>|\x00-\x1f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  if (!safe) return;
  const variant = [HOOK, PLAT].filter(Boolean).join("-");
  const key = variant || "main";
  const record = path.join(OUT, ".titled.json");
  let wrote: Record<string, string> = {};
  try { wrote = JSON.parse(fs.readFileSync(record, "utf8")); } catch {}

  const previous = wrote[key];
  if (previous && previous !== `${safe}.mp4`) fs.rmSync(path.join(OUT, previous), { force: true });

  const name = `${safe}${variant ? ` (${variant.toUpperCase()})` : ""}.mp4`;
  const dest = path.join(OUT, name);
  fs.rmSync(dest, { force: true });
  try {
    fs.linkSync(FINAL, dest);
  } catch {
    // a volume without hard links (exFAT) — copy instead
    try { fs.copyFileSync(FINAL, dest); } catch (e: any) { warn("master", `could not write ${name}: ${e.message}`); return; }
  }
  wrote[key] = name;
  fs.writeFileSync(record, JSON.stringify(wrote, null, 2));
  log("master", `also as ${name}`);
}

function main() {
  loadEnv();
  const project = loadProject();
  if (!exists(TIMELINE)) throw new Error("timeline.json not found — run `npm run align` first");
  const timeline = readJson<Timeline>(TIMELINE);
  ensureDir(DIRS.tmp);

  log("master", `building ${timeline.entries.length} clips`);
  const video = buildVideo(buildClips(timeline));
  const audio = buildMix(buildVoiceTrack(timeline), timeline);

  const captions = exists(CAPTIONS) ? `ass=${CAPTIONS}` : "null";
  if (captions === "null") warn("master", "no captions.ass — rendering without captions");
  const brand = buildBrand(project, { width: timeline.width, height: timeline.height, logoInput: 2 });
  if (brand) log("master", `watermark: ${brand.label} (${project.brand?.position ?? "top-right"})`);

  // Captions first, watermark on top of them — the logo must never be covered.
  const graph = `[0:v]${captions}[base];${brand ? brand.filter : "[base]null"}[v]`;

  ffmpeg([
    "-i", video, "-i", audio, ...(brand?.inputs ?? []),
    "-filter_complex", graph,
    "-map", "[v]", "-map", "1:a:0",
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-level", "4.0", "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    "-shortest", FINAL,
  ], "master");

  const size = (fs.statSync(FINAL).size / 1024 / 1024).toFixed(1);
  log("master", `${FINAL} — ${probeDuration(FINAL).toFixed(2)}s, ${timeline.width}x${timeline.height}, ${size} MB`);
  titledCopy(project.title);
}

main();
