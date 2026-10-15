/**
 * Background loop generator
 * scripts/bg/scene.html -> assets/bg/<name>.mp4
 *
 * Draws the scene in headless Chrome, one frame per step of the loop phase, and
 * pipes the PNGs straight into ffmpeg. Nothing is written to disk between the
 * two, and no npm package is involved: Chrome is driven over the DevTools
 * Protocol through Node's built-in WebSocket (Node 22+).
 *
 * The naive route — one `chrome --screenshot` per frame — costs ~2s a frame, so
 * a ten second loop would take ten minutes. Holding one browser open and asking
 * it for frames costs ~40ms each instead.
 *
 * The scene is a pure function of phase t (0 <= t < 1), so the clip loops: the
 * frame after the last one is the first one. Frames are rendered at t = i/N,
 * never i/(N-1), or the loop would hold one duplicate frame at the seam.
 *
 *   npm run render:bg -- --theme ramadan-gold --seconds 12
 *   npm run render:bg -- --seconds 12 --out assets/bg/night-mosque.mp4
 *   npm run render:bg -- --still            # one PNG, for checking the art
 *   npm run render:bg -- --still --phase 0.5
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT } from "../src/config";
import { ensureDir, log, warn } from "../src/util";

const THEME_DIR = path.join(ROOT, "scripts", "bg", "themes");

function themeNames(): string[] {
  if (!fs.existsSync(THEME_DIR)) return [];
  return fs.readdirSync(THEME_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, "")).sort();
}

/** Chrome ships under a different name on every machine — take the first that exists. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH ?? "",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
];

function findChrome(): string {
  const found = CHROME_CANDIDATES.find((c) => c && fs.existsSync(c));
  if (!found) throw new Error("no Chrome found — install Google Chrome, or set CHROME_PATH in .env");
  return found;
}

const argValue = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const argFlag = (name: string) => process.argv.includes(`--${name}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── DevTools Protocol over the built-in WebSocket ────────────────────────────
class CDP {
  private socket: WebSocket;
  private id = 0;
  private pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.onmessage = (event) => {
      const msg = JSON.parse(String(event.data));
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;                      // an event, not a reply
      this.pending.delete(msg.id);
      if (msg.error) waiter.fail(new Error(`${msg.error.message} (${msg.error.code})`));
      else waiter.ok(msg.result);
    };
  }

  static connect(url: string): Promise<CDP> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => resolve(new CDP(socket));
      socket.onerror = () => reject(new Error(`could not open a DevTools socket at ${url}`));
    });
  }

  send<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.id;
    return new Promise<T>((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close(): void {
    try { this.socket.close(); } catch {}
  }
}

/** Chrome writes the port it actually took into the profile dir once it is up. */
async function waitForPort(profileDir: string, timeoutMs = 20000): Promise<number> {
  const file = path.join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) {
      const port = parseInt(fs.readFileSync(file, "utf8").split("\n")[0], 10);
      if (Number.isFinite(port)) return port;
    }
    await sleep(120);
  }
  throw new Error("Chrome never reported a debugging port");
}

async function pageSocket(port: number, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets: any[] = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(120);
  }
  throw new Error("Chrome exposed no page target");
}

/** Back-pressure matters: 300 uncompressed PNGs will outrun ffmpeg's stdin buffer. */
function write(stream: NodeJS.WritableStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve) => {
    if (stream.write(chunk)) resolve();
    else stream.once("drain", () => resolve());
  });
}

