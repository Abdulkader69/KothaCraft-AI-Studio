import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DIRS, ROOT, env } from "../config";
import { download, ensureDir, escPath, ffmpeg, findFont, log, warn } from "../util";

export interface ImageJob {
  prompt: string;
  width: number;
  height: number;
  dest: string;
  index: number;
  style?: string;
  negative?: string;
  model?: string;
  seed?: number;
}

/** Offline stand-in so the whole pipeline runs with zero API keys. */
function placeholder(job: ImageJob): void {
  const palettes = [
    ["0x1b2a4a", "0x0b0f19"], ["0x3a1c34", "0x120a14"], ["0x14342b", "0x080f0d"],
    ["0x4a2f14", "0x140d06"], ["0x1f2c3a", "0x0a0e12"], ["0x37204a", "0x0f0a16"],
  ];
  const [c0, c1] = palettes[job.index % palettes.length];
  ensureDir(path.dirname(job.dest));
  const font = findFont();
  const filters = ["noise=alls=9:allf=t+u", "vignette=PI/4.5"];
  let textFile: string | null = null;

  if (font) {
    textFile = path.join(path.dirname(job.dest), `.${path.basename(job.dest)}.txt`);
    fs.writeFileSync(textFile, wrap(job.prompt, 26));
    filters.unshift(
      `drawtext=fontfile='${escPath(font)}':textfile='${escPath(textFile)}':fontcolor=white@0.86:` +
        `fontsize=${Math.round(job.width / 22)}:line_spacing=18:x=(w-text_w)/2:y=(h-text_h)/2`
    );
  } else {
    warn("images", "no usable font found — set FONT_FILE in .env to label placeholders");
  }

  ffmpeg([
    "-f", "lavfi",
    "-i", `gradients=s=${job.width}x${job.height}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${job.width}:y1=${job.height}:d=1`,
    "-frames:v", "1",
    "-vf", filters.join(","),
    job.dest,
  ], "placeholder-image");
  if (textFile) fs.unlinkSync(textFile);
}

function wrap(text: string, cols: number): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > cols) { lines.push(line.trim()); line = w; }
    else line += " " + w;
  }
  if (line.trim()) lines.push(line.trim());
  return lines.join("\n");
}

/** A malformed env value must not become NaN and serialise to JSON null. */
function intEnv(key: string, fallback: number, max: number): number {
  const n = Math.trunc(Number(env(key, "")));
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : fallback;
}

/** Stable per-prompt seed, so a re-run reproduces the same frame instead of a new one. */
function seedFrom(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) % 1_000_000;
}

let warnedNegative = false;

/** Providers return whatever size and format they like — land on the project frame as PNG. */
function normaliseToFrame(src: string, job: ImageJob, label: string): void {
  ensureDir(path.dirname(job.dest));
  ffmpeg([
    "-i", src,
    "-vf", `scale=${job.width}:${job.height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${job.width}:${job.height}`,
    "-frames:v", "1", job.dest,
  ], label);
  fs.rmSync(src, { force: true });
}

/**
 * SDXL is trained around one megapixel and wants multiples of 64. Asking for a
 * raw 1080x1920 gives duplicated limbs and stretched horizons, so request the
 * nearest sane bucket (9:16 lands on 768x1344) and let ffmpeg scale up after.
 */
function sdxlSize(width: number, height: number): { width: number; height: number } {
  const ratio = width / height;
  const round64 = (n: number) => Math.max(256, Math.min(2048, Math.round(n / 64) * 64));
  return { width: round64(Math.sqrt(1024 * 1024 * ratio)), height: round64(Math.sqrt((1024 * 1024) / ratio)) };
}

/**
 * Cloudflare Workers AI. Two model families behave differently:
 *   flux-1-schnell — prompt/steps/seed only, no size control, JSON {result:{image:<base64>}}
 *   stable-diffusion-xl — width/height/negative_prompt/num_steps, raw binary PNG
 * The response is sniffed by content-type rather than assumed, so either works.
 */
