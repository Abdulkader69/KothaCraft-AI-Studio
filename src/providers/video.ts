/**
 * Image-to-video — a still becomes a short clip with real motion (mist drifting,
 * light flickering, a slow camera move). Remote only: nothing lives on this
 * machine but the API key. Contract: read a PNG, write an MP4 of roughly
 * `seconds` length; render:motion fits it to the timeline afterwards.
 *
 *   VIDEO_PROVIDER=fal      fal.ai queue API, default model Wan 2.2 (5B) image-to-video
 *   VIDEO_MODEL=…           any fal image-to-video endpoint with the same input shape
 *   VIDEO_PROVIDER=local    Wan 2.2 TI2V-5B on this Mac via mlx-video (npm run wan:setup)
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ROOT, env } from "../config";
import { download, ensureDir, log } from "../util";

export const WAN_VENV = path.join(ROOT, ".venv-wan");
export const WAN_STORE = path.join(ROOT, ".wan");
export const WAN_MODEL = path.join(WAN_STORE, "Wan2.2-TI2V-5B-MLX");
export const wanInstalled = () => fs.existsSync(path.join(WAN_VENV, "bin", "python")) && fs.existsSync(path.join(WAN_MODEL, "config.json"));

export const LTX2_BIN = path.join(WAN_VENV, "bin", "ltx-2-mlx");
export const LTX2_MODEL = path.join(ROOT, "models", "ltx-2.3-mlx-q8");
export const LTX2_CACHE = path.join(ROOT, ".hf_cache");
export const ltx2Installed = () => fs.existsSync(LTX2_BIN) && fs.existsSync(path.join(LTX2_MODEL, "transformer-distilled-1.1.safetensors"));


export interface VideoJob {
  image: string;             // source still
  prompt: string;            // what should move
  dest: string;              // .mp4
  width: number;
  height: number;
  seconds: number;           // requested clip length (the model rounds to its frame grid)
  seed?: number;
  negative?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** fal's queue: submit, poll until COMPLETED, fetch the result. */
async function fal(job: VideoJob): Promise<void> {
  const key = env("FAL_KEY");
  if (!key) throw new Error("FAL_KEY missing in .env — needed for generated motion (motion: \"ai\")");
  const model = env("VIDEO_MODEL", "fal-ai/wan/v2.2-5b/image-to-video");
  const headers = { Authorization: `Key ${key}`, "Content-Type": "application/json" };
  const fps = 24;
  // Wan 2.2 takes 17–161 frames; 5 s at 24 fps is the sweet spot for cost vs. fit.
  const frames = Math.max(17, Math.min(161, Math.round(job.seconds * fps) + 1));
  const aspect = job.width === job.height ? "1:1" : job.height > job.width ? "9:16" : "16:9";
  // A data URI keeps this a single call — no separate upload step.
  const image = `data:image/png;base64,${fs.readFileSync(job.image).toString("base64")}`;

  const submit = await fetch(`https://queue.fal.run/${model}`, {
    method: "POST", headers,
    body: JSON.stringify({
      image_url: image,
      prompt: job.prompt,
      negative_prompt: job.negative ?? "",
      num_frames: frames,
      frames_per_second: fps,
      resolution: "720p",
      aspect_ratio: aspect,
      ...(job.seed !== undefined ? { seed: job.seed } : {}),
    }),
  });
  if (!submit.ok) throw new Error(`fal ${submit.status}: ${(await submit.text()).slice(0, 300)}`);
  const { request_id, status_url, response_url } = (await submit.json()) as { request_id: string; status_url: string; response_url: string };
  log("video", `${model.split("/").slice(1).join("/")} queued (${frames} frames @ ${fps} fps)`);

  const started = Date.now();
  for (;;) {
    await sleep(3000);
    const st = await fetch(status_url, { headers });
    if (!st.ok) throw new Error(`fal status ${st.status}: ${(await st.text()).slice(0, 200)}`);
    const s = (await st.json()) as { status: string; queue_position?: number; error?: string };
    if (s.status === "COMPLETED") break;
    if (s.error) throw new Error(`fal: ${s.error}`);
    if (Date.now() - started > 15 * 60_000) throw new Error(`fal: request ${request_id} still not done after 15 min`);
  }
  const out = await fetch(response_url, { headers });
  if (!out.ok) throw new Error(`fal result ${out.status}: ${(await out.text()).slice(0, 300)}`);
  const data = (await out.json()) as { video?: { url: string }; error?: string; detail?: unknown };
  if (!data.video?.url) throw new Error(`fal returned no video: ${JSON.stringify(data).slice(0, 200)}`);
  await download(data.video.url, job.dest);
  log("video", `clip ready in ${((Date.now() - started) / 1000).toFixed(0)}s`);
}

