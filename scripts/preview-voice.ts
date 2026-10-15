/**
 * Voice preview — one line through the current TTS settings -> out/.../preview.mp3
 * Used by the UI so a voice can be judged before paying for a whole reel.
 */
import path from "node:path";
import { OUT, loadEnv, loadProject } from "../src/config";
import { spoken } from "../src/pronounce";
import { synthesize } from "../src/providers/tts";
import { ensureDir, log, probeDuration } from "../src/util";

async function main() {
  loadEnv();
  const project = loadProject();
  const flag = process.argv.indexOf("--text");
  const text = (flag > -1 ? process.argv[flag + 1] : project.scenes[0]?.narration ?? "").trim();
  if (!text) throw new Error("nothing to say — pass --text or give the project a first scene");

  const dest = path.join(ensureDir(OUT), "preview.mp3");
  await synthesize({
    text: spoken(text),
    id: "preview",
    dest,
    voiceId: project.voice?.voiceId,
    kokoroVoice: project.voice?.kokoroVoice,
    lang: project.voice?.lang,
    mmsLang: project.voice?.mmsLang,
    piperSpeaker: project.voice?.piperSpeaker,
    edgeVoice: project.voice?.edgeVoice,
    edgeRate: project.voice?.edgeRate,
    geminiVoice: project.voice?.geminiVoice,
    stability: project.voice?.stability,
    similarity: project.voice?.similarity,
    speed: project.voice?.speed,
  });
  log("preview", `${probeDuration(dest).toFixed(1)}s — "${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