async function cloudflare(job: ImageJob): Promise<void> {
  const account = env("CF_ACCOUNT_ID");
  const token = env("CF_API_TOKEN");
  if (!account) throw new Error("CF_ACCOUNT_ID missing — find it on your Cloudflare dashboard URL");
  if (!token) throw new Error("CF_API_TOKEN missing — create one with the Workers AI permission");

  const model = env("CF_MODEL", "@cf/stabilityai/stable-diffusion-xl-base-1.0");
  const prompt = [job.prompt, job.style].filter(Boolean).join(", ");
  const seed = job.seed ?? intEnv("CF_SEED", seedFrom(prompt), 4294967295);
  const flux = /flux/i.test(model);

  const body: Record<string, unknown> = flux
    ? { prompt, seed, steps: intEnv("CF_STEPS", 4, 8) }
    : { prompt, seed, ...sdxlSize(job.width, job.height), num_steps: intEnv("CF_STEPS", 20, 20),
        ...(job.negative ? { negative_prompt: job.negative } : {}) };

  const name = path.basename(job.dest);

  // Workers AI throws occasional 5xx ("triton error running inference") that succeed
  // on a retry. Only server-side and network faults are retried — a 4xx is a real
  // problem with the request or the credentials and should surface immediately.
  let buf: Buffer | null = null;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/${model}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });

      const type = res.headers.get("content-type") ?? "";
      if (type.includes("application/json")) {
        const data = (await res.json()) as { success?: boolean; result?: { image?: string }; errors?: { message?: string }[] };
        if (!res.ok || data.success === false) {
          const why = data.errors?.map((e) => e.message).join("; ") || "request rejected";
          throw Object.assign(new Error(`cloudflare ${res.status}: ${why}`), { status: res.status });
        }
        if (!data.result?.image) throw new Error(`cloudflare returned no image for ${name}`);
        buf = Buffer.from(data.result.image, "base64");
      } else {
        if (!res.ok) {
          throw Object.assign(new Error(`cloudflare ${res.status}: ${(await res.text()).slice(0, 160)}`), { status: res.status });
        }
        buf = Buffer.from(await res.arrayBuffer());
      }
      if (buf.length < 1024) throw new Error(`cloudflare returned only ${buf.length} bytes for ${name}`);
      break;
    } catch (err: any) {
      const status = err?.status as number | undefined;
      const retryable = status === undefined || status >= 500 || status === 429;
      if (!retryable || attempt >= 3) throw err;
      warn("images", `${name} attempt ${attempt} failed (${err.message.slice(0, 90)}) — retrying`);
      await new Promise((r) => setTimeout(r, attempt * 5000));
    }
  }

  const tmp = path.join(ensureDir(DIRS.tmp), `cloudflare-${name}.bin`);
  fs.writeFileSync(tmp, buf);
  normaliseToFrame(tmp, job, `cloudflare-${name}`);

  if (flux && job.negative && !warnedNegative) {
    warnedNegative = true;
    warn("images", "flux-1-schnell takes no negative prompt or size — image.negative ignored, output cropped to frame");
  }
}

/**
 * Pollinations — free text-to-image with no key and no account.
 * It ignores the requested size (a 1080x1920 ask comes back 576x1024) and
 * returns JPEG, so the result is normalised to the project frame and re-encoded
 * as the PNG every later step reads. Deliberately does NOT use `image.model`,
 * which holds a fal-specific id like `fal-ai/flux/dev`.
 */
