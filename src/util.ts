import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Font files differ per OS — resolve at runtime instead of hardcoding a Linux path. */
const FONT_CANDIDATES = [
  process.env.FONT_FILE ?? "",
  // macOS
  "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
  "/System/Library/Fonts/Supplemental/Arial.ttf",
  "/Library/Fonts/Arial Bold.ttf",
  "/System/Library/Fonts/Helvetica.ttc",
  "/System/Library/Fonts/SFNSDisplay.ttf",
  // Linux
  "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
  "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
  "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
  // Windows
  "C:/Windows/Fonts/arialbd.ttf",
  "C:/Windows/Fonts/arial.ttf",
];

let cachedFont: string | null | undefined;

export function findFont(): string | null {
  // FONT_FILE is read here, not in the candidate list: that list is built when
  // this module is imported, which is before any script has called loadEnv(),
  // so a font set in .env would otherwise never be seen. Without it, drawtext
  // falls back to Arial and Bangla comes out as empty boxes.
  const explicit = process.env.FONT_FILE;
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (cachedFont !== undefined) return cachedFont;
  cachedFont = FONT_CANDIDATES.find((f) => f && fs.existsSync(f)) ?? null;
  return cachedFont;
}

/** Font *family* name for ASS subtitles (libass looks it up by name, not path). */
export function defaultFontName(): string {
  if (process.env.CAPTION_FONT) return process.env.CAPTION_FONT;
  if (os.platform() === "darwin") return "Helvetica";
  if (os.platform() === "win32") return "Arial";
  return "DejaVu Sans";
}

export function log(step: string, msg: string): void {
  console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`);
}
export function warn(step: string, msg: string): void {
  console.log(`\x1b[33m[${step}]\x1b[0m ${msg}`);
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Escape a path so it survives ffmpeg's filtergraph parser (Windows drive letters, spaces). */
export function escPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'").replace(/([,[\]])/g, "\\$1");
}

export function ffmpeg(args: string[], label = "ffmpeg"): void {
  try {
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (err: any) {
    const stderr = (err?.stderr?.toString() ?? "").trim().split("\n").slice(-6).join("\n");
    throw new Error(`${label} failed\n${stderr}\n\ncommand: ffmpeg ${args.map(q).join(" ")}`);
  }
}

const q = (a: string) => (/[\s'"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);

export function hasFilter(name: string): boolean {
  try {
    return execFileSync("ffmpeg", ["-hide_banner", "-filters"], { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .split("\n")
      .some((line) => line.trim().split(/\s+/)[1] === name);
  } catch {
    return false;
  }
}

export function probeDuration(file: string): number {
  const out = execFileSync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]).toString().trim();
  const value = parseFloat(out);
  return Number.isFinite(value) ? value : 0;
}

/** First moment of non-silence, used to keep word timings aligned after trimming. */
export function leadingSilence(file: string, thresholdDb = -45): number {
  try {
    const out = execFileSync("ffmpeg", [
      "-hide_banner", "-i", file,
      "-af", `silencedetect=noise=${thresholdDb}dB:d=0.05`, "-f", "null", "-",
    ], { stdio: ["ignore", "ignore", "pipe"] }).toString();
    const start = out.match(/silence_start:\s*(-?\d+(?:\.\d+)?)/);
    const end = out.match(/silence_end:\s*(\d+(?:\.\d+)?)/);
    if (start && parseFloat(start[1]) <= 0.05 && end) return Math.max(0, parseFloat(end[1]));
    return 0;
  } catch {
    return 0;
  }
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

export function writeJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export const exists = (file: string) => fs.existsSync(file);

/** Skip work that is already done unless --force is passed. */
export function skippable(file: string, force: boolean): boolean {
  return !force && fs.existsSync(file) && fs.statSync(file).size > 0;
}

/** A derived file is reusable only if it is newer than what it was made from. */
export function upToDate(dest: string, src: string, force: boolean): boolean {
  return skippable(dest, force) && fs.statSync(dest).mtimeMs >= fs.statSync(src).mtimeMs;
}

/**
 * TTS is cached per scene id, but the text behind it can change (an edit, a hook
 * variant). A sidecar holds the narration that produced the file; a mismatch
 * re-synthesises. `provider` is included so switching voices re-synthesises too.
 */
export function ttsCached(dest: string, key: string, force: boolean): boolean {
  if (!skippable(dest, force)) return false;
  const side = `${dest}.txt`;
  // Files from before sidecars existed are adopted as-is — never re-bill a whole
  // reel just because the bookkeeping is new.
  if (!fs.existsSync(side)) { fs.writeFileSync(side, key); return true; }
  return fs.readFileSync(side, "utf8") === key;
}
export function rememberTts(dest: string, key: string): void {
  fs.writeFileSync(`${dest}.txt`, key);
}

/** A cached clip is only reusable while it is still (at least) as long as it needs to be. */
export function skippableClip(file: string, force: boolean, seconds: number): boolean {
  return skippable(file, force) && probeDuration(file) >= seconds - 0.1;
}

/**
 * The intro card runs on the first scene's clip and the outro on the last, so those
 * two clips are rendered longer than their timeline entry by the card's length.
 */
export function cardExtra(timeline: { intro?: number; outro?: number; entries: unknown[] } | null, index: number): number {
  if (!timeline) return 0;
  return (index === 0 ? timeline.intro ?? 0 : 0) + (index === timeline.entries.length - 1 ? timeline.outro ?? 0 : 0);
}

export function estimateSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.8, Math.round((words / 2.6) * 10) / 10);
}

export async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed ${res.status} ${url}`);
  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}
