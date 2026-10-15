/**
 * Runs every step in order. Individual steps stay runnable on their own.
 * Order matters: narration is generated and measured first, so the motion clips
 * are rendered at the exact durations the timeline needs.
 */
import { execFileSync } from "node:child_process";
import { FINAL, hookLetter, loadProject } from "../src/config";
import { PLATFORM_CODE } from "../src/safe";

const passthrough = process.argv.slice(2);
// pick-stock sits after align so footage is cut to the real scene lengths; it
// is a no-op for projects without stock scenes.
const steps = [
  "render-images", "generate-tts", "render-voice", "transcribe", "align",
  "pick-stock", "render-motion", "render-texture", "render-captions", "render-music", "master-final",
  // Covers for publishing: poster.png at the reel aspect, plus 1x1 and 16x9.
  "render-poster",
];

// The main cut first, then one pass per hook variant. Everything from scene 2 on is
// cached by then, so a variant costs one image, one narration and one master.
const project = loadProject();
const hooks = project.hooks ?? [];
const variants = ["", ...hooks.map((_, i) => hookLetter(i))];

// Per-platform cuts: the same video re-captioned so each app's own UI does not
// cover the words. Only captions + master re-run, so each one costs seconds.
const platforms = [...new Set(project.platforms ?? [])].filter((p) => p && PLATFORM_CODE[p]);
const replay = ["render-captions", "master-final"];

for (const hook of variants) {
  if (hook) console.log(`\n\x1b[35m━━━━ hook variant ${hook.toUpperCase()} ━━━━\x1b[0m`);
  for (const step of steps) {
    console.log(`\n\x1b[35m━━ ${step}${hook ? ` (${hook})` : ""} ━━\x1b[0m`);
    execFileSync("npx", ["tsx", `scripts/${step}.ts`, ...passthrough], { stdio: "inherit", env: { ...process.env, HOOK: hook } });
  }
  for (const platform of platforms) {
    const code = PLATFORM_CODE[platform as keyof typeof PLATFORM_CODE];
    if (!code) continue;
    for (const step of replay) {
      console.log(`\n\x1b[35m━━ ${step} (${platform}${hook ? `, ${hook}` : ""}) ━━\x1b[0m`);
      execFileSync("npx", ["tsx", `scripts/${step}.ts`, ...passthrough], { stdio: "inherit", env: { ...process.env, HOOK: hook, PLATFORM_VARIANT: code } });
    }
  }
}
const extras = [hooks.length ? `${hooks.length} hook variant(s)` : "", platforms.length ? `${platforms.length} platform cut(s)` : ""].filter(Boolean);
console.log(`\n\x1b[32m✔ done — ${FINAL}${extras.length ? ` + ${extras.join(" + ")}` : ""}\x1b[0m`);
