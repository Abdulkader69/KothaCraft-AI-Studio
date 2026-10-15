import fs from "node:fs";
import path from "node:path";
import { PLATFORM_CODE, codeToPlatform } from "./safe";
import type { CardSet, Project, Scene, VerseSet } from "./types";

export const ROOT = process.cwd();

/**
 * Each reel gets its own output folder so several can coexist.
 * OUT_DIR must come from the real environment (the UI server sets it) — this is
 * evaluated at import time, before any script calls loadEnv().
 */
export const OUT = process.env.OUT_DIR
  ? path.resolve(ROOT, process.env.OUT_DIR)
  : path.join(ROOT, "out");

/** Where per-reel folders live, and the shared music library. */
export const REELS = path.join(ROOT, "out", "reels");
export const DIALOGUES = path.join(ROOT, "out", "dialogue");
export const MUSIC_DIR = path.resolve(ROOT, process.env.MUSIC_DIR ?? "music");

export const DIRS = {
  images: path.join(OUT, "01-images"),
  motion: path.join(OUT, "02-motion"),
  texture: path.join(OUT, "03-texture"),
  tts: path.join(OUT, "04-tts"),
  voice: path.join(OUT, "05-voice"),
  words: path.join(OUT, "06-words"),
  tmp: path.join(OUT, "tmp"),
};

/**
 * Hook variant letter ("b", "c" …) — set by the pipeline when rendering an
 * alternative opening. Scene 1 is swapped for that hook (id "01b"), and every
 * whole-reel artefact gets the suffix so variants never overwrite each other.
 * Scenes 2+ are shared and stay cached across variants.
 */
export const HOOK = (process.env.HOOK ?? "").trim().toLowerCase();

/**
 * Platform variant — the same cut re-captioned for one app's UI ("ig", "yt", …).
 * Only the captions and the master depend on it, so images, motion, voice and
 * the timeline are shared with the main cut and never re-rendered.
 */
export const PLAT = (process.env.PLATFORM_VARIANT ?? "").trim().toLowerCase();
const suffix = `${HOOK ? `-${HOOK}` : ""}${PLAT ? `-${PLAT}` : ""}`;
/** Files that a platform variant shares with the main cut (timing, audio, cover). */
const hookOnly = HOOK ? `-${HOOK}` : "";
export const hookLetter = (index: number) => String.fromCharCode("b".charCodeAt(0) + index);

export const TIMELINE = path.join(OUT, `timeline${hookOnly}.json`);
export const CAPTIONS = path.join(OUT, `captions${suffix}.ass`);
export const MUSIC_BED = path.join(OUT, `music-bed${hookOnly}.wav`);
export const FINAL = path.join(OUT, `final${suffix}.mp4`);
/** poster.png at the reel's aspect; poster-1x1.png / poster-16x9.png beside it. */
export const POSTER = (size = "") => path.join(OUT, `poster${size ? `-${size}` : ""}${hookOnly}.png`);

const initialEnv = new Set(Object.keys(process.env));
let envMtime = 0;

