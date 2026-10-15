/**
 * Step 5½ — Stock footage
 * stock/*.mp4 + scene words -> out/stock.json, plus a still in out/01-images/<id>.png
 *
 * Only projects with "footage": "stock" (or scenes that name a "clip") do
 * anything here. Every such scene gets a clip — the one the project pinned, or
 * the best match by file-name words — and a start second inside it, chosen so
 * the scene fits without looping and long clips are not always cut to their
 * opening. Runs after `align`, so it knows the real scene lengths.
 *
 * The still frame keeps everything that expects an image working — the poster,
 * the UI thumbnails, the intro/outro cards.
 *
 *   npm run pick:stock -- --reroll 02   a different clip for scene 02
 *   npm run pick:stock -- --force        re-pick every scene
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, TIMELINE, dims, hasFlag, loadEnv, loadProject } from "../src/config";
import { type Pick, PICKS, STOCK_DIR, chooseStart, listStock, pick, rank, readPicks, resolveClip, usesStock, writePicks } from "../src/stock";
import type { Timeline } from "../src/types";
import { cardExtra, ensureDir, estimateSeconds, ffmpeg, log, probeDuration, readJson, warn } from "../src/util";

/** `--reroll 02,04` — those scenes get a different clip; `--reroll` alone means every scene. */
function rerollTargets(): Set<string> | null | undefined {
  const i = process.argv.indexOf("--reroll");
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return null;
  return new Set(next.split(",").map((s) => s.trim()).filter(Boolean));
}

/** A changed pick invalidates everything cut from the old one. */
function invalidate(id: string): void {
  for (const f of [
    path.join(DIRS.images, `${id}.png`),
    path.join(DIRS.motion, `${id}.mp4`), path.join(DIRS.motion, `${id}.src.mp4`), path.join(DIRS.motion, `${id}.pp.mp4`),
    path.join(DIRS.texture, `${id}.mp4`),
  ]) fs.rmSync(f, { force: true });
}

