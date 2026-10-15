/**
 * Step 2 — Image to Video
 * out/01-images/<id>.png -> out/02-motion/<id>.mp4
 *
 * Default: ken-burns pan/zoom via ffmpeg zoompan — free, instant, exact length.
 * motion "ai": a generated clip (see src/providers/video.ts) cached raw as
 * <id>.ai.mp4, then fitted to the scene length — trimmed, slowed a little, or
 * ping-ponged — so re-fitting after a timeline change never re-pays.
 *
 * Stock footage (see pick-stock): the chosen stretch of the clip is cut out at
 * frame size as <id>.src.mp4, fitted the same way, and given a slow push-in
 * and a short fade at each end so the cuts feel placed rather than chopped.
 *
 * If out/timeline.json already exists, its durations win, so you can re-run this
 * after `align` to get frame-exact clips.
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, FPS, TIMELINE, dims, hasFlag, loadEnv, loadProject } from "../src/config";
import { generateClip } from "../src/providers/video";
import { type Pick, readPicks, resolveClip, usesStock } from "../src/stock";
import type { Cinematic, PanDirection, Project, Timeline } from "../src/types";
import { cardExtra, ensureDir, estimateSeconds, ffmpeg, log, probeDuration, readJson, skippableClip, warn } from "../src/util";

const isCinematic = (m: unknown): m is Cinematic => m === "cinematic" || m === "cinematic-out";

/**
 * The cinematic move, as zoompan expressions: progress `p` runs through a
 * smoothstep, so the camera starts still, gathers pace and settles — a dolly
 * rather than a zoom — while the window slides toward a corner. `index` picks
 * the corner, alternating so back-to-back scenes never drift the same way.
 */
function cinematicMove(kind: Cinematic, frameVar: string, frames: number, zoom: number, index: number, offset = 0, totalFrames = frames): { z: string; x: string; y: string } {
  const p = `((${offset}+${frameVar})/${Math.max(totalFrames - 1, 1)})`;
  const e = `(${p}*${p}*(3-2*${p}))`;                    // smoothstep
  const t = kind === "cinematic" ? e : `(1-${e})`;       // pull-out plays it backwards
  const dx = [0.55, -0.55, 0.55, -0.55][index % 4];       // toward a corner…
  const dy = [-0.4, -0.4, 0.4, 0.4][index % 4];           // …a different one each scene
  return {
    z: `'1+${zoom}*${t}'`,
    x: `'(iw-iw/zoom)/2*(1+${dx}*${t})'`,
    y: `'(ih-ih/zoom)/2*(1+${dy}*${t})'`,
  };
}

function motionFilter(kind: PanDirection | Cinematic, frames: number, w: number, h: number, fps: number, index: number): string {
  const centerX = "iw/2-(iw/zoom/2)";
  const centerY = "ih/2-(ih/zoom/2)";
  let z = `'min(1+0.0012*on,1.18)'`, x = `'${centerX}'`, y = `'${centerY}'`;
  if (kind === "out") z = `'max(1.18-0.0012*on,1.0)'`;
  if (kind === "left" || kind === "right") {
    z = `'1.14'`;
    const p = `(on/${Math.max(frames - 1, 1)})`;
    x = kind === "left" ? `'(iw-iw/zoom)*${p}'` : `'(iw-iw/zoom)*(1-${p})'`;
  }
  if (isCinematic(kind)) ({ z, x, y } = cinematicMove(kind, "on", frames, 0.16, index));
  return [
    `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase`,
    `crop=${w * 2}:${h * 2}`,
    `zoompan=z=${z}:x=${x}:y=${y}:d=${frames}:s=${w}x${h}:fps=${fps}`,
    "setsar=1",
  ].join(",");
}

/**
 * Stretch a generated clip of `have` seconds to `need`:
 *  - need ≤ have          trim
 *  - need ≤ 1.6 × have    slow down with frame interpolation (ambient motion hides it)
 *  - otherwise            ping-pong (forward, back, forward …) and trim
 */