async function pollinations(job: ImageJob): Promise<void> {
  const prompt = [job.prompt, job.style].filter(Boolean).join(", ");
  const params = new URLSearchParams({
    width: String(job.width),
    height: String(job.height),
    nologo: "true",
    seed: String(job.seed ?? (env("POLLINATIONS_SEED") || seedFrom(prompt))),
  });
  const model = env("POLLINATIONS_MODEL");
  if (model) params.set("model", model);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?${params}`;

  const name = path.basename(job.dest);
  const tmp = path.join(ensureDir(DIRS.tmp), `pollinations-${name}.jpg`);

  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1024) throw new Error(`returned only ${buf.length} bytes`);
      fs.writeFileSync(tmp, buf);
      break;
    } catch (err: any) {
      const why = err?.message ?? String(err);
      // It is a free community service — rate limits and timeouts are routine.
      if (attempt >= 3) throw new Error(`pollinations failed for ${name} after 3 tries — ${why}`);
      warn("images", `${name} attempt ${attempt} failed (${why}) — retrying`);
      await new Promise((r) => setTimeout(r, attempt * 4000));
    }
  }

  normaliseToFrame(tmp, job, `pollinations-${name}`);

  if (job.negative && !warnedNegative) {
    warnedNegative = true;
    warn("images", "pollinations takes no negative prompt — image.negative is ignored");
  }
}

/** Where `npm run mflux:setup` puts things — kept inside the project so removal is exact. */
export const MFLUX_VENV = path.join(ROOT, ".venv-mflux");
export const MFLUX_STORE = path.join(ROOT, ".mflux");
export const mfluxInstalled = () => fs.existsSync(path.join(MFLUX_VENV, "bin", "mflux-generate-z-image-turbo"));

/**
 * mflux ships one CLI per model family, and the FLUX one refuses other
 * architectures (it goes looking for FLUX's second text encoder). Pick by name.
 */
export function mfluxCli(model: string): string {
  const m = model.toLowerCase();
  if (m.includes("z-image-turbo")) return "mflux-generate-z-image-turbo";
  if (m.includes("z-image")) return "mflux-generate-z-image";
  if (m.includes("krea")) return "mflux-generate-krea2";
  if (m.includes("flux.2") || m.includes("flux2")) return "mflux-generate-flux2";
  if (m.includes("qwen")) return "mflux-generate-qwen";
  return "mflux-generate"; // FLUX.1 schnell / dev
}

/**
 * Local generation on Apple Silicon via mflux. Free, offline, no rate limits,
 * and it honours the requested size. Default model is a pre-quantised 4-bit
 * Z-Image-Turbo (Apache-2.0), so nothing near the 24 GB full weights is pulled.
 * HF_HOME / MFLUX_CACHE_DIR are pinned to .mflux/ so weights never land in
 * ~/.cache and `mflux:remove` can delete precisely what `mflux:setup` added.
 */
function mflux(job: ImageJob): void {
  const model = env("MFLUX_MODEL", "filipstrand/Z-Image-Turbo-mflux-4bit");
  const bin = path.join(MFLUX_VENV, "bin", mfluxCli(model));
  if (!fs.existsSync(bin)) {
    throw new Error("mflux is not installed — run `npm run mflux:setup` (Apple Silicon only)");
  }
  const prompt = [job.prompt, job.style].filter(Boolean).join(", ");
  const seed = job.seed ?? intEnv("MFLUX_SEED", seedFrom(prompt), 4294967295);
  // Turbo/schnell models are distilled for few steps. Measured on an M3 Pro at
  // 768x1344: ~13 s per step, so 4 steps is ~65 s and 8 is ~2 min — and the
  // 4-step output is already sharp. More steps here is slower, not better.
  const steps = intEnv("MFLUX_STEPS", /turbo|schnell/i.test(model) ? 4 : 20, 50);
/**
 * Modern DiT models (FLUX, Z-Image, Qwen) handle arbitrary aspect ratios on multiples of 16.
 * Pick resolutions near 1–1.3 MP matching the exact aspect ratio so no pixels get cropped:
 *  - 9:16  -> 864x1536 (exact 9:16, 0 px cropped)
 *  - 16:9 -> 1536x864  (exact 16:9, 0 px cropped)
 *  - 1:1  -> 1024x1024 (exact 1:1,  0 px cropped)
 */
function mfluxSize(width: number, height: number): { width: number; height: number } {
  const ratio = width / height;
  if (Math.abs(ratio - 9 / 16) < 0.02) return { width: 864, height: 1536 };
  if (Math.abs(ratio - 16 / 9) < 0.02) return { width: 1536, height: 864 };
  if (Math.abs(ratio - 1) < 0.02) return { width: 1024, height: 1024 };
  const h = Math.round(Math.sqrt((1024 * 1024) / ratio) / 16) * 16;
  const w = Math.round((h * ratio) / 16) * 16;
  return { width: w, height: h };
}

  // Generate on multiples of 16 with exact project aspect ratio, then scale to frame.
  const { width: w, height: h } = mfluxSize(job.width, job.height);

  const name = path.basename(job.dest);
  const tmp = path.join(ensureDir(DIRS.tmp), `mflux-${name}`);
  const args = [
    "--model", model, "--prompt", prompt,
    "--width", String(w), "--height", String(h),
    "--steps", String(steps), "--seed", String(seed),
    "--output", tmp,
  ];
  const started = Date.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      execFileSync(bin, args, {
        cwd: ROOT,
        stdio: ["ignore", "ignore", "pipe"],
        env: { ...process.env, HF_HOME: path.join(MFLUX_STORE, "hf"), MFLUX_CACHE_DIR: path.join(MFLUX_STORE, "cache") },
      });
      break;
    } catch (err: any) {
      const stderr = (err?.stderr?.toString() ?? "").trim();
      const isMetalError = /monolithic_metal|Unable to build metal library/i.test(stderr);
      if (isMetalError && attempt === 1) {
        warn("images", "macOS Metal shader cache corrupted — auto-cleaning cache and retrying");
        try {
          const darwinCache = execFileSync("getconf", ["DARWIN_USER_CACHE_DIR"], { encoding: "utf8" }).trim();
          if (darwinCache) {
            const metalFe = path.join(darwinCache, "org.python.python", "com.apple.metalfe");
            fs.rmSync(metalFe, { recursive: true, force: true });
          }
        } catch {}
        continue;
      }
      const summary = stderr.split("\n").slice(-8).join("\n");
      throw new Error(`mflux failed for ${name}\n${summary || "no error output"}\n\nmodel: ${model}`);
    }
  }
  if (!fs.existsSync(tmp) || fs.statSync(tmp).size < 1024) throw new Error(`mflux produced no image for ${name}`);
  log("images", `${name} ${w}x${h} in ${((Date.now() - started) / 1000).toFixed(0)}s (local)`);
  normaliseToFrame(tmp, job, `mflux-${name}`);
  if (job.negative && !warnedNegative) {
    warnedNegative = true;
    warn("images", "mflux takes no negative prompt — image.negative ignored (keep 'no people' in the prompt itself)");
  }
}

/** fal.ai — works with any text-to-image model id, e.g. fal-ai/flux/dev */
async function fal(job: ImageJob): Promise<void> {
  const key = env("FAL_KEY");
  if (!key) throw new Error("FAL_KEY missing in .env");
  const model = job.model ?? "fal-ai/flux/dev";
  const res = await fetch(`https://fal.run/${model}`, {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt: [job.prompt, job.style].filter(Boolean).join(", "),
      negative_prompt: job.negative,
      image_size: { width: job.width, height: job.height },
      num_images: 1,
    }),
  });
  if (!res.ok) throw new Error(`fal ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { images: { url: string }[] };
  await download(data.images[0].url, job.dest);
}

/** OpenAI images endpoint (returns base64). */
async function openai(job: ImageJob): Promise<void> {
  const key = env("OPENAI_API_KEY");
  if (!key) throw new Error("OPENAI_API_KEY missing in .env");
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: job.model ?? "gpt-image-1",
      prompt: [job.prompt, job.style].filter(Boolean).join(", "),
      size: job.height > job.width ? "1024x1536" : job.width > job.height ? "1536x1024" : "1024x1024",
      n: 1,
    }),
  });
  if (!res.ok) throw new Error(`openai ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { data: { b64_json?: string; url?: string }[] };
  const item = data.data[0];
  ensureDir(path.dirname(job.dest));
  if (item.b64_json) fs.writeFileSync(job.dest, Buffer.from(item.b64_json, "base64"));
  else await download(item.url!, job.dest);
}

export async function generateImage(job: ImageJob): Promise<void> {
  const provider = env("IMAGE_PROVIDER", "placeholder");
  log("images", `${path.basename(job.dest)} via ${provider}`);
  if (provider === "mflux") return mflux(job);
  if (provider === "cloudflare") return cloudflare(job);
  if (provider === "pollinations") return pollinations(job);
  if (provider === "fal") return fal(job);
  if (provider === "openai") return openai(job);
  return placeholder(job);
}
