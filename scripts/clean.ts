/**
 * Clear generated output without losing your reels.
 *
 *   npm run clean          rendered artifacts for every reel; project.json kept
 *   npm run clean -- --all delete out/ entirely, reels and all
 *
 * `out/reels/<slug>/project.json` is what makes a reel exist in the UI, so the
 * default deliberately leaves it behind — a plain `rm -rf out` would wipe every
 * reel you have written.
 */
import fs from "node:fs";
import path from "node:path";
import { OUT, REELS, ROOT } from "../src/config";
import { log, warn } from "../src/util";

const OUT_ROOT = path.join(ROOT, "out");

/** Everything a render produces. `project.json` is not in here on purpose. */
const ARTIFACTS = [
  "01-images", "02-motion", "03-texture", "04-tts", "05-voice", "06-words", "tmp",
  "captions.ass", "timeline.json", "stock.json", "music-bed.wav", "final.mp4", "ui-project.json", ".DS_Store",
];

function bytes(p: string): number {
  if (!fs.existsSync(p)) return 0;
  const s = fs.statSync(p);
  if (!s.isDirectory()) return s.size;
  return fs.readdirSync(p).reduce((n, f) => n + bytes(path.join(p, f)), 0);
}

const mb = (n: number) => `${(n / 1e6).toFixed(1)} MB`;

function wipe(dir: string, label: string): number {
  let freed = 0;
  // plus the title-named copy of the video (a hard link to final.mp4, see master-final)
  const titled = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /\.mp4$/i.test(f) && !/^final/.test(f)) : [];
  titled.push(".titled.json");
  for (const name of [...ARTIFACTS, ...titled]) {
    const target = path.join(dir, name);
    if (!fs.existsSync(target)) continue;
    freed += bytes(target);
    fs.rmSync(target, { recursive: true, force: true });
  }
  if (freed) log("clean", `${label} — ${mb(freed)}`);
  return freed;
}

function main() {
  if (!fs.existsSync(OUT_ROOT)) { log("clean", "nothing to clean"); return; }

  if (process.argv.includes("--all")) {
    const freed = bytes(OUT_ROOT);
    fs.rmSync(OUT_ROOT, { recursive: true, force: true });
    warn("clean", `removed out/ entirely — ${mb(freed)}, including every reel`);
    return;
  }

  // Legacy artifacts from before reels had their own folders.
  let freed = wipe(OUT_ROOT, "out/ (legacy)");

  if (fs.existsSync(REELS)) {
    for (const slug of fs.readdirSync(REELS)) {
      const dir = path.join(REELS, slug);
      if (!fs.statSync(dir).isDirectory()) continue;
      freed += wipe(dir, `reels/${slug}`);
    }
  }

  log("clean", freed ? `freed ${mb(freed)} — reel project files kept` : "already clean");
  log("clean", "use `npm run clean -- --all` to delete reels too");
}

main();