function fitFilter(have: number, need: number, w: number, h: number, fps: number): { inputs: string[]; vf: string } {
  const finish = `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},setsar=1,fps=${fps}`;
  if (need <= have + 0.05) return { inputs: [], vf: `trim=0:${need},setpts=PTS-STARTPTS,${finish}` };
  if (need <= have * 1.6) {
    const k = (need / have).toFixed(4);
    return { inputs: [], vf: `setpts=${k}*PTS,minterpolate=fps=${fps}:mi_mode=mci:mc_mode=aobmc:vsbmc=1,trim=0:${need},setpts=PTS-STARTPTS,${finish}` };
  }
  // -stream_loop on a pre-built ping-pong file is simpler than looping in a graph.
  return { inputs: ["-stream_loop", "-1"], vf: `trim=0:${need},setpts=PTS-STARTPTS,${finish}` };
}

async function aiClip(scene: { id: string; prompt: string; motionPrompt?: string; seed?: number }, project: ReturnType<typeof loadProject>,
  seconds: number, width: number, height: number, fps: number, dest: string, force: boolean): Promise<void> {
  const src = path.join(DIRS.images, `${scene.id}.png`);
  const raw = path.join(DIRS.motion, `${scene.id}.ai.mp4`);
  if (force || !fs.existsSync(raw) || fs.statSync(raw).size < 10_000) {
    await generateClip({
      image: src,
      prompt: [scene.motionPrompt ?? project.video?.prompt ?? "slow cinematic camera drift, subtle natural motion, atmospheric", scene.prompt].join(". "),
      negative: project.video?.negative ?? project.image?.negative,
      dest: raw, width, height,
      seconds: project.video?.seconds ?? 5,
      seed: scene.seed,
    });
  }
  fitClip(scene.id, raw, seconds, width, height, fps, dest, "", `motion-ai-${scene.id}`, "ai");
}

/**
 * Fit a raw clip to the scene (see fitFilter) and encode it. `w`×`h` is the
 * size the fit scales to; `after` is appended to the graph, for a final pass
 * that changes the size again (the stock push-in).
 */
function fitClip(id: string, raw: string, seconds: number, w: number, h: number, fps: number, dest: string, after: string, label: string, kind: string): void {
  const have = probeDuration(raw);
  const fit = fitFilter(have, seconds, w, h, fps);
  let input = raw;
  if (fit.inputs.length) {
    // ping-pong file: forward then reversed, so looping it is seamless
    input = path.join(DIRS.motion, `${id}.pp.mp4`);
    if (!fs.existsSync(input)) {
      ffmpeg(["-i", raw, "-filter_complex", "[0:v]split[a][b];[b]reverse[r];[a][r]concat=n=2:v=1[v]", "-map", "[v]",
        "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", input], `pingpong-${id}`);
    }
  }
  ffmpeg([...fit.inputs, "-i", input, "-vf", fit.vf + after, "-t", seconds.toFixed(3), "-r", String(fps),
    "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", dest], label);
  const how = seconds <= have + 0.05 ? "trimmed" : seconds <= have * 1.6 ? `slowed ×${(seconds / have).toFixed(2)}` : "ping-ponged";
  log("motion", `${id} ${seconds.toFixed(2)}s ${kind} (${have.toFixed(1)}s clip, ${how})`);
}

/**
 * The stock look: a slow push-in (or pull-out / pan, per the scene's motion)
 * over frames that were cut a little oversize, and a short fade at each end so
 * a cut lands softly instead of jumping. zoompan with d=1 walks the video frame
 * by frame — the same filter the images use, so the two kinds of scene match.
 */
function stockMotion(kind: PanDirection | Cinematic | "", frames: number, w: number, h: number, fps: number, zoom: number, fade: number, seconds: number, index: number, fadeIn = true, fadeOut = true, offsetFrames = 0, totalFrames = frames): string {
  let pan = "";
  if (zoom > 0 && kind) {
    const p = `((${offsetFrames}+in)/${Math.max(totalFrames - 1, 1)})`;
    let z = `'1+${zoom}*${p}'`, x = `'iw/2-(iw/zoom/2)'`, y = `'ih/2-(ih/zoom/2)'`;
    if (kind === "out") z = `'${1 + zoom}-${zoom}*${p}'`;
    if (kind === "left" || kind === "right") {
      z = `'${1 + zoom}'`;
      x = kind === "left" ? `'(iw-iw/zoom)*${p}'` : `'(iw-iw/zoom)*(1-${p})'`;
    }
    if (isCinematic(kind)) ({ z, x, y } = cinematicMove(kind, "in", frames, zoom, index, offsetFrames, totalFrames));
    pan = `,zoompan=z=${z}:x=${x}:y=${y}:d=1:s=${w}x${h}:fps=${fps}`;
  }
  let fades = "";
  if (fade > 0 && seconds > fade * 2.5) {
    if (fadeIn) fades += `,fade=t=in:st=0:d=${fade}`;
    if (fadeOut) fades += `,fade=t=out:st=${(seconds - fade).toFixed(3)}:d=${fade}`;
  }
  return `${pan}${fades}`;
}