async function main() {
  const width = parseInt(argValue("width", "720"), 10);
  const height = parseInt(argValue("height", "1280"), 10);
  const fps = parseInt(argValue("fps", "30"), 10);
  const seconds = parseFloat(argValue("seconds", "10"));
  const seed = parseInt(argValue("seed", "7"), 10);
  const still = argFlag("still");
  const phase = parseFloat(argValue("phase", "0"));   // --still only: which point of the loop
  const scene = path.resolve(ROOT, argValue("scene", "scripts/bg/scene.html"));
  const theme = argValue("theme", "");
  // Naming the theme is enough to name the file — one less flag to keep in sync.
  const defaultOut = still
    ? `assets/bg/${theme || "still"}.png`
    : `assets/bg/${theme || "night-mosque"}.mp4`;
  const out = path.resolve(ROOT, argValue("out", defaultOut));

  if (!fs.existsSync(scene)) throw new Error(`no scene at ${scene}`);
  ensureDir(path.dirname(out));

  // Layered over the scene's own DEFAULTS: theme first, then --config, then
  // anything named explicitly on the command line.
  let sceneConfig: Record<string, any> = {};

  if (theme) {
    const file = path.join(THEME_DIR, `${theme}.json`);
    if (!fs.existsSync(file)) {
      throw new Error(`no theme "${theme}" — have: ${themeNames().join(", ") || "(none)"}`);
    }
    sceneConfig = JSON.parse(fs.readFileSync(file, "utf8"));
    log("bg", `theme ${theme}${sceneConfig._note ? ` — ${sceneConfig._note}` : ""}`);
  }

  const configFile = argValue("config", "");
  if (configFile) {
    const file = path.resolve(ROOT, configFile);
    if (!fs.existsSync(file)) throw new Error(`no config at ${file}`);
    const extra = JSON.parse(fs.readFileSync(file, "utf8"));
    sceneConfig = { ...sceneConfig, ...extra, palette: { ...sceneConfig.palette, ...extra.palette } };
  }

  Object.assign(sceneConfig, { width, height, seed });
  if (process.argv.includes("--speed")) sceneConfig.speed = parseFloat(argValue("speed", "2"));

  const frames = still ? 1 : Math.max(1, Math.round(seconds * fps));
  const chrome = findChrome();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "bg-chrome-"));
  log("bg", `${path.basename(scene)} → ${frames} frame(s) at ${width}x${height}`);

  const browser = spawn(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-timer-throttling",
    "--force-device-scale-factor=1",
    `--window-size=${width},${height}`,
    `--user-data-dir=${profile}`,
    "--remote-debugging-port=0",
    "about:blank",
  ], { stdio: "ignore" });

  let cdp: CDP | null = null;
  let encoder: ReturnType<typeof spawn> | null = null;

  try {
    const port = await waitForPort(profile);
    cdp = await CDP.connect(await pageSocket(port));

    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    // The window flag is advisory; this is what actually fixes the framebuffer.
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });

    // The config has to be in place before the page's own script runs.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.BG_CONFIG = ${JSON.stringify(sceneConfig)};`,
    });
    await cdp.send("Page.navigate", { url: `file://${scene.split(path.sep).join("/")}` });

    const deadline = Date.now() + 20000;
    for (;;) {
      const probe = await cdp.send<any>("Runtime.evaluate", {
        expression: "!!window.__bgReady", returnByValue: true,
      });
      if (probe.result?.value === true) break;
      if (Date.now() > deadline) throw new Error("the scene never signalled __bgReady — check it for a script error");
      await sleep(100);
    }

    const shoot = async (t: number): Promise<Buffer> => {
      const drawn = await cdp!.send<any>("Runtime.evaluate", {
        expression: `window.renderFrame(${t})`, returnByValue: true, awaitPromise: true,
      });
      if (drawn.exceptionDetails) throw new Error(`renderFrame(${t.toFixed(4)}) threw: ${drawn.exceptionDetails.text}`);
      const shot = await cdp!.send<any>("Page.captureScreenshot", {
        format: "png", captureBeyondViewport: false, fromSurface: true,
      });
      return Buffer.from(shot.data, "base64");
    };

    if (still) {
      fs.writeFileSync(out, await shoot(phase));
      log("bg", `${out} — single frame at t=${phase}`);
      return;
    }

    encoder = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "image2pipe", "-c:v", "png", "-framerate", String(fps), "-i", "-",
      "-an",
      "-c:v", "libx264", "-preset", "slow", "-crf", "16",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart",
      out,
    ], { stdio: ["pipe", "ignore", "pipe"] });

    let ffmpegErr = "";
    encoder.stderr?.on("data", (d) => { ffmpegErr += d.toString(); });
    const finished = new Promise<number>((resolve) => encoder!.on("close", resolve));
    encoder.stdin!.on("error", () => {});   // a dead encoder surfaces on close, not here

    const started = Date.now();
    let mark = 0;
    for (let i = 0; i < frames; i++) {
      // i/frames, not i/(frames-1): the end of the loop is the start again.
      await write(encoder.stdin!, await shoot(i / frames));
      const pct = Math.floor((100 * (i + 1)) / frames);
      if (pct >= mark + 20) { mark = pct; log("bg", `${pct}%`); }
    }
    encoder.stdin!.end();

    const code = await finished;
    if (code !== 0) throw new Error(`ffmpeg exited ${code}\n${ffmpegErr.trim().split("\n").slice(-6).join("\n")}`);

    const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    log("bg", `${out} — ${(frames / fps).toFixed(2)}s loop, ${width}x${height}, ${mb} MB (${secs}s)`);
  } finally {
    cdp?.close();
    browser.kill();
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

main().catch((err) => { warn("bg", err.message); process.exit(1); });