/** Minimal .env loader so the project stays dependency-free. Auto-reloads when .env changes. */
export function loadEnv(force = false): void {
  const file = path.join(ROOT, ".env");
  if (!fs.existsSync(file)) return;
  try {
    const stat = fs.statSync(file);
    if (!force && stat.mtimeMs === envMtime) return;
    envMtime = stat.mtimeMs;
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      // Do not overwrite variables explicitly passed in the process environment (e.g. from UI settings or CLI)
      if (initialEnv.has(key)) continue;
      const raw = m[2].trim();
      // Quoted values keep everything inside the quotes, including '#'. Unquoted
      // ones drop a trailing comment, so `KEY=   # note` reads as empty rather
      // than as the note itself.
      const quoted = /^(['"])([\s\S]*)\1$/.exec(raw);
      const value = quoted ? quoted[2] : raw.replace(/(^|\s)#.*$/, "").trim();
      if (value !== undefined) process.env[key] = value;
    }
  } catch {}
}

export function env(key: string, fallback = ""): string {
  loadEnv();
  return process.env[key] ?? fallback;
}

/** `--project content/demo.json` or content/demo.json by default */
export function loadProject(): Project {
  const flag = process.argv.indexOf("--project");
  let file: string;
  if (flag > -1) {
    file = process.argv[flag + 1];
  } else {
    const jsonArg = process.argv.slice(2).find((a) => !a.startsWith("-") && a.endsWith(".json"));
    file = jsonArg ?? (fs.existsSync(path.join(OUT, "project.json")) ? path.join(OUT, "project.json") : path.join(ROOT, "content", "demo.json"));
  }
  if (!path.isAbsolute(file)) file = path.join(ROOT, file);
  if (!fs.existsSync(file)) throw new Error(`Project file not found: ${file}`);
  const project = JSON.parse(fs.readFileSync(file, "utf8")) as Project;
  project.scenes.forEach((s, i) => (s.id = s.id ?? String(i + 1).padStart(2, "0")));
  if (HOOK) {
    const hook = project.hooks?.[HOOK.charCodeAt(0) - "b".charCodeAt(0)];
    if (!hook) throw new Error(`HOOK=${HOOK} but the project has no such hook variant`);
    const { id, ...first } = project.scenes[0];
    const swap = { ...first, ...Object.fromEntries(Object.entries(hook).filter(([, v]) => v !== undefined && v !== "")) };
    project.scenes[0] = { ...swap, id: `${id}${HOOK}` } as Scene;
  }
  if (hasFlag("continuous")) {
    project.stock = { ...project.stock, mode: "continuous" };
  } else if (hasFlag("scene")) {
    project.stock = { ...project.stock, mode: "scene" };
  }
  if (hasFlag("stock")) {
    project.footage = "stock";
  }
  const platFlag = process.argv.indexOf("--platforms");
  if (platFlag > -1 && process.argv[platFlag + 1]) {
    const raw = process.argv[platFlag + 1];
    const parsed = raw
      .split(/[,\s]+/)
      .map((p) => {
        const cleanP = p.trim().toLowerCase();
        return (codeToPlatform(cleanP) ?? cleanP) as any;
      })
      .filter((p) => p && PLATFORM_CODE[p as keyof typeof PLATFORM_CODE]);
    if (parsed.length) project.platforms = parsed;
  }
  return project;
}

export function dims(project: Project): { width: number; height: number } {
  switch (project.aspect ?? "9:16") {
    case "16:9": return { width: 1920, height: 1080 };
    case "1:1": return { width: 1080, height: 1080 };
    default: return { width: 1080, height: 1920 };
  }
}

export const FPS = (project: Project) => project.fps ?? 30;
export const hasFlag = (name: string) => process.argv.includes(`--${name}`);

/** Where card sets render: out/cards/<slug>/ (the UI sets OUT_DIR, like reels). */
export const CARDS = path.join(ROOT, "out", "cards");

/** `--project content/cards/demo.json` — a CardSet, not a reel. */
export function loadCardSet(): CardSet {
  const flag = process.argv.indexOf("--project");
  let file = flag > -1 ? process.argv[flag + 1] : path.join(ROOT, "content", "cards", "demo.json");
  if (!path.isAbsolute(file)) file = path.join(ROOT, file);
  if (!fs.existsSync(file)) throw new Error(`Card set not found: ${file}`);
  const set = JSON.parse(fs.readFileSync(file, "utf8")) as CardSet;
  if (!Array.isArray(set.cards) || !set.cards.length) throw new Error(`${file} has no "cards"`);
  set.cards.forEach((c, i) => (c.id = c.id ?? String(i + 1).padStart(2, "0")));
  return set;
}

/** Where verse sets render: out/verses/<slug>/ (the UI sets OUT_DIR, like reels). */
export const VERSES = path.join(ROOT, "out", "verses");

/** `--project content/verses/demo.json` — a VerseSet, not a reel or a card set. */
export function loadVerseSet(): VerseSet {
  const flag = process.argv.indexOf("--project");
  let file = flag > -1 ? process.argv[flag + 1] : path.join(ROOT, "content", "verses", "demo.json");
  if (!path.isAbsolute(file)) file = path.join(ROOT, file);
  if (!fs.existsSync(file)) throw new Error(`Verse set not found: ${file}`);
  const set = JSON.parse(fs.readFileSync(file, "utf8")) as VerseSet;
  if (!Array.isArray(set.verses) || !set.verses.length) throw new Error(`${file} has no "verses"`);
  set.verses.forEach((v, i) => (v.id = v.id ?? String(i + 1).padStart(2, "0")));
  return set;
}

export function verseDims(set: VerseSet): { width: number; height: number } {
  return (set.aspect ?? "9:16") === "1:1"
    ? { width: 1080, height: 1080 }
    : { width: 1080, height: 1920 };
}

export function cardDims(set: CardSet): { width: number; height: number } {
  switch (set.aspect ?? "1:1") {
    case "4:5": return { width: 1080, height: 1350 };
    case "9:16": return { width: 1080, height: 1920 };
    default: return { width: 1080, height: 1080 };
  }
}

/**
 * Intro/outro cards are on by default: the title for 3 s, a follow card for 6 s.
 * A project turns one off with `"seconds": 0`; text is overridable per project.
 */
export const CARD_DEFAULTS = {
  intro: { seconds: 3 },
  outro: { seconds: 6, text: "প্রতিদিন একটি গল্প\nফলো করুন\nfacebook//হিকমাহ-Wisdom" },
};
export function cardsFor(project: Project): { intro: { seconds: number; text: string }; outro: { seconds: number; text: string } } {
  return {
    intro: { seconds: Math.max(0, project.intro?.seconds ?? CARD_DEFAULTS.intro.seconds), text: (project.intro?.text ?? "").trim() || project.title },
    outro: { seconds: Math.max(0, project.outro?.seconds ?? CARD_DEFAULTS.outro.seconds), text: (project.outro?.text ?? "").trim() || CARD_DEFAULTS.outro.text },
  };
}

/** Watermark when a project says nothing: the channel name, top right. `brand.off: true` disables it. */
export const BRAND_DEFAULT: NonNullable<Project["brand"]> = { text: "হিকমাহ-Wisdom", position: "top-right" };
