/**
 * Watermark filter shared by `master` (on the video) and `render:poster` (on a still).
 * Returns the extra ffmpeg input (for a logo) and a filter that reads `[base]` and
 * leaves the result unlabeled, so the caller appends its own `[out]`.
 */
import fs from "node:fs";
import path from "node:path";
import { BRAND_DEFAULT, DIRS, PLAT, ROOT } from "./config";
import { codeToPlatform, safeArea } from "./safe";
import type { Project } from "./types";
import { escPath, findFont, warn } from "./util";

export interface BrandFilter { inputs: string[]; filter: string; label: string }

export interface BrandFrame {
  width: number;
  height: number;
  /** ffmpeg input index the logo will get (number of inputs before it). */
  logoInput: number;
  /** false on a poster — no caption band to clear at the bottom. */
  captions?: boolean;
  /** Scale factor for size/margin, so a 1:1 poster keeps the same proportions as 9:16. */
  scale?: number;
}

export function buildBrand(project: Project, frame: BrandFrame, step = "master"): BrandFilter | null {
  const b = project.brand ?? BRAND_DEFAULT;
  if (!b || (b as { off?: boolean }).off) return null;
  const k = frame.scale ?? 1;
  const pos = b.position ?? "top-right";
  const alpha = Math.min(1, Math.max(0, b.opacity ?? 0.85));
  const right = pos.endsWith("right"), bottom = pos.startsWith("bottom");
  // Margin from the edge, pushed inward past the platform's own UI on that side.
  const safe = safeArea((PLAT && codeToPlatform(PLAT)) || project.platform, frame.width, frame.height);
  const base = Math.max(0, Math.round((b.margin ?? 64) * k));
  const mx = base + (right ? safe.right : safe.left);
  let my = base + (bottom ? safe.bottom : safe.top);
  // Bottom corners share the edge with the caption band — sit above it.
  const c = project.captions ?? {};
  const captionsAtBottom = frame.captions !== false && c.show !== false && (c.style ?? "highlight") !== "word";
  if (bottom && captionsAtBottom) {
    const size = c.fontSize ?? Math.round(frame.width / 16);
    my = Math.max(my, (c.marginV ?? Math.max(Math.round(frame.height * 0.16), safe.bottom + 40)) + Math.round(size * 1.7));
  }

  const image = b.image ? path.resolve(ROOT, b.image) : "";
  if (image) {
    if (!fs.existsSync(image)) { warn(step, `brand image not found: ${b.image} — skipping watermark`); return null; }
    const w = Math.max(16, Math.round((b.size ?? 140) * k));
    // overlay: W/H are the frame, w/h the logo
    const x = right ? `W-w-${mx}` : `${mx}`, y = bottom ? `H-h-${my}` : `${my}`;
    return {
      inputs: ["-i", image],
      filter: `[${frame.logoInput}:v]scale=${w}:-1:flags=lanczos,format=rgba,colorchannelmixer=aa=${alpha}[wm];[base][wm]overlay=x=${x}:y=${y}:format=auto`,
      label: `image ${b.image}`,
    };
  }

  const text = (b.text ?? "").trim();
  if (!text) return null;
  // A text file sidesteps drawtext's escaping rules for ':' '%' and quotes.
  fs.mkdirSync(DIRS.tmp, { recursive: true });
  const textfile = path.join(DIRS.tmp, "brand.txt");
  fs.writeFileSync(textfile, text);
  const font = findFont();
  if (!font) warn(step, "no font file found for the brand text — set FONT_FILE");
  const size = Math.max(8, Math.round((b.size ?? 36) * k));
  // drawtext: w/h are the frame, tw/th the rendered text
  const x = right ? `w-tw-${mx}` : `${mx}`, y = bottom ? `h-th-${my}` : `${my}`;
  const color = (b.color ?? "white").replace(/[^#\w]/g, "");
  return {
    inputs: [],
    filter: `[base]drawtext=textfile=${escPath(textfile)}${font ? `:fontfile=${escPath(font)}` : ""}` +
      `:fontsize=${size}:fontcolor=${color}@${alpha}:shadowcolor=black@${(alpha * 0.6).toFixed(2)}:shadowx=2:shadowy=2:x=${x}:y=${y}`,
    label: `text "${text}"`,
  };
}
