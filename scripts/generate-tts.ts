/**
 * Step 4 — Voice Generation
 * scene.narration -> out/04-tts/<id>.mp3
 *
 * The voice reads the narration through content/pronounce.json (spellings the
 * TTS gets wrong, e.g. জানত → জানতো); the narration itself is not changed, so
 * captions keep the real spelling.
 */
import path from "node:path";
import { DIRS, env, hasFlag, loadEnv, loadProject } from "../src/config";
import { spoken, spokenChanges } from "../src/pronounce";
import { synthesize, synthesizeDialogue } from "../src/providers/tts";
import { ensureDir, log, rememberTts, ttsCached } from "../src/util";

async function main() {
  loadEnv();
  const project = loadProject();
  const force = hasFlag("force");
  ensureDir(DIRS.tts);

  // What the audio depends on — narration plus the voice that read it.
  const v = project.voice ?? {};
  const voiceKey = [env("TTS_PROVIDER", "kokoro"), v.provider, v.voiceId, v.kokoroVoice, v.lang, v.mmsLang, v.piperSpeaker,
    v.geminiVoice ?? env("GEMINI_VOICE"), env("GEMINI_TTS_MODEL"), v.speed, v.edgeVoice ?? env("EDGE_VOICE"), v.edgeRate ?? env("EDGE_RATE")].map((x) => x ?? "").join("|");

  for (const scene of project.scenes) {
    const dest = path.join(DIRS.tts, `${scene.id}.mp3`);

    // Dialogue scenes: multiple speakers take turns
    if (scene.lines && scene.lines.length > 0) {
      const dialogueLinesText = scene.lines.map((l) => `${l.speaker}:${spoken(l.text)}`).join("\n");
      const dialogueKey = `${voiceKey}\n${JSON.stringify(v.speakers ?? {})}\n${dialogueLinesText}`;
      if (ttsCached(dest, dialogueKey, force)) { log("tts", `${scene.id} dialogue cached`); continue; }

      const dialogueProvider = (project.voice?.provider as "elevenlabs" | "edge" | "gemini" | "vits-bd") ||
        ((env("TTS_PROVIDER") === "elevenlabs" || env("TTS_PROVIDER") === "gemini" || env("TTS_PROVIDER") === "vits-bd" || env("TTS_PROVIDER") === "edge")
          ? (env("TTS_PROVIDER") as "elevenlabs" | "edge" | "gemini" | "vits-bd")
          : "edge");

      await synthesizeDialogue({
        id: scene.id,
        dest,
        lines: scene.lines,
        speakers: project.voice?.speakers ?? {},
        provider: dialogueProvider,
        gap: project.gap ?? 0.35,
        speed: project.voice?.speed,
        stability: project.voice?.stability,
        similarity: project.voice?.similarity,
      });
      rememberTts(dest, dialogueKey);
      continue;
    }

    // Single-voice scenes:
    const text = spoken(scene.narration);
    const key = `${voiceKey}\n${text.trim()}`;
    if (ttsCached(dest, key, force)) { log("tts", `${scene.id} cached`); continue; }
    const changes = spokenChanges(scene.narration);
    if (changes.length) log("tts", `${scene.id} pronounced: ${changes.map(([a, b]) => `${a}→${b}`).join(", ")}`);
    await synthesize({
      text,
      id: scene.id,
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
      style: project.voice?.style,
    });
    rememberTts(dest, key);
  }
  log("tts", `${project.scenes.length} narration files ready`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
