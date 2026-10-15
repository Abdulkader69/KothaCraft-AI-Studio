/**
 * Photo cards — a JSON card set -> one finished PNG per card.
 *
 *   npm run cards -- --project content/cards/demo.json
 *   npm run cards -- --project content/cards/demo.json --reroll 02   # new background for card 02
 *
 * Each card: a generated background (cached in 01-images/<id>.png, same providers as
 * the reels), dimmed or ramped for legibility, the text and source through libass so
 * Bangla shapes correctly, an optional small heading, and the watermark.
 * Output: <OUT_DIR>/<id>.png
 */
import fs from "node:fs";
import path from "node:path";
import { BRAND_DEFAULT, DIRS, OUT, cardDims, hasFlag, loadCardSet, loadEnv } from "../src/config";
import { assColor, stamp, trackingFor } from "../src/ass";
import { buildBrand } from "../src/brand";
import { generateImage } from "../src/providers/images";
import type { Card, CardSet, Project } from "../src/types";
import { defaultFontName, ensureDir, escPath, ffmpeg, log, skippable, warn } from "../src/util";

function rerollTargets(): Set<string> | null | undefined {
  const i = process.argv.indexOf("--reroll");
  if (i === -1) return undefined;
  const arg = process.argv[i + 1];
  return !arg || arg.startsWith("--") ? null : new Set(arg.split(",").map((s) => s.trim()).filter(Boolean));
}

/** Longer messages get a smaller face so they still fit in a few lines. */
function textSize(text: string, w: number): number {
  const n = text.replace(/\s+/g, " ").trim().length;
  const div = n <= 40 ? 9 : n <= 90 ? 11.5 : n <= 160 ? 14 : n <= 260 ? 17 : 20;
  return Math.round(w / div);
}

function writeAss(set: CardSet, card: Card, w: number, h: number, dest: string): void {
  const c = set.captions ?? {};
  const layout = card.layout ?? set.layout ?? "center";
  const font = c.fontName ?? defaultFontName();
  const primary = assColor(c.primary ?? "#FFFFFF");
  const accent = assColor(c.highlight ?? "#EBCB80");
  const outline = assColor(c.outline ?? "#000000");
  const text = card.text.trim();
  const source = (card.source ?? "").trim();
  const heading = (card.heading ?? set.heading ?? "").trim();
  const spacing = trackingFor(text + source + heading);
  const esc = (t: string) => t.replace(/[{}]/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean).join("\\N");

  const size = textSize(text, w);
  const srcSize = Math.round(size * 0.5);
  const headSize = Math.round(w / 26);
  const mh = Math.round(w * 0.09);
  // One block: the message, then the source a line below in the accent colour, so
  // they stay together whether the block is centred (5) or bottom-anchored (2).
  const align = layout === "center" ? 5 : 2;
  const textMarginV = layout === "center" ? 0 : Math.round(h * 0.10);
  const body = esc(text) + (source ? `\\N{\\fs${Math.round(srcSize * 0.6)}} \\N{\\fs${srcSize}\\c${accent}\\b0\\bord2}${esc(source)}` : "");

  const lines = [
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${w}`, `PlayResY: ${h}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Text,${font},${size},${primary},&H000000FF,${outline},&H80000000,-1,0,0,0,100,100,${spacing},0,1,${Math.max(2, Math.round(size / 20))},2,${align},${mh},${mh},${textMarginV},1`,
    `Style: Heading,${font},${headSize},${accent},&H000000FF,${outline},&H80000000,-1,0,0,0,100,100,${spacing},0,1,2,1,8,${mh},${mh},${Math.round(h * 0.07)},1`,
    "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    `Dialogue: 0,${stamp(0)},${stamp(10)},Text,,0,0,0,,${body}`,
    ...(heading ? [`Dialogue: 0,${stamp(0)},${stamp(10)},Heading,,0,0,0,,${esc(heading)}`] : []),
  ];
  fs.writeFileSync(dest, lines.join("\n"));
}

function compose(set: CardSet, card: Card, bg: string, w: number, h: number, dest: string): void {
  const layout = card.layout ?? set.layout ?? "center";
  const ass = path.join(DIRS.tmp, `card-${card.id}.ass`);
  writeAss(set, card, w, h, ass);
  // The watermark builder reads brand/platform/captions off a Project shape.
  // Cards carry a heading at the top, so the default watermark goes bottom right here.
  const asProject = { brand: set.brand ?? { ...BRAND_DEFAULT, position: "bottom-right" }, captions: { show: false }, scenes: [] } as unknown as Project;
  const brand = buildBrand(asProject, { width: w, height: h, logoInput: 1, captions: false, scale: w / 1080 }, "cards");

  const legibility = layout === "center"
    ? `eq=brightness=-0.28:saturation=0.9`                                   // even dim, text anywhere
    : `format=rgba,geq=r='r(X,Y)*(1-0.8*clip((Y-H*0.4)/(H*0.6),0,1))':g='g(X,Y)*(1-0.8*clip((Y-H*0.4)/(H*0.6),0,1))':b='b(X,Y)*(1-0.8*clip((Y-H*0.4)/(H*0.6),0,1))':a=255,format=yuv420p`;
  const graph =
    `[0:v]scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h},` +
    `${legibility},vignette=angle=PI/5,ass=${escPath(ass)}[base];` +
    (brand ? brand.filter : "[base]null") + `[v]`;
  ffmpeg(["-i", bg, ...(brand?.inputs ?? []), "-filter_complex", graph, "-map", "[v]", "-frames:v", "1", dest], `card-${card.id}`);
}

async function main() {
  loadEnv();
  const set = loadCardSet();
  const { width, height } = cardDims(set);
  const force = hasFlag("force");
  const reroll = rerollTargets();
  ensureDir(DIRS.images); ensureDir(DIRS.tmp);

  for (const [index, card] of set.cards.entries()) {
    const bg = path.join(DIRS.images, `${card.id}.png`);
    const prompt = (card.prompt ?? set.prompt ?? "").trim();
    const rerollThis = reroll !== undefined && (reroll === null || reroll.has(card.id));
    if (!skippable(bg, force || rerollThis)) {
      if (!prompt) { warn("cards", `${card.id}: no prompt and no cached background — skipping`); continue; }
      const seed = rerollThis ? Math.floor(Math.random() * 1_000_000) : card.seed;
      await generateImage({ prompt, style: set.image?.style, negative: set.image?.negative, model: set.image?.model, width, height, dest: bg, index, seed });
      if (rerollThis) log("cards", `${card.id} rolled seed ${seed} — keep it with "seed": ${seed}`);
    }
    const dest = path.join(OUT, `${card.id}.png`);
    compose(set, card, bg, width, height, dest);
    log("cards", `${card.id}  ${path.basename(dest)}  ${width}x${height}`);
  }
  log("cards", `${set.cards.length} card(s) in ${OUT}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