/** Oversize by the zoom so the push-in never upscales the footage. */
const oversize = (n: number, zoom: number) => Math.round((n * (1 + zoom)) / 2) * 2;

function stockClip(scene: { id: string; motion?: string }, project: Project, choice: Pick, index: number,
  seconds: number, width: number, height: number, fps: number, dest: string, force: boolean,
  fadeIn = true, fadeOut = true, offsetFrames = 0, totalFrames = 0, spanKind?: Cinematic): void {
  const src = resolveClip(choice.file);
  const isContinuous = project.stock?.mode === "continuous";
  const zoom = Math.max(0, project.stock?.zoom ?? 0.08);
  const fade = Math.max(0, project.stock?.fade ?? 0.25);
  const ow = oversize(width, zoom), oh = oversize(height, zoom);
  const raw = path.join(DIRS.motion, `${scene.id}.src.mp4`);
  // The excerpt: from the chosen second, silent, frame-shaped. A little longer
  // than needed so a re-aligned timeline rarely has to cut it again.
  const avail = Math.max(choice.seconds - choice.start, 0.5);
  const take = Math.min(avail, Math.max(seconds + 2, 15));
  if (force || !skippableClip(raw, false, Math.min(seconds, avail))) {
    ffmpeg([
      "-ss", String(choice.start), "-i", src, "-t", take.toFixed(3),
      "-vf", `scale=${ow}:${oh}:force_original_aspect_ratio=increase:flags=lanczos,crop=${ow}:${oh},setsar=1,fps=${fps}`,
      "-an", "-c:v", "libx264", "-preset", "veryfast", "-crf", "16", "-pix_fmt", "yuv420p", raw,
    ], `stock-cut-${scene.id}`);
    fs.rmSync(path.join(DIRS.motion, `${scene.id}.pp.mp4`), { force: true });
  }
  // In continuous mode: motion animation per narration is disabled; motion only changes when the video changes,
  // automatically picking the best alternating cinematic moves across the span of that video.
  // In per-scene mode: respects scene.motion or alternates per scene.
  const kind = (isContinuous
    ? (spanKind ?? "cinematic")
    : (["in", "out", "left", "right", "cinematic", "cinematic-out"].includes(scene.motion ?? "")
        ? scene.motion : index % 2 ? "cinematic-out" : "cinematic")) as PanDirection | Cinematic | "";
  const frames = Math.max(Math.round(seconds * fps), 2);
  const effectiveTotalFrames = totalFrames > 0 ? totalFrames : frames;
  fitClip(scene.id, raw, seconds, ow, oh, fps, dest,
    stockMotion(kind, frames, width, height, fps, zoom, fade, seconds, index, fadeIn, fadeOut, offsetFrames, effectiveTotalFrames),
    `motion-stock-${scene.id}`, `stock ${kind || "steady"}`);
}

