/**
 * Batch render from the terminal — one reel after another into out/reels/<slug>/.
 *
 *   npm run batch -- content/60-days-all.json              # every project in the bundle
 *   npm run batch -- content/60-days/day-1*.json           # any number of project files
 *   npm run batch -- content/60-days-all.json --only 11-20 # days 11..20 of a bundle (1-based)
 *   npm run batch -- … --force                             # re-render reels that already have a video
 *
 * Provider settings come from .env. Each reel runs the full pipeline with its
 * own OUT_DIR; a failure is logged and the batch carries on.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { REELS, ROOT, loadEnv } from "../src/config";
import { PLATFORM_CODE, codeToPlatform } from "../src/safe";
import type { Project } from "../src/types";
import { ensureDir, log, warn } from "../src/util";

function slugify(title: string): string {
  return (title || "").normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}\p{M}]+/gu, "-").replace(/^-+|-+$/gu, "") || "untitled";
}

/** "<file> - <title-slug>", the 17th of a bundle "<file>-17 - …" — the same rule as the UI. */
function folderFor(project: Project & { folder?: string }, file: string, index: number, count: number): string {
  if (project.folder && !/[\/\\.]/.test(project.folder)) return project.folder;
  const stem = path.basename(file).replace(/\.json$/i, "").normalize("NFC").replace(/[^\p{L}\p{N}\p{M} _-]+/gu, "-").replace(/^-+|-+$/g, "");
  return `${stem}${count > 1 ? `-${String(index + 1).padStart(2, "0")}` : ""} - ${slugify(project.title)}`.slice(0, 120).trim();
}

function projectsIn(file: string): Project[] {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.projects)) return data.projects;
  return [data];
}

function main(): void {
  loadEnv();
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const onlyAt = args.indexOf("--only");
  const only = onlyAt > -1 ? args[onlyAt + 1] : "";
  const platAt = args.indexOf("--platforms");
  const platRaw = platAt > -1 ? args[platAt + 1] : "";
  const cliPlatforms: ("instagram" | "facebook" | "tiktok" | "youtube")[] = platRaw
    ? (platRaw.trim().toLowerCase() === "all"
        ? ["instagram", "facebook", "tiktok", "youtube"]
        : platRaw
            .split(/[,\s]+/)
            .map((p) => {
              const cleanP = p.trim().toLowerCase();
              return (codeToPlatform(cleanP) ?? cleanP) as any;
            })
            .filter((p) => p && PLATFORM_CODE[p as keyof typeof PLATFORM_CODE]))
    : [];

  const files = args.filter(
    (a, i) =>
      !a.startsWith("--") &&
      args[i - 1] !== "--only" &&
      args[i - 1] !== "--platforms"
  );
  if (!files.length) { console.error("usage: npm run batch -- <project.json | bundle.json> [...] [--only 11-20] [--platforms ig,yt | all] [--force]"); process.exit(1); }

  let projects = files.flatMap((f) => {
    const list = projectsIn(path.resolve(ROOT, f));
    return list.map((p, i) => ({ ...p, folder: folderFor(p, f, i, list.length) }));
  });
  if (only) {
    const [a, b] = only.split("-").map(Number);
    projects = projects.slice(a - 1, (b || a));
  }
  log("batch", `${projects.length} reel(s) to render`);

  const results: { slug: string; ok: boolean; seconds: number }[] = [];
  projects.forEach(({ folder, ...project }, i) => {
    const slug = folder;
    const dir = path.join(REELS, slug);
    const final = path.join(dir, "final.mp4");
    const plats = [
      ...new Set([
        ...(Array.isArray(project.platforms) ? project.platforms : []),
        ...cliPlatforms,
      ]),
    ].filter((p) => p && PLATFORM_CODE[p as keyof typeof PLATFORM_CODE]);

    const hasAllPlatformCuts =
      plats.length > 0 &&
      plats.every((p) => {
        const code = PLATFORM_CODE[p as keyof typeof PLATFORM_CODE];
        return code && fs.existsSync(path.join(dir, `final-${code}.mp4`));
      });

    if (!force && fs.existsSync(final) && (plats.length === 0 || hasAllPlatformCuts)) {
      log("batch", `${i + 1}/${projects.length} ${slug} — already rendered, skipping`);
      return;
    }
    ensureDir(dir);
    const clean = {
      ...project,
      ...(plats.length ? { platforms: plats } : {}),
      scenes: project.scenes.map((s, k) => ({ ...s, id: String(k + 1).padStart(2, "0") })),
    };
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify(clean, null, 2));
    console.log(`\n\x1b[35m━━━━ ${i + 1}/${projects.length}  ${project.title} ━━━━\x1b[0m`);
    const t0 = Date.now();
    try {
      execFileSync("npx", ["tsx", "scripts/pipeline.ts", "--project", path.join(dir, "project.json")], {
        cwd: ROOT, stdio: "inherit", env: { ...process.env, OUT_DIR: dir },
      });
      results.push({ slug, ok: true, seconds: (Date.now() - t0) / 1000 });
    } catch {
      warn("batch", `${slug} failed — continuing with the next reel`);
      results.push({ slug, ok: false, seconds: (Date.now() - t0) / 1000 });
    }
  });

  console.log("\n\x1b[35m━━━━ batch summary ━━━━\x1b[0m");
  for (const r of results) console.log(`  ${r.ok ? "\x1b[32m✔\x1b[0m" : "\x1b[31m✕\x1b[0m"} ${r.slug}  ${(r.seconds / 60).toFixed(1)} min`);
  const failed = results.filter((r) => !r.ok).length;
  log("batch", `${results.length - failed} rendered, ${failed} failed, ${projects.length - results.length} skipped`);
  process.exit(failed ? 1 : 0);
}

main();
