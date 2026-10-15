/**
 * Step 3 — Motion & Texture (grade, grain, vignette, optional overlay)
 * out/02-motion/<id>.mp4 -> out/03-texture/<id>.mp4
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, ROOT, dims, hasFlag, loadEnv, loadProject } from "../src/config";
import { ensureDir, ffmpeg, log, probeDuration, skippableClip, warn } from "../src/util";

function main() {
  loadEnv();
  const project = loadProject();
  const { width, height } = dims(project);
  const t = project.texture ?? {};
  const grain = t.grain ?? 7;
  const vignette = t.vignette ?? 4.5;
  const force = hasFlag("force");
  const overlay = t.overlay ? path.join(ROOT, t.overlay) : null;
  const hasOverlay = !!overlay && fs.existsSync(overlay);
  ensureDir(DIRS.texture);

  const grade = [
    `eq=contrast=${t.contrast ?? 1.06}:saturation=${t.saturation ?? 1.08}`,
    "unsharp=5:5:0.5:5:5:0.0",
    `noise=alls=${grain}:allf=t+u`,
    `vignette=PI/${vignette}`,
  ].join(",");

  for (const scene of project.scenes) {
    const src = path.join(DIRS.motion, `${scene.id}.mp4`);
    const dest = path.join(DIRS.texture, `${scene.id}.mp4`);
    if (!fs.existsSync(src)) { warn("texture", `missing clip for ${scene.id}`); continue; }
    if (skippableClip(dest, force, probeDuration(src))) { log("texture", `${scene.id} cached`); continue; }

    const args = hasOverlay
      ? ["-i", src, "-i", overlay!, "-filter_complex",
         `[1:v]scale=${width}:${height},format=gbrp[t];[0:v]${grade}[base];[base][t]blend=all_mode=overlay:all_opacity=0.22,format=yuv420p[v]`,
         "-map", "[v]"]
      : ["-i", src, "-vf", grade];

    ffmpeg([...args, "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-pix_fmt", "yuv420p", dest], `texture-${scene.id}`);
    log("texture", `${scene.id} graded${hasOverlay ? " + overlay" : ""}`);
  }
}

main();
