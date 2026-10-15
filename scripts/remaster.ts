/**
 * Fast Remaster Script
 * Re-runs render-music (with --force) and master-final.
 * Takes ~2-3 seconds because images, speech TTS, alignment, and clips are cached.
 */
import { execFileSync } from "node:child_process";
import { FINAL, loadProject } from "../src/config";
import { PLATFORM_CODE } from "../src/safe";

const passthrough = process.argv.slice(2);
const project = loadProject();

console.log("\n\x1b[35m━━ render-music (remaster) ━━\x1b[0m");
execFileSync("npx", ["tsx", "scripts/render-music.ts", "--force", ...passthrough], {
  stdio: "inherit",
  env: process.env,
});

console.log("\n\x1b[35m━━ master-final (remaster) ━━\x1b[0m");
execFileSync("npx", ["tsx", "scripts/master-final.ts", ...passthrough], {
  stdio: "inherit",
  env: process.env,
});

// Re-run platform cuts if any platforms configured
const platforms = [...new Set(project.platforms ?? [])].filter((p) => p && PLATFORM_CODE[p]);
for (const platform of platforms) {
  const code = PLATFORM_CODE[platform as keyof typeof PLATFORM_CODE];
  if (!code) continue;
  console.log(`\n\x1b[35m━━ master-final (${platform}) ━━\x1b[0m`);
  execFileSync("npx", ["tsx", "scripts/render-captions.ts", ...passthrough], {
    stdio: "inherit",
    env: { ...process.env, PLATFORM_VARIANT: code },
  });
  execFileSync("npx", ["tsx", "scripts/master-final.ts", ...passthrough], {
    stdio: "inherit",
    env: { ...process.env, PLATFORM_VARIANT: code },
  });
}

console.log(`\n\x1b[32m✔ remastered in ~2s — ${FINAL}\x1b[0m`);

