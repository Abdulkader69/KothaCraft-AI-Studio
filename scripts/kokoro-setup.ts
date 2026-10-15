/**
 * One-time setup for the local kokoro voice.
 *   npm run kokoro:setup
 *
 * Downloads the two model files the kokoro-tts CLI expects to find in its
 * working directory. ~350 MB total, so they stream straight to disk.
 * Install the CLI itself separately: `pip install kokoro-tts`.
 */
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { hasFlag, loadEnv } from "../src/config";
import { KOKORO_MODELS, KOKORO_RELEASE, kokoroModelDir } from "../src/providers/tts";
import { ensureDir, log, warn } from "../src/util";

async function fetchToFile(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed ${res.status} ${url}`);
  const tmp = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(tmp));
  fs.renameSync(tmp, dest);
}

async function main() {
  loadEnv();
  const dir = ensureDir(kokoroModelDir());
  const force = hasFlag("force");

  for (const name of KOKORO_MODELS) {
    const dest = path.join(dir, name);
    if (!force && fs.existsSync(dest) && fs.statSync(dest).size > 0) {
      log("kokoro", `${name} already present`);
      continue;
    }
    log("kokoro", `downloading ${name} — this takes a few minutes`);
    await fetchToFile(KOKORO_RELEASE + name, dest);
    log("kokoro", `${name} ${(fs.statSync(dest).size / 1e6).toFixed(0)} MB`);
  }

  log("kokoro", `models ready in ${dir}`);
  warn("kokoro", "if you have not already: pip install kokoro-tts");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
