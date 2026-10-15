/**
 * Step 1 — Image Generation
 * scene.prompt -> out/01-images/<id>.png
 *
 * Seeds are deterministic, so a plain re-run reproduces the same frame — including
 * a bad one. To re-roll:
 *   npm run render:images -- --reroll         every scene
 *   npm run render:images -- --reroll 02,04   just those scenes
 * Each roll prints its seed; pin a keeper with `"seed": 445566` on the scene.
 */
import path from "node:path";
import { DIRS, dims, hasFlag, loadEnv, loadProject } from "../src/config";
import { generateImage } from "../src/providers/images";
import { usesStock } from "../src/stock";
import { ensureDir, log, skippable } from "../src/util";

/** `--reroll` on its own means every scene; `--reroll 02,04` means only those. */
function rerollTargets(): Set<string> | null | undefined {
  const i = process.argv.indexOf("--reroll");
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  if (!next || next.startsWith("--")) return null;
  return new Set(next.split(",").map((s) => s.trim()).filter(Boolean));
}

async function main() {
  loadEnv();
  const project = loadProject();
  const { width, height } = dims(project);
  const force = hasFlag("force");
  const reroll = rerollTargets();
  ensureDir(DIRS.images);

  for (const [index, scene] of project.scenes.entries()) {
    const dest = path.join(DIRS.images, `${scene.id}.png`);
    // Footage scenes get their still from pick-stock — never bill an image for one.
    if (usesStock(project, scene)) { log("images", `${scene.id} stock footage — no image needed`); continue; }
    const rerollThis = reroll !== undefined && (reroll === null || reroll.has(scene.id));
    if (skippable(dest, force || rerollThis)) { log("images", `${scene.id} cached`); continue; }

    const seed = rerollThis ? Math.floor(Math.random() * 1_000_000) : scene.seed;
    await generateImage({
      prompt: scene.prompt,
      style: project.image?.style,
      negative: project.image?.negative,
      model: project.image?.model,
      width, height, dest, index, seed,
    });
    if (rerollThis) log("images", `${scene.id} rolled seed ${seed} — keep it with "seed": ${seed}`);
  }
  log("images", `${project.scenes.length} frames ready in ${DIRS.images}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