async function main() {
  loadEnv();
  const project = loadProject();
  const { width, height } = dims(project);
  const fps = FPS(project);
  const gap = project.gap ?? 0.35;
  const force = hasFlag("force");
  const timeline = fs.existsSync(TIMELINE) ? readJson<Timeline>(TIMELINE) : null;
  const picks = readPicks();
  ensureDir(DIRS.motion);

  // In continuous mode: group consecutive scenes that share the same clip into a continuous span.
  // Motion animation glides smoothly across the whole video without per-narration resets,
  // and only alternates to the next animation when the video clip changes.
  interface ClipSpan {
    videoIndex: number;
    kind: Cinematic;
    totalFrames: number;
  }
  const spans = new Map<number, { span: ClipSpan; offsetFrames: number }>();
  let currentVideoIndex = 0;
  let spanStart = 0;
  while (spanStart < project.scenes.length) {
    const scStart = project.scenes[spanStart];
    const pickStart = usesStock(project, scStart) ? picks[scStart.id] : undefined;
    if (!pickStart) {
      spanStart++;
      continue;
    }
    let spanEnd = spanStart;
    let totalSecs = 0;
    while (spanEnd < project.scenes.length) {
      const sc = project.scenes[spanEnd];
      const pk = usesStock(project, sc) ? picks[sc.id] : undefined;
      if (!pk || pk.file !== pickStart.file) break;
      const s = (timeline?.entries[spanEnd]?.duration ?? (sc.seconds ?? estimateSeconds(sc.narration)) + gap) + cardExtra(timeline, spanEnd);
      totalSecs += s;
      spanEnd++;
    }
    const totalFrames = Math.max(Math.round(totalSecs * fps), 2);
    const kind: Cinematic = currentVideoIndex % 2 === 0 ? "cinematic" : "cinematic-out";
    const spanInfo: ClipSpan = { videoIndex: currentVideoIndex, kind, totalFrames };
    let curOffsetF = 0;
    for (let k = spanStart; k < spanEnd; k++) {
      const sc = project.scenes[k];
      const s = (timeline?.entries[k]?.duration ?? (sc.seconds ?? estimateSeconds(sc.narration)) + gap) + cardExtra(timeline, k);
      spans.set(k, { span: spanInfo, offsetFrames: curOffsetF });
      curOffsetF += Math.round(s * fps);
    }
    currentVideoIndex++;
    spanStart = spanEnd;
  }

  for (const [i, scene] of project.scenes.entries()) {
    const src = path.join(DIRS.images, `${scene.id}.png`);
    const dest = path.join(DIRS.motion, `${scene.id}.mp4`);
    const stock = usesStock(project, scene) ? picks[scene.id] : undefined;
    if (usesStock(project, scene) && !stock) { warn("motion", `no clip picked for ${scene.id}, run pick:stock first`); continue; }
    if (!stock && !fs.existsSync(src)) { warn("motion", `missing image for ${scene.id}, run render:images first`); continue; }
    const seconds = (timeline?.entries[i]?.duration ?? (scene.seconds ?? estimateSeconds(scene.narration)) + gap) + cardExtra(timeline, i);
    if (skippableClip(dest, force, seconds)) { log("motion", `${scene.id} cached`); continue; }
    if (stock) {
      const isContinuous = project.stock?.mode === "continuous";
      const spanData = spans.get(i);
      const prevScene = i > 0 ? project.scenes[i - 1] : undefined;
      const prevChoice = prevScene && usesStock(project, prevScene) ? picks[prevScene.id] : undefined;
      const nextScene = i + 1 < project.scenes.length ? project.scenes[i + 1] : undefined;
      const nextChoice = nextScene && usesStock(project, nextScene) ? picks[nextScene.id] : undefined;
      const sameAsPrev = Boolean(isContinuous && prevChoice && prevChoice.file === stock.file);
      const sameAsNext = Boolean(isContinuous && nextChoice && nextChoice.file === stock.file);
      const motionIdx = isContinuous && spanData ? spanData.span.videoIndex : i;
      const offsetF = isContinuous && spanData ? spanData.offsetFrames : 0;
      const totalF = isContinuous && spanData ? spanData.span.totalFrames : 0;
      const spanKind = isContinuous && spanData ? spanData.span.kind : undefined;
      stockClip(scene, project, stock, motionIdx, seconds, width, height, fps, dest, force, !sameAsPrev, !sameAsNext, offsetF, totalF, spanKind);
      continue;
    }
    if (scene.motion === "ai") { await aiClip(scene, project, seconds, width, height, fps, dest, force); continue; }

    const frames = Math.max(Math.round(seconds * fps), 2);
    ffmpeg([
      "-i", src,
      "-vf", motionFilter((scene.motion as PanDirection | Cinematic | undefined) ?? (i % 2 ? "out" : "in"), frames, width, height, fps, i),
      "-frames:v", String(frames),
      "-r", String(fps),
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p",
      dest,
    ], `motion-${scene.id}`);
    log("motion", `${scene.id} ${seconds.toFixed(2)}s ${scene.motion ?? "auto"}`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