function main() {
  loadEnv();
  const project = loadProject();
  const stockScenes = project.scenes.filter((s) => usesStock(project, s));
  if (!stockScenes.length) { log("stock", "no stock scenes in this project — nothing to pick"); return; }

  const { width, height } = dims(project);
  const force = hasFlag("force");
  const reroll = rerollTargets();
  const timeline = fs.existsSync(TIMELINE) ? readJson<Timeline>(TIMELINE) : null;
  const gap = project.gap ?? 0.35;
  const all = listStock();
  const auto = stockScenes.some((s) => !s.clip);
  if (auto && !all.length) {
    throw new Error(`no clips in ${path.relative(process.cwd(), STOCK_DIR)}/ — drop some .mp4 files there (Pexels, Pixabay, Mixkit and Coverr are free) or name a "clip" on each scene`);
  }
  // A shortlist narrows auto-pick to the clips the project ticked.
  const only = (project.stock?.only ?? []).filter(Boolean);
  const missing = only.filter((f) => !all.includes(f));
  if (missing.length) warn("stock", `shortlisted clip(s) no longer in the library, ignored: ${missing.join(", ")}`);
  const library = only.length ? all.filter((f) => only.includes(f)) : all;
  if (auto && !library.length) throw new Error("the shortlist names no clip that still exists — untick it or add the files back");
  if (only.length) log("stock", `auto-pick limited to ${library.length} shortlisted clip(s)`);

  const picks = readPicks();
  const lengths = new Map<string, number>();
  const length = (file: string) => {
    if (!lengths.has(file)) lengths.set(file, probeDuration(resolveClip(file)));
    return lengths.get(file)!;
  };

  const mode = process.argv.includes("--continuous") ? "continuous"
    : process.argv.includes("--scene") ? "scene"
    : project.stock?.mode ?? "scene";
  const isContinuous = mode === "continuous";

  if (isContinuous) {
    // "Finish video then use another one if needed" mode:
    // Play a video clip across scenes until it finishes, then advance to another clip.
    ensureDir(DIRS.images);
    const used = new Set<string>();
    let currentClip: { file: string; start: number; have: number; roll: number } | null = null;

    for (const [i, scene] of project.scenes.entries()) {
      if (!usesStock(project, scene)) continue;
      const still = path.join(DIRS.images, `${scene.id}.png`);
      const old = picks[scene.id];
      const isReroll = reroll !== undefined && (reroll === null || reroll.has(scene.id));
      const need = (timeline?.entries[i]?.duration ?? estimateSeconds(scene.narration) * 1.3 + gap) + cardExtra(timeline, i);
      const salt = `${project.title}|${scene.id}|${old?.roll ?? 0}`;

      if (scene.clip) {
        if (!currentClip || currentClip.file !== scene.clip) {
          resolveClip(scene.clip);
          const have = length(scene.clip);
          currentClip = { file: scene.clip, start: 0, have, roll: 0 };
          used.add(scene.clip);
        }
      } else if (isReroll || !currentClip) {
        const canKeepOld = !force && !isReroll && old && library.includes(old.file);
        const roll = isReroll ? (old?.roll ?? 0) + 1 : (old?.roll ?? 0);
        const file = canKeepOld ? old.file : pick(library, scene, used, roll, salt)!.file;
        const have = length(file);
        currentClip = { file, start: 0, have, roll };
        used.add(currentClip.file);
      } else {
        const remaining = currentClip.have - currentClip.start;
        // If remaining duration cannot cover this scene (with 0.3s tolerance) and we already used part of it, clip is finished!
        if (currentClip.start > 0 && remaining < need - 0.3) {
          const prevPickedFile = picks[project.scenes[i - 1]?.id]?.file;
          const canKeepOld = !force && old && library.includes(old.file) && old.file !== prevPickedFile;
          const roll = old?.roll ?? 0;
          const file = canKeepOld ? old.file : pick(library, scene, used, roll, salt)!.file;
          const have = length(file);
          currentClip = { file, start: 0, have, roll };
          used.add(currentClip.file);
        }
      }

      const file = currentClip.file;
      const have = currentClip.have;
      const start = Math.round(currentClip.start * 100) / 100;
      const roll = currentClip.roll;
      const next: Pick = {
        file,
        start,
        seconds: Math.round(have * 100) / 100,
        auto: !scene.clip,
        ...(roll ? { roll } : {}),
      };

      const changed = !old || old.file !== next.file || Math.abs(old.start - next.start) > 0.05;
      if (changed) invalidate(scene.id);
      log("stock", `${scene.id} ${file} from ${start.toFixed(1)}s of ${have.toFixed(1)}s (continuous${start > 0 ? ": continued" : ": new clip"})`);

      picks[scene.id] = next;
      currentClip.start += need;

      if (!fs.existsSync(still)) {
        ffmpeg([
          "-ss", String(next.start), "-i", resolveClip(next.file),
          "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`,
          "-frames:v", "1", still,
        ], `still-${scene.id}`);
      }
    }
  } else {
    // "Video per scene" mode (default):
    // Clips already spoken for — kept picks first, so a re-run never hands one scene's clip to another.
    const used = new Set<string>();
    const keep = new Set<string>();
    for (const scene of stockScenes) {
      const old = picks[scene.id];
      if (!old || force) continue;
      if (reroll !== undefined && (reroll === null || reroll.has(scene.id))) continue;
      // A pin that changed, or a pin removed, is a new pick too.
      if (scene.clip ? old.file !== scene.clip || old.auto : !old.auto) continue;
      try { resolveClip(old.file); } catch { continue; }
      keep.add(scene.id);
      used.add(old.file);
    }

    // Choose clips for the scenes that need one — pinned first, then the scenes
    // whose words actually match something (best match first), then the rest by rotation.
    const chosen = new Map<string, { file: string; why: string; roll: number }>();
    const pending = project.scenes.filter((sc) => usesStock(project, sc) && !keep.has(sc.id));
    const rollOf = (sc: typeof pending[number]) => {
      const old = picks[sc.id];
      return reroll !== undefined && (reroll === null || reroll.has(sc.id)) ? (old?.roll ?? 0) + 1 : (old?.roll ?? 0);
    };
    const bestScore = (sc: typeof pending[number]) => (sc.clip ? Infinity : rank(library, sc, new Set(), "").find(() => true)?.score ?? 0);
    for (const sc of [...pending].sort((a, b) => bestScore(b) - bestScore(a))) {
      const roll = rollOf(sc);
      const salt = `${project.title}|${sc.id}|${roll}`;
      if (sc.clip) {
        resolveClip(sc.clip);
        chosen.set(sc.id, { file: sc.clip, why: "pinned", roll });
      } else {
        const best = pick(library, sc, used, roll, salt)!;
        chosen.set(sc.id, { file: best.file, why: best.score ? `score ${best.score}` : "no word match — by rotation", roll });
      }
      used.add(chosen.get(sc.id)!.file);
    }

    ensureDir(DIRS.images);
    for (const [i, scene] of project.scenes.entries()) {
      if (!usesStock(project, scene)) continue;
      const still = path.join(DIRS.images, `${scene.id}.png`);
      const old = picks[scene.id];

      let next = old;
      if (!keep.has(scene.id)) {
        const { file, why, roll } = chosen.get(scene.id)!;
        const salt = `${project.title}|${scene.id}|${roll}`;
        const have = length(file);
        // The real length once the timeline exists; before that a generous guess,
        // so a re-pick after `align` rarely has to move the start.
        const need = (timeline?.entries[i]?.duration ?? estimateSeconds(scene.narration) * 1.3 + gap) + cardExtra(timeline, i);
        const start = chooseStart(have, need, salt);
        next = { file, start, seconds: Math.round(have * 100) / 100, auto: !scene.clip, ...(roll ? { roll } : {}) };
        const changed = !old || old.file !== next.file || old.start !== next.start;
        if (changed) invalidate(scene.id);
        log("stock", `${scene.id} ${file} from ${start.toFixed(1)}s of ${have.toFixed(1)}s (${why})`);
      } else {
        log("stock", `${scene.id} ${old!.file} kept`);
      }
      picks[scene.id] = next!;

      if (!fs.existsSync(still)) {
        ffmpeg([
          "-ss", String(next!.start), "-i", resolveClip(next!.file),
          "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`,
          "-frames:v", "1", still,
        ], `still-${scene.id}`);
      }
    }
  }
  writePicks(picks);
  log("stock", `${stockScenes.length} scene(s) picked → ${path.relative(process.cwd(), PICKS)}`);
}

try { main(); } catch (e: any) { console.error(e.message); process.exit(1); }