/**
 * Wan 2.2 TI2V-5B through mlx-video, fully offline. The model loads for the clip
 * and is released when the process exits — nothing stays resident. Native
 * resolution is 704×1280 (or 1280×704); frames must be 4n+1. About 2–5 minutes
 * a clip on an M3 Pro, so the default asks for ~3.4 s and lets render:motion
 * stretch it.
 */
function local(job: VideoJob): void {
  if (!wanInstalled()) throw new Error("local video model not installed — run `npm run wan:setup` (~21 GB), or set VIDEO_PROVIDER=fal");
  const portrait = job.height > job.width, square = job.height === job.width;
  const w = square ? 704 : portrait ? 704 : 1280, h = square ? 704 : portrait ? 1280 : 704;
  const fps = 24;
  const want = Math.round(Number(env("VIDEO_LOCAL_SECONDS", String(job.seconds))) * fps);
  const frames = Math.max(5, Math.min(121, 4 * Math.round((want - 1) / 4) + 1));   // 4n+1
  const steps = env("VIDEO_LOCAL_STEPS", "30");
  ensureDir(path.dirname(job.dest));
  log("video", `wan 2.2 5B local: ${frames} frames @ ${fps} fps, ${w}x${h}, ${steps} steps — a few minutes`);
  const args = [
    "-m", "mlx_video.models.wan_2.generate",
    "--model-dir", WAN_MODEL, "--image", job.image, "--prompt", job.prompt,
    "--width", String(w), "--height", String(h), "--num-frames", String(frames),
    "--steps", steps, "--seed", String(job.seed ?? Math.floor(Math.random() * 1_000_000)),
    "--output-path", job.dest,
    ...(job.negative ? ["--negative-prompt", job.negative] : []),
  ];
  try {
    execFileSync(path.join(WAN_VENV, "bin", "python"), args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, HF_HUB_OFFLINE: "1" },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err: any) {
    const tail = (err?.stderr?.toString() ?? "").trim().split("\n").slice(-8).join("\n");
    throw new Error(`local video failed for ${path.basename(job.image)}\n${tail}`);
  }
  if (!fs.existsSync(job.dest) || fs.statSync(job.dest).size < 10_000) throw new Error(`local video produced no clip for ${path.basename(job.image)}`);
}

function localLtx2(job: VideoJob): void {
  if (!ltx2Installed()) {
    throw new Error("LTX-2 model not found — verify models/ltx-2.3-mlx-q8 on Mac Drive");
  }
  const fps = 24;
  const wantFrames = Math.round(Number(env("VIDEO_LOCAL_SECONDS", String(job.seconds))) * fps);
  const k = Math.max(3, Math.min(15, Math.round((wantFrames - 1) / 8)));
  const frames = 8 * k + 1; // 25, 33, 41, 49, ..., 121
  const portrait = job.height > job.width;
  const w = portrait ? 448 : 704;
  const h = portrait ? 704 : 448;
  ensureDir(path.dirname(job.dest));
  log("video", `LTX-2.3 Q8 local: ${frames} frames (~${(frames / fps).toFixed(1)}s) @ ${fps} fps, ${w}x${h}`);
  const args = [
    "generate",
    "--model", LTX2_MODEL,
    "--text-encoder", "mlx-community/gemma-3-12b-it-4bit",
    "--prompt", job.prompt,
    "--distilled",
    "--low-ram",
    "--audio",
    "-f", String(frames),
    "--frame-rate", String(fps),
    "--width", String(w),
    "--height", String(h),
    "-o", job.dest,
    ...(job.image ? ["--image", job.image] : []),
    ...(job.seed !== undefined ? ["--seed", String(job.seed)] : []),
  ];
  try {
    execFileSync(LTX2_BIN, args, {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        ...process.env,
        HF_HOME: LTX2_CACHE,
        HUGGINGFACE_HUB_CACHE: path.join(LTX2_CACHE, "hub"),
        HF_HUB_OFFLINE: "1",
      },
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err: any) {
    const tail = (err?.stderr?.toString() ?? "").trim().split("\n").slice(-8).join("\n");
    throw new Error(`LTX-2 video generation failed:\n${tail}`);
  }
  if (!fs.existsSync(job.dest) || fs.statSync(job.dest).size < 10_000) {
    throw new Error(`LTX-2 produced no clip for ${path.basename(job.dest)}`);
  }
}

export async function generateClip(job: VideoJob): Promise<void> {
  const provider = env("VIDEO_PROVIDER", "ltx2");
  if (provider === "fal") return fal(job);
  if (provider === "local" || provider === "wan") return local(job);
  if (provider === "ltx2" || provider === "ltx") return localLtx2(job);
  throw new Error(`unknown VIDEO_PROVIDER=${provider} — use "ltx2", "local" (wan), or "fal"`);
}

