/**
 * Step 10 — Poster / cover image
 * 01-images/<scene>.png + title -> out/poster.png (reel aspect), poster-1x1.png, poster-16x9.png
 *
 * The still gets the reel's grade, a dark gradient under the text, the title (and an
 * optional tagline) through libass so Bangla shapes like the captions, and the same
 * watermark as the video. Runs at the end of the pipeline and on its own from the UI.
 */
import fs from "node:fs";
import path from "node:path";
import { DIRS, POSTER, dims, loadEnv, loadProject } from "../src/config";
import { buildBrand } from "../src/brand";
import type { Project } from "../src/types";
import { defaultFontName, ensureDir, escPath, ffmpeg, log, warn } from "../src/util";
import { assColor, stamp, trackingFor } from "../src/ass";

const SIZES: Record<string, { w: number; h: number }> = {
  "1x1": { w: 1080, h: 1080 },
  "16x9": { w: 1280, h: 720 },
};

/** ASS for one still: title low in the frame, tagline under it. */
function writeAss(project: Project, w: number, h: number, dest: string): void {
  const c = project.captions ?? {};
  const title = (project.poster?.text ?? "").trim() || project.title;
  const tagline = (project.poster?.tagline ?? "").trim();
  const font = c.fontName ?? defaultFontName();
  const spacing = trackingFor(title + tagline);
  const primary = assColor(c.primary ?? "#FFFFFF");
  const accent = assColor(c.highlight ?? "#FFD166");
  const outline = assColor(c.outline ?? "#000000");
  const wide = w > h;
  // Wide posters (YouTube) read left-aligned; tall and square ones centred.
  const align = wide ? 1 : 2;
  const titleSize = Math.round((wide ? h / 7 : w / 9));
  const tagSize = Math.round(titleSize * 0.42);
  const marginV = Math.round(h * (wide ? 0.10 : 0.12));
  const marginH = Math.round(w * 0.08);
  const esc = (t: string) => t.replace(/[{}]/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join("\\N");
  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${w}`, `PlayResY: ${h}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Title,${font},${titleSize},${primary},&H000000FF,${outline},&H80000000,-1,0,0,0,100,100,${spacing},0,1,${Math.max(2, Math.round(titleSize / 18))},3,${align},${marginH},${marginH},${marginV + (tagline ? Math.round(tagSize * 1.6) : 0)},1`,
    `Style: Tag,${font},${tagSize},${accent},&H000000FF,${outline},&H80000000,0,0,0,0,100,100,${spacing},0,1,2,2,${align},${marginH},${marginH},${marginV},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,${stamp(0)},${stamp(10)},Title,,0,0,0,,${esc(title)}`,
    ...(tagline ? [`Dialogue: 0,${stamp(0)},${stamp(10)},Tag,,0,0,0,,${esc(tagline)}`] : []),
  ];
  fs.writeFileSync(dest, lines.join("\n"));
}

function renderOne(project: Project, still: string, w: number, h: number, dest: string, label: string): void {
  const t = project.texture ?? {};
  const ass = path.join(DIRS.tmp, `poster-${label}.ass`);
  writeAss(project, w, h, ass);
  const brand = buildBrand(project, { width: w, height: h, logoInput: 1, captions: false, scale: w / 1080 }, "poster");

  // Blurred fill behind a fitted copy, so a vertical still becomes a wide thumbnail
  // without a brutal crop. When the aspect matches, the fitted copy covers the fill.
  const graph =
    `[0:v]split=2[a][b];` +
    `[a]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},gblur=sigma=30,eq=brightness=-0.15[bg];` +
    `[b]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,` +
    `eq=contrast=${t.contrast ?? 1.05}:saturation=${t.saturation ?? 1.02},vignette=angle=PI/4.5,` +
    // dark ramp over the lower 55% so the title reads on any image
    `format=rgba,geq=r='r(X,Y)*(1-0.75*clip((Y-H*0.45)/(H*0.55),0,1))':g='g(X,Y)*(1-0.75*clip((Y-H*0.45)/(H*0.55),0,1))':b='b(X,Y)*(1-0.75*clip((Y-H*0.45)/(H*0.55),0,1))':a=255,format=yuv420p,` +
    `ass=${escPath(ass)}[base];` +
    (brand ? brand.filter : "[base]null") + `[v]`;

  ffmpeg(["-i", still, ...(brand?.inputs ?? []), "-filter_complex", graph, "-map", "[v]", "-frames:v", "1", dest], `poster-${label}`);
  log("poster", `${path.basename(dest)}  ${w}x${h}`);
}

function main() {
  loadEnv();
  const project = loadProject();
  const sceneId = (project.poster?.scene ?? "").trim() || project.scenes[0].id;
  const still = path.join(DIRS.images, `${sceneId}.png`);
  if (!fs.existsSync(still)) { warn("poster", `no image for scene ${sceneId} — run render:images first`); return; }
  ensureDir(DIRS.tmp);

  const { width, height } = dims(project);
  renderOne(project, still, width, height, POSTER(), "main");
  for (const [size, d] of Object.entries(SIZES)) {
    if (d.w === width && d.h === height) continue;
    renderOne(project, still, d.w, d.h, POSTER(size), size);
  }
}

main();
