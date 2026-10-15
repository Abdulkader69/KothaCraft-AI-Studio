/**
 * Stock footage — a folder of free, copyright-free clips that stand in for
 * generated images. `pick-stock` matches a clip to each scene by the words in
 * its file name and records the choice in out/stock.json; `render:motion` cuts,
 * fits and animates it. Nothing downstream knows the difference.
 *
 *   STOCK_DIR=…   the library (default: stock/), subfolders welcome — their
 *                 names count as tags, so stock/ocean/waves.mp4 matches "ocean"
 */
import fs from "node:fs";
import path from "node:path";
import { OUT, ROOT } from "./config";
import type { Project, Scene } from "./types";

export const STOCK_DIR = path.resolve(ROOT, process.env.STOCK_DIR ?? "stock");
export const STOCK_EXT = /\.(mp4|mov|m4v|webm|mkv)$/i;
/** Per-reel record of which clip, and which second of it, each scene got. */
export const PICKS = path.join(OUT, "stock.json");

export interface Pick {
  file: string;               // relative to STOCK_DIR (or a repo path when the project named one)
  start: number;              // seconds into the clip where the scene begins
  seconds: number;            // the clip's full length, so the UI can show how much was cut
  auto: boolean;              // false when the project pinned this clip itself
  roll?: number;              // how many times "a different one" was asked for
}
export type Picks = Record<string, Pick>;

export const readPicks = (): Picks => (fs.existsSync(PICKS) ? JSON.parse(fs.readFileSync(PICKS, "utf8")) : {});
export function writePicks(picks: Picks): void {
  fs.mkdirSync(path.dirname(PICKS), { recursive: true });
  fs.writeFileSync(PICKS, JSON.stringify(picks, null, 2));
}

/** Every clip in the library, as paths relative to it, sorted. Dot-folders (thumbnails) are skipped. */
export function listStock(dir = STOCK_DIR): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (f.name.startsWith(".")) continue;
      const r = rel ? `${rel}/${f.name}` : f.name;
      if (f.isDirectory()) walk(path.join(d, f.name), r);
      else if (STOCK_EXT.test(f.name)) out.push(r);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** A scene is cut from footage when it names a clip, or the whole project runs on stock. */
export const usesStock = (project: Project, scene: Scene): boolean => project.footage === "stock" || Boolean(scene.clip);

/** A clip name resolves inside the library first, then as a repo path. */
export function resolveClip(name: string): string {
  const inLib = path.join(STOCK_DIR, name);
  if (fs.existsSync(inLib)) return inLib;
  const abs = path.isAbsolute(name) ? name : path.join(ROOT, name);
  if (fs.existsSync(abs)) return abs;
  throw new Error(`clip not found: ${name} (looked in ${path.relative(ROOT, STOCK_DIR)}/ and the repo)`);
}

// Words that say nothing about what a clip shows — grammar, and the noise stock
// sites put in their file names.
const STOP = new Set([
  "the", "and", "for", "with", "from", "into", "over", "under", "this", "that", "its", "are", "was", "were",
  "very", "more", "most", "some", "any", "not", "you", "your", "our", "his", "her", "their", "has", "have",
  "shot", "footage", "video", "clip", "stock", "free", "royalty", "hd", "uhd", "1080p", "720p", "2160p", "4k",
  "fps", "pexels", "pixabay", "mixkit", "coverr", "videvo", "vecteezy", "production", "id",
]);

/** Lower-case words of three or more letters, minus the noise. Any script — Bangla words match Bangla file names. */
export function words(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w));
}

/** forest ~ forests, run ~ running: equal, or one is a 4+ letter prefix of the other. */
const near = (a: string, b: string) => a === b || (a.length >= 4 && b.startsWith(a)) || (b.length >= 4 && a.startsWith(b));

/** How well a file name describes some words: 2 per exact word, 1 per near one. */
export function score(file: string, sceneWords: string[]): number {
  let s = 0;
  for (const w of new Set(words(file.replace(/\.[^.]+$/, "")))) {
    if (sceneWords.includes(w)) s += 2;
    else if (sceneWords.some((x) => near(w, x))) s += 1;
  }
  return s;
}

/** FNV-1a — small and stable, so a reel picks the same clips on every run. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h;
}

export interface Ranked { file: string; score: number }

/**
 * Library ranked for a scene: the prompt weighs double the narration, clips
 * already used in this reel sink to the bottom, and ties break by hash — stable
 * across runs, but not "always the first file alphabetically".
 */
export function rank(library: string[], scene: Scene, used: Set<string>, salt: string): Ranked[] {
  const prompt = words(scene.prompt ?? "");
  const narration = words(scene.narration ?? "");
  return library
    .map((file) => ({ file, score: score(file, prompt) * 2 + score(file, narration) }))
    .sort((a, b) =>
      Number(used.has(a.file)) - Number(used.has(b.file)) ||
      b.score - a.score ||
      hash(salt + a.file) - hash(salt + b.file));
}

/** The best clip, or `roll` places further down for "a different one". */
export function pick(library: string[], scene: Scene, used: Set<string>, roll: number, salt: string): Ranked | undefined {
  const ranked = rank(library, scene, used, salt);
  return ranked.length ? ranked[roll % ranked.length] : undefined;
}

/**
 * Where inside a clip to start: somewhere that still leaves `need` seconds,
 * skipping the first moments (stock clips often fade in), spread by hash so a
 * long clip is not always cut to its opening.
 */
export function chooseStart(have: number, need: number, salt: string): number {
  const spare = have - need;
  if (spare <= 0.2) return 0;
  const lead = Math.min(0.5, spare * 0.25);
  const frac = (hash(salt) % 1000) / 1000;
  return Math.round((lead + frac * (spare - lead)) * 100) / 100;
}
