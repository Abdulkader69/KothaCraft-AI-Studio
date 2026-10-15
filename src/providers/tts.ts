import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DIRS, ROOT, env } from "../config";
import { spoken } from "../pronounce";
import type { DialogueLine, DialogueSpeaker } from "../types";
import { estimateWords, wordsFromAlignment, type Word, type WordFile } from "../words";
import { ensureDir, estimateSeconds, ffmpeg, log, probeDuration, warn, writeJson } from "../util";

export interface TtsJob {
  text: string;
  id: string;
  dest: string;              // .mp3
  voiceId?: string;          // elevenlabs voice id
  kokoroVoice?: string;      // kokoro voice name, e.g. "af_sarah" or "af_sarah:60,am_adam:40"
  lang?: string;             // kokoro language code, e.g. "en-us"
  mmsLang?: string;          // MMS ISO 639-3 code, e.g. "ben" for Bangla
  piperSpeaker?: number;     // 0-15 in the bn_BD voice
  edgeVoice?: string;        // e.g. "bn-BD-NabanitaNeural"
  edgeRate?: string;         // e.g. "-8%"
  geminiVoice?: string;      // e.g. "Kore"
  stability?: number;
  similarity?: number;
  speed?: number;
  style?: number;
}

const wordsPath = (id: string) => path.join(DIRS.words, `${id}.json`);

/** Silent track of the estimated length, so timing/sync can be tested without keys. */
function placeholder(job: TtsJob): void {
  const seconds = estimateSeconds(job.text);
  ensureDir(path.dirname(job.dest));
  ffmpeg([
    "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=44100",
    "-t", seconds.toFixed(2), "-c:a", "libmp3lame", "-q:a", "6", job.dest,
  ], "placeholder-tts");
}

export const KOKORO_MODELS = ["kokoro-v1.0.onnx", "voices-v1.0.bin"];
export const KOKORO_RELEASE = "https://github.com/nazdridoy/kokoro-tts/releases/download/v1.0.0/";

/** Where the two kokoro model files live — the CLI only reads them from its cwd. */
export function kokoroModelDir(): string {
  return path.resolve(env("KOKORO_MODEL_DIR", ROOT));
}

export function kokoroMissingModels(): string[] {
  const dir = kokoroModelDir();
  return KOKORO_MODELS.filter((f) => !fs.existsSync(path.join(dir, f)));
}

let warnedNoAlignment = false;

/** Local models give us audio but no timings — say so once, not once per scene. */
function noteNoAlignment(provider: string): void {
  if (warnedNoAlignment || env("WORD_TIMING", "off") !== "off") return;
  warnedNoAlignment = true;
  warn("tts", `${provider} returns no word timings — set WORD_TIMING=local for word-accurate captions`);
}

/**
 * Local, free, offline voice via the kokoro-tts CLI (pip install kokoro-tts).
 * The CLI loads kokoro-v1.0.onnx / voices-v1.0.bin from its working directory,
 * so we run it from KOKORO_MODEL_DIR and hand it absolute in/out paths.
 */
function kokoro(job: TtsJob): void {
  const bin = env("KOKORO_BIN", "kokoro-tts");
  const modelDir = kokoroModelDir();
  const missing = kokoroMissingModels();
  if (missing.length) {
    throw new Error(
      `kokoro: ${missing.join(" and ")} not found in ${modelDir}\n` +
      `  run \`npm run kokoro:setup\` to download them,\n` +
      `  or point KOKORO_MODEL_DIR at wherever you keep them.`
    );
  }

  const tmp = ensureDir(path.join(DIRS.tmp, "kokoro"));
  const txt = path.join(tmp, `${job.id}.txt`);
  const wav = path.join(tmp, `${job.id}.wav`);
  fs.writeFileSync(txt, job.text);

  const args = [
    txt, wav,
    "--voice", job.kokoroVoice ?? env("KOKORO_VOICE", "af_sarah"),
    "--lang", job.lang ?? env("KOKORO_LANG", "en-us"),
    "--speed", String(job.speed ?? 1.0),
    "--format", "wav",
  ];
  let crash: string | null = null;
  try {
    execFileSync(bin, args, { cwd: modelDir, stdio: ["ignore", "ignore", "pipe"] });
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      throw new Error(`kokoro: \`${bin}\` not found — install it with \`pip install kokoro-tts\`, or set KOKORO_BIN in .env`);
    }
    crash = (err?.stderr?.toString() ?? "").trim().split("\n").slice(-8).join("\n");
  }

  // kokoro intermittently writes the whole take and *then* dies in native
  // teardown ("recursive_mutex lock failed"), exiting non-zero. A complete wav
  // means the audio is fine, so judge the run by its output, not its exit code.
  const written = fs.existsSync(wav) ? fs.statSync(wav).size : 0;
  if (written < 1024) {
    throw new Error(`kokoro failed for ${job.id}\n${crash ?? "no audio written"}\n\ncommand: ${bin} ${args.join(" ")}\ncwd: ${modelDir}`);
  }
  if (crash) warn("tts", `${job.id} — kokoro crashed on exit, but the audio is complete; keeping it`);

  // The rest of the pipeline reads out/04-tts/<id>.mp3, so transcode the wav down.
  ensureDir(path.dirname(job.dest));
  ffmpeg(["-i", wav, "-c:a", "libmp3lame", "-q:a", "2", "-ac", "1", job.dest], `kokoro-mp3-${job.id}`);
  fs.rmSync(wav, { force: true });
  noteNoAlignment("kokoro");
}

/**
 * Meta MMS-TTS via a small Python helper — free and offline, and unlike kokoro it
 * covers Bangla (`ben`) and ~1,100 other languages. Quality is plainer than kokoro's
 * English, but it is real speech in the right language. No word timings either.
 */
function mms(job: TtsJob): void {
  const python = env("MMS_PYTHON", path.join(ROOT, ".venv", "bin", "python"));
  if (!fs.existsSync(python)) {
    throw new Error(`mms: python not found at ${python} — set MMS_PYTHON in .env`);
  }
  const script = path.join(ROOT, "scripts", "mms_tts.py");
  const lang = job.mmsLang ?? env("MMS_LANG", "ben");

  const tmp = ensureDir(path.join(DIRS.tmp, "mms"));
  const txt = path.join(tmp, `${job.id}.txt`);
  const wav = path.join(tmp, `${job.id}.wav`);
  fs.writeFileSync(txt, job.text);

  const args = [script, txt, wav, "--lang", lang, "--speed", String(job.speed ?? 1.0)];
  try {
    execFileSync(python, args, { cwd: ROOT, stdio: ["ignore", "ignore", "pipe"] });
  } catch (err: any) {
    const stderr = (err?.stderr?.toString() ?? "").trim().split("\n").slice(-6).join("\n");
    throw new Error(`mms failed for ${job.id}\n${stderr || "no error output"}\n\nlanguage: ${lang}`);
  }
  if (!fs.existsSync(wav) || fs.statSync(wav).size < 1024) {
    throw new Error(`mms produced no audio for ${job.id} (language ${lang})`);
  }

  ensureDir(path.dirname(job.dest));
  ffmpeg(["-i", wav, "-c:a", "libmp3lame", "-q:a", "2", "-ac", "1", job.dest], `mms-mp3-${job.id}`);
  fs.rmSync(wav, { force: true });
  noteNoAlignment("mms");
}

// ── Bangladeshi Bangla, local ────────────────────────────────────────────────
export const PIPER_VENV = path.join(ROOT, ".venv-piper");
export const PIPER_STORE = path.join(ROOT, ".piper");
export const piperInstalled = () =>
  fs.existsSync(path.join(PIPER_VENV, "bin", "piper")) && fs.existsSync(path.join(PIPER_STORE, "bn_BD-google-medium.onnx"));

export const VITS_BD_VENV = path.join(ROOT, ".venv-vits-bd");
export const VITS_BD_STORE = path.join(ROOT, ".vits-bd");
export const vitsBdInstalled = () =>
  fs.existsSync(path.join(VITS_BD_VENV, "bin", "python")) && fs.existsSync(path.join(VITS_BD_STORE, "test", "hello.wav"));

export const EDGE_VENV = path.join(ROOT, ".venv-edge");
export const EDGE_STORE = path.join(ROOT, ".edge");
export const edgeInstalled = () =>
  fs.existsSync(path.join(EDGE_VENV, "bin", "python")) && fs.existsSync(path.join(EDGE_STORE, "test", "hello.mp3"));


/** The voices the UI offers; EDGE_VOICE accepts any name from `edge-tts --list-voices`. */
export const EDGE_VOICES = [
  { id: "bn-BD-NabanitaNeural", label: "Nabanita — Bangladesh, female" },
  { id: "bn-BD-PradeepNeural", label: "Pradeep — Bangladesh, male" },
  { id: "bn-IN-TanishaaNeural", label: "Tanishaa — India, female" },
  { id: "bn-IN-BashkarNeural", label: "Bashkar — India, male" },
  { id: "en-US-AriaNeural", label: "Aria — US English, female" },
  { id: "en-US-GuyNeural", label: "Guy — US English, male" },
  { id: "en-GB-SoniaNeural", label: "Sonia — British English, female" },
  { id: "hi-IN-SwaraNeural", label: "Swara — Hindi, female" },
  { id: "ur-PK-UzmaNeural", label: "Uzma — Urdu, female" },
  { id: "ar-SA-ZariyahNeural", label: "Zariyah — Arabic, female" },
];

/**
 * Microsoft neural voices through the Edge read-aloud endpoint (edge-tts).
 * Free and account-less, and the only free source of the bn-BD voices — but
 * unofficial: the service can throttle or change without notice, so a failure
 * here is a reason to switch provider, not a bug to fix. Sends back word
 * boundaries with the audio, so captions are word-accurate for free.
 */
function edge(job: TtsJob): void {
  if (!edgeInstalled()) throw new Error("edge is not installed — run `npm run edge:setup` (~20 MB, no account)");
  const python = path.join(EDGE_VENV, "bin", "python");
  const tmp = ensureDir(path.join(DIRS.tmp, "edge"));
  const txt = path.join(tmp, `${job.id}.txt`);
  const words = path.join(tmp, `${job.id}.words.json`);
  fs.writeFileSync(txt, job.text);
  ensureDir(path.dirname(job.dest));
  try {
    execFileSync(python, [path.join(ROOT, "scripts", "edge_speak.py"), txt, job.dest, words], {
      cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, EDGE_VOICE: job.edgeVoice || env("EDGE_VOICE", "bn-BD-NabanitaNeural"), EDGE_RATE: job.edgeRate || env("EDGE_RATE", "+0%") },
    });
  } catch (err: any) {
    const stderr = (err?.stderr?.toString() ?? "").trim().split("\n").slice(-4).join("\n");
    throw new Error(`edge failed for ${job.id}\n${stderr || "no error output"}`);
  }
  if (!fs.existsSync(job.dest) || fs.statSync(job.dest).size < 1024) throw new Error(`edge produced no audio for ${job.id}`);
  try {
    const list = JSON.parse(fs.readFileSync(words, "utf8")) as { word: string; start: number; end: number }[];
    if (list.length) {
      writeJson(wordsPath(job.id), { basis: "tts", words: list } satisfies WordFile);
      log("tts", `${job.id} ${list.length} word timings from edge`);
    }
  } catch {}
  fs.rmSync(words, { force: true });
}

/** Every 22.05 kHz mono wav from the local engines goes through the same mp3 step. */
function wavToDest(wav: string, job: TtsJob, label: string): void {
  if (!fs.existsSync(wav) || fs.statSync(wav).size < 1024) throw new Error(`${label} produced no audio for ${job.id}`);
  ensureDir(path.dirname(job.dest));
  ffmpeg(["-i", wav, "-c:a", "libmp3lame", "-q:a", "2", "-ac", "1", job.dest], `${label}-mp3-${job.id}`);
  fs.rmSync(wav, { force: true });
}

/**
 * Piper with the bn_BD voice — trained on Google's Bangladesh Bangla corpus
 * (OpenSLR-37). 16 speakers, MIT, ~0.6 s per scene on CPU. The compiled
 * extension has a bogus default phoneme-data path, so ESPEAK_DATA_PATH is
 * pointed at the copy the wheel itself ships.
 */
function piper(job: TtsJob): void {
  if (!piperInstalled()) throw new Error("piper is not installed — run `npm run piper:setup`");
  const bin = path.join(PIPER_VENV, "bin", "piper");
  const model = path.join(PIPER_STORE, "bn_BD-google-medium.onnx");
  const chosen = job.piperSpeaker ?? Number(env("PIPER_SPEAKER", "0"));
  const speaker = Math.min(15, Math.max(0, Number.isFinite(chosen) ? Math.trunc(chosen) : 0));
  const dataDir = execFileSync(path.join(PIPER_VENV, "bin", "python"),
    ["-c", "import piper,os;print(os.path.join(os.path.dirname(piper.__file__),'espeak-ng-data'))"], { encoding: "utf8" }).trim();

  const tmp = ensureDir(path.join(DIRS.tmp, "piper"));
  const wav = path.join(tmp, `${job.id}.wav`);
  try {
    execFileSync(bin, ["--model", model, "--speaker", String(speaker), "--output_file", wav], {
      input: job.text, cwd: ROOT, stdio: ["pipe", "ignore", "pipe"],
      env: { ...process.env, ESPEAK_DATA_PATH: dataDir },
    });
  } catch (err: any) {
    const stderr = (err?.stderr?.toString() ?? "").trim().split("\n").slice(-5).join("\n");
    throw new Error(`piper failed for ${job.id}\n${stderr || "no error output"}\nspeaker: ${speaker}`);
  }
  wavToDest(wav, job, "piper");
  noteNoAlignment("piper");
}

/**
 * Bangladeshi VITS (EMTIAZZ) through a frozen Coqui venv. One natural voice,
 * Apache-2.0, ~1.2 s per scene. The venv's pins are what keep it working —
 * Coqui upstream is unmaintained.
 */
function vitsBd(job: TtsJob): void {
  if (!vitsBdInstalled()) throw new Error("vits-bd is not installed — run `npm run vits-bd:setup`");
  const python = path.join(VITS_BD_VENV, "bin", "python");
  const tmp = ensureDir(path.join(DIRS.tmp, "vits-bd"));
  const txt = path.join(tmp, `${job.id}.txt`);
  const wav = path.join(tmp, `${job.id}.wav`);
  fs.writeFileSync(txt, job.text);
  try {
    execFileSync(python, [path.join(ROOT, "scripts", "vits_bd_tts.py"), txt, wav], {
      cwd: ROOT, stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, HF_HOME: path.join(VITS_BD_STORE, "hf"), HF_HUB_DISABLE_XET: "1", HF_HUB_OFFLINE: "1" },
    });
  } catch (err: any) {
    const stderr = (err?.stderr?.toString() ?? "").trim().split("\n").filter((l: string) => !/warn/i.test(l)).slice(-5).join("\n");
    throw new Error(`vits-bd failed for ${job.id}\n${stderr || "no error output"}`);
  }
  wavToDest(wav, job, "vits-bd");
  noteNoAlignment("vits-bd");
}

/**
 * ElevenLabs `with-timestamps` returns the audio AND character-level alignment,
 * which gives free word-accurate captions — no transcription pass needed.
 */
/** Shipped-by-default library ids that 402 on free plans — caught before the call. */
const LIBRARY_VOICES = new Set(["21m00Tcm4TlvDq8ikWAM"]);

async function elevenlabs(job: TtsJob): Promise<void> {
  const key = env("ELEVENLABS_API_KEY");
  if (!key) throw new Error("ELEVENLABS_API_KEY missing in .env");
  // Default to a *premade* voice. Library voices (the ones you add from the voice
  // library) are rejected on free accounts with a 402, which reads like a billing
  // problem rather than a voice problem.
  const voice = job.voiceId ?? env("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL");
  if (LIBRARY_VOICES.has(voice)) {
    throw new Error(
      `elevenlabs: ${voice} is a voice-library id that free accounts cannot use via the API.\n` +
      `  It is probably still set as voice.voiceId in your project file — pick a voice in the UI,\n` +
      `  or set ELEVENLABS_VOICE_ID and remove voiceId from the project.`
    );
  }
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text: job.text,
      model_id: env("ELEVENLABS_MODEL", "eleven_multilingual_v2"),
      voice_settings: {
        stability: job.stability ?? 0.50,
        similarity_boost: job.similarity ?? 0.8,
        style: job.style ?? 0.15,
        use_speaker_boost: true,
        speed: job.speed ?? 1.0,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if (res.status === 402 && /library voices/i.test(body)) {
      throw new Error(
        `elevenlabs: voice ${voice} is a library voice, which free accounts cannot use via the API.\n` +
        `  Pick a "premade" voice instead — e.g. EXAVITQu4vr4xnSDxMaL (Sarah) — or upgrade your plan.`
      );
    }
    throw new Error(`elevenlabs ${res.status}: ${body}`);
  }

  const data = (await res.json()) as { audio_base64: string; alignment?: any; normalized_alignment?: any };
  ensureDir(path.dirname(job.dest));
  fs.writeFileSync(job.dest, Buffer.from(data.audio_base64, "base64"));

  const alignment = data.alignment ?? data.normalized_alignment;
  if (alignment?.characters) {
    const file: WordFile = { basis: "tts", words: wordsFromAlignment(alignment) };
    writeJson(wordsPath(job.id), file);
    log("tts", `${job.id} ${file.words.length} word timings from alignment`);
  }
}

/**
 * Gemini TTS via generateContent. Bangla is supported but the 30 voices are the
 * same for every language — the accent is model-driven. Free on the
 * flash preview models, with a low daily request cap. Returns 24 kHz PCM.
 */
async function gemini(job: TtsJob): Promise<void> {
  const key = env("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY missing in .env");
  const model = env("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts");
  const voice = job.geminiVoice || env("GEMINI_VOICE", "Kore");
  // For Gemini 3.8 models, text is a verbatim transcript (stage directions in text are spoken aloud).
  // For legacy models, a style cue in front of the text steered delivery.
  const is38 = model.includes("3.8");
  const defaultStyle = is38 ? "" : "Read this Bangla narration warmly and clearly, at a calm storytelling pace:";
  const style = env("GEMINI_TTS_STYLE", defaultStyle).trim();
  const promptText = style ? `${style}\n${job.text}` : job.text;
  let res: Response | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: promptText }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    });
    if (res.status === 429 && attempt < 4) {
      log("tts", `gemini 429 on ${job.id} — waiting ${attempt * 6}s before retry ${attempt}...`);
      await new Promise((r) => setTimeout(r, attempt * 6000));
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const body = await res?.text() ?? "";
    let why = body.slice(0, 300);
    try { why = JSON.parse(body).error?.message ?? why; } catch {}
    if (res?.status === 429) throw new Error(`gemini 429: free-tier rate limit — wait a moment, or switch TTS_PROVIDER`);
    throw new Error(`gemini ${res?.status}: ${why || res?.statusText}`);
  }
  const data = (await res.json()) as any;
  const part = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
  if (!part) throw new Error(`gemini returned no audio for ${job.id}: ${JSON.stringify(data).slice(0, 200)}`);
  const mime: string = part.inlineData.mimeType ?? "audio/L16;rate=24000";
  const rate = /rate=(\d+)/.exec(mime)?.[1] ?? "24000";
  const pcm = path.join(ensureDir(DIRS.tmp), `gemini-${job.id}.pcm`);
  fs.writeFileSync(pcm, Buffer.from(part.inlineData.data, "base64"));
  ensureDir(path.dirname(job.dest));
  ffmpeg(["-f", "s16le", "-ar", rate, "-ac", "1", "-i", pcm, "-c:a", "libmp3lame", "-q:a", "2", job.dest], `gemini-mp3-${job.id}`);
  fs.rmSync(pcm, { force: true });
  noteNoAlignment("gemini");
}

export async function synthesize(job: TtsJob): Promise<void> {
  const provider = env("TTS_PROVIDER", "kokoro");
  log("tts", `${path.basename(job.dest)} via ${provider}`);
  if (provider === "elevenlabs") return elevenlabs(job);
  if (provider === "gemini") return gemini(job);
  if (provider === "mms") return mms(job);
  if (provider === "piper") return piper(job);
  if (provider === "vits-bd") return vitsBd(job);
  if (provider === "edge") return edge(job);
  if (provider === "placeholder") return placeholder(job);
  return kokoro(job);
}

export interface DialogueJob {
  id: string;
  dest: string;
  lines: DialogueLine[];
  speakers: Record<string, DialogueSpeaker>;
  provider: "elevenlabs" | "edge" | "gemini" | "vits-bd";
  gap?: number;
  speed?: number;
  stability?: number;
  similarity?: number;
}

async function synthGeminiLine(text: string, voice: string, dest: string, job: DialogueJob): Promise<Word[]> {
  const key = env("GEMINI_API_KEY");
  if (!key) throw new Error("GEMINI_API_KEY missing in .env for dialogue");
  const model = env("GEMINI_TTS_MODEL", "gemini-3.8-flash-tts");
  let res: Response | null = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    });
    if (res.status === 429 && attempt < 4) {
      await new Promise((r) => setTimeout(r, attempt * 6000));
      continue;
    }
    break;
  }
  if (!res || !res.ok) {
    const body = (await res?.text()) ?? "";
    throw new Error(`gemini dialogue line failed: ${res?.status} ${body.slice(0, 150)}`);
  }
  const data = (await res.json()) as any;
  const part = data.candidates?.[0]?.content?.parts?.find((p: any) => p.inlineData?.data);
  if (!part) throw new Error("gemini returned no audio for dialogue line");
  const mime: string = part.inlineData.mimeType ?? "audio/L16;rate=24000";
  const rate = /rate=(\d+)/.exec(mime)?.[1] ?? "24000";
  const pcm = dest.replace(/\.mp3$/, ".pcm");
  fs.writeFileSync(pcm, Buffer.from(part.inlineData.data, "base64"));
  ffmpeg(["-f", "s16le", "-ar", rate, "-ac", "1", "-i", pcm, "-c:a", "libmp3lame", "-q:a", "2", dest], `gemini-dialogue-mp3`);
  fs.rmSync(pcm, { force: true });
  return [];
}

export function resolveGeminiSpeaker(key: string, spk: DialogueSpeaker = {}): string {
  if (spk.geminiVoice) return spk.geminiVoice;
  const text = `${key} ${spk.name || ''} ${spk.note || ''}`.toLowerCase();
  if (/child|daughter|girl|kid_female|young.*female|young.*girl|মেয়ে|কন্যা|শিশু|সন্তান/.test(text)) {
    return "Aoede";
  }
  if (/son|boy|kid_male|young.*male|young.*boy|ছেলে|পুত্র/.test(text)) {
    return "Puck";
  }
  if (/father|dad|man|male|adult.*male|grandpa|নানা|দাদা|বাবা|পিতা|পুরুষ/.test(text)) {
    return "Charon";
  }
  return "Kore";
}

export interface ElevenLabsVoiceProfile {
  voiceId: string;
  stability: number;
  similarity: number;
  speed: number;
  style: number;
}

/**
 * Character voice profiles for ElevenLabs, mapping character roles / family terms
 * to pre-made ElevenLabs voices or custom env overrides with fine-tuned delivery.
 */
export function resolveElevenLabsSpeaker(
  key: string,
  spk: DialogueSpeaker = {},
  job?: Partial<DialogueJob>
): ElevenLabsVoiceProfile {
  let voiceId = spk.voiceId && !spk.voiceId.startsWith("PASTE_") ? spk.voiceId : "";
  let stability = job?.stability ?? 0.50;
  let similarity = job?.similarity ?? 0.80;
  let speed = job?.speed ?? 1.0;
  let style = 0.15;

  const text = `${key} ${spk.profile || ''} ${spk.name || ''} ${spk.note || ''}`.toLowerCase();

  if (/child|daughter|girl|kid_female|young.*female|young.*girl|মেয়ে|কন্যা|শিশু/.test(text)) {
    // Young female / daughter: Elli (sweet, youthful girl)
    voiceId = voiceId || env("ELEVENLABS_VOICE_DAUGHTER") || env("ELEVENLABS_VOICE_CHILD_FEMALE") || "MF3mGyEYCl7XYWbV9V6O";
    speed = 1.04;
    stability = 0.40;
    style = 0.20;
  } else if (/son|boy|kid_male|young.*male|young.*boy|ছেলে|পুত্র/.test(text)) {
    // Young male / son: Josh (youthful boy)
    voiceId = voiceId || env("ELEVENLABS_VOICE_SON") || env("ELEVENLABS_VOICE_CHILD_MALE") || "TxGEqnHWrfWFTfGW9XjX";
    speed = 1.04;
    stability = 0.42;
    style = 0.18;
  } else if (/child|kid|সন্তান/.test(text)) {
    // Generic child: Elli
    voiceId = voiceId || env("ELEVENLABS_VOICE_CHILD") || env("ELEVENLABS_VOICE_DAUGHTER") || "MF3mGyEYCl7XYWbV9V6O";
    speed = 1.04;
    stability = 0.40;
    style = 0.20;
  } else if (/grandma|grandmother|elderly.*female|old.*female|নানী|দাদী|বৃদ্ধা/.test(text)) {
    // Grandmother: Alice (gentle, elder pacing)
    voiceId = voiceId || env("ELEVENLABS_VOICE_GRANDMOTHER") || "Xb7hH8MSUJpSbSDYk0k2";
    speed = 0.88;
    stability = 0.65;
    style = 0.10;
  } else if (/mother|mom|woman|female|adult.*female|মা|মহিলা|জননী/.test(text)) {
    // Mother: Sarah (warm, caring maternal)
    voiceId = voiceId || env("ELEVENLABS_VOICE_MOTHER") || "EXAVITQu4vr4xnSDxMaL";
    speed = 0.94;
    stability = 0.55;
    style = 0.15;
  } else if (/grandpa|grandfather|elderly.*male|old.*male|নানা|দাদা|বৃদ্ধ/.test(text)) {
    // Grandfather: George (warm elder narrator)
    voiceId = voiceId || env("ELEVENLABS_VOICE_GRANDFATHER") || "JBFqnCBsd6RMkjVDRZzb";
    speed = 0.90;
    stability = 0.65;
    style = 0.10;
  } else if (/teacher|scholar|alim|sheikh|narrator|ustadh|শিক্ষক|ওস্তাদ|আলেম|বর্ণনাকারী/.test(text)) {
    // Scholar / Teacher / Narrator: George or Adam
    voiceId = voiceId || env("ELEVENLABS_VOICE_SCHOLAR") || "JBFqnCBsd6RMkjVDRZzb";
    speed = 0.92;
    stability = 0.60;
    style = 0.12;
  } else if (/father|dad|man|male|adult.*male|বাবা|পিতা|পুরুষ/.test(text)) {
    // Father: Adam (deep, dignified fatherly)
    voiceId = voiceId || env("ELEVENLABS_VOICE_FATHER") || "pNInz6obpgDQGcFmaJgB";
    speed = 0.95;
    stability = 0.60;
    style = 0.10;
  } else {
    voiceId = voiceId || env("ELEVENLABS_VOICE_ID", "EXAVITQu4vr4xnSDxMaL");
  }

  return { voiceId, stability, similarity, speed, style };
}

async function synthElevenLabsLine(
  text: string,
  dest: string,
  cfg: ElevenLabsVoiceProfile
): Promise<Word[]> {
  const key = env("ELEVENLABS_API_KEY");
  if (!key) throw new Error("ELEVENLABS_API_KEY missing in .env for dialogue");
  const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${cfg.voiceId}/with-timestamps`, {
    method: "POST",
    headers: { "xi-api-key": key, "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      model_id: env("ELEVENLABS_MODEL", "eleven_multilingual_v2"),
      voice_settings: {
        stability: cfg.stability,
        similarity_boost: cfg.similarity,
        style: cfg.style,
        use_speaker_boost: true,
        speed: cfg.speed,
      },
    }),
  });
  if (!res.ok) throw new Error(`elevenlabs dialogue ${res.status}: ${await res.text()}`);
  const data = (await res.json()) as { audio_base64: string; alignment?: any; normalized_alignment?: any };
  fs.writeFileSync(dest, Buffer.from(data.audio_base64, "base64"));
  const alignment = data.alignment ?? data.normalized_alignment;
  return alignment?.characters ? wordsFromAlignment(alignment) : [];
}

function synthEdgeLine(text: string, voice: string, rate: string, pitch: string, dest: string, tmpDir: string, idx: number): Word[] {
  if (!edgeInstalled()) throw new Error("edge is not installed — run `npm run edge:setup`");
  const python = path.join(EDGE_VENV, "bin", "python");
  const txt = path.join(tmpDir, `line-${idx}.txt`);
  const wordsPathJson = path.join(tmpDir, `line-${idx}.words.json`);
  fs.writeFileSync(txt, text);
  try {
    execFileSync(python, [path.join(ROOT, "scripts", "edge_speak.py"), txt, dest, wordsPathJson], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, EDGE_VOICE: voice, EDGE_RATE: rate, EDGE_PITCH: pitch },
    });
  } catch (err: any) {
    const stderr = (err?.stderr?.toString() ?? "").trim().split("\n").slice(-4).join("\n");
    throw new Error(`edge dialogue line failed: ${stderr || "no error output"}`);
  }
  if (!fs.existsSync(dest) || fs.statSync(dest).size < 1024) throw new Error("edge produced no audio for line");
  try {
    const list = JSON.parse(fs.readFileSync(wordsPathJson, "utf8")) as { word: string; start: number; end: number }[];
    return list.map((w) => ({ word: w.word, start: w.start, end: w.end }));
  } catch {
    return [];
  }
}

export function resolveEdgeSpeaker(key: string, spk: DialogueSpeaker = {}): { voice: string; rate: string; pitch: string } {
  let voice = spk.edgeVoice;
  let rate = spk.edgeRate;
  let pitch = spk.edgePitch;

  if (!voice || !rate || !pitch) {
    const text = `${key} ${spk.name || ''} ${spk.note || ''}`.toLowerCase();
    if (/child|daughter|girl|kid_female|young.*female|young.*girl|মেয়ে|কন্যা|শিশু/.test(text)) {
      voice = voice || "bn-BD-NabanitaNeural";
      rate = rate || "+6%";
      pitch = pitch || "+22Hz";
    } else if (/grandma|grandmother|elderly.*female|old.*female|নানী|দাদী|বৃদ্ধা/.test(text)) {
      voice = voice || "bn-BD-NabanitaNeural";
      rate = rate || "-8%";
      pitch = pitch || "-6Hz";
    } else if (/mother|mom|woman|female|adult.*female|মা|মহিলা|জননী/.test(text)) {
      voice = voice || "bn-BD-NabanitaNeural";
      rate = rate || "-2%";
      pitch = pitch || "+0Hz";
    } else if (/son|boy|kid_male|young.*male|young.*boy|ছেলে|পুত্র/.test(text)) {
      voice = voice || "bn-BD-PradeepNeural";
      rate = rate || "+8%";
      pitch = pitch || "+18Hz";
    } else if (/grandpa|grandfather|elderly.*male|old.*male|নানা|দাদা|বৃদ্ধ/.test(text)) {
      voice = voice || "bn-BD-PradeepNeural";
      rate = rate || "-9%";
      pitch = pitch || "-8Hz";
    } else if (/teacher|scholar|alim|sheikh|narrator|ustadh|শিক্ষক|ওস্তাদ|আলেম|বর্ণনাকারী/.test(text)) {
      voice = voice || "bn-BD-PradeepNeural";
      rate = rate || "-2%";
      pitch = pitch || "+0Hz";
    } else if (/father|dad|man|male|adult.*male|বাবা|পিতা|পুরুষ/.test(text)) {
      voice = voice || "bn-BD-PradeepNeural";
      rate = rate || "-4%";
      pitch = pitch || "-4Hz";
    } else {
      voice = voice || env("EDGE_VOICE", "bn-BD-NabanitaNeural");
      rate = rate || env("EDGE_RATE", "+0%");
      pitch = pitch || "+0Hz";
    }
  }

  return { voice, rate, pitch };
}

export function resolveVitsBdSpeaker(key: string, spk: DialogueSpeaker = {}): { pitchFactor: number; speedFactor: number } {
  let pitch = spk.vitsPitch;
  let rate = spk.vitsRate;

  if (!pitch || !rate) {
    const text = `${key} ${spk.profile || ''} ${spk.name || ''} ${spk.note || ''}`.toLowerCase();
    if (/child|daughter|girl|kid_female|young.*female|young.*girl|মেয়ে|কন্যা|শিশু/.test(text)) {
      pitch = pitch || "+16%";
      rate = rate || "1.05x";
    } else if (/grandma|grandmother|elderly.*female|old.*female|নানী|দাদী|বৃদ্ধা/.test(text)) {
      pitch = pitch || "-8%";
      rate = rate || "0.90x";
    } else if (/mother|mom|woman|female|adult.*female|মা|মহিলা|জননী/.test(text)) {
      pitch = pitch || "+3%";
      rate = rate || "0.98x";
    } else if (/son|boy|kid_male|young.*male|young.*boy|ছেলে|পুত্র/.test(text)) {
      pitch = pitch || "+10%";
      rate = rate || "1.04x";
    } else if (/grandpa|grandfather|elderly.*male|old.*male|নানা|দাদা|বৃদ্ধ/.test(text)) {
      pitch = pitch || "-15%";
      rate = rate || "0.88x";
    } else if (/teacher|scholar|alim|sheikh|narrator|ustadh|শিক্ষক|ওস্তাদ|আলেম|বর্ণনাকারী/.test(text)) {
      pitch = pitch || "-8%";
      rate = rate || "0.94x";
    } else if (/father|dad|man|male|adult.*male|বাবা|পিতা|পুরুষ/.test(text)) {
      pitch = pitch || "-12%";
      rate = rate || "0.96x";
    } else {
      pitch = pitch || "+0%";
      rate = rate || "1.0x";
    }
  }

  let pitchFactor = 1.0;
  const pStr = String(pitch).trim();
  if (pStr.endsWith('%')) {
    const pct = parseFloat(pStr.replace('%', ''));
    if (!isNaN(pct)) pitchFactor = Math.max(0.6, Math.min(1.6, 1 + pct / 100));
  } else if (/([+-]?\d+(?:\.\d+)?)\s*st/i.test(pStr)) {
    const semitones = parseFloat(pStr);
    if (!isNaN(semitones)) pitchFactor = Math.pow(2, semitones / 12);
  } else {
    const val = parseFloat(pStr);
    if (!isNaN(val)) pitchFactor = Math.max(0.6, Math.min(1.6, val > 0.4 && val < 2.5 ? val : 1 + val / 100));
  }

  let speedFactor = 1.0;
  const rStr = String(rate).trim();
  if (rStr.endsWith('%')) {
    const pct = parseFloat(rStr.replace('%', ''));
    if (!isNaN(pct)) speedFactor = Math.max(0.6, Math.min(1.8, 1 + pct / 100));
  } else if (rStr.endsWith('x') || rStr.endsWith('X')) {
    const val = parseFloat(rStr);
    if (!isNaN(val)) speedFactor = Math.max(0.6, Math.min(1.8, val));
  } else {
    const val = parseFloat(rStr);
    if (!isNaN(val)) speedFactor = Math.max(0.6, Math.min(1.8, val));
  }

  return { pitchFactor, speedFactor };
}

function synthVitsBdLine(
  text: string,
  dest: string,
  tmpDir: string,
  idx: number,
  pitchFactor: number,
  speedFactor: number
): Word[] {
  if (!vitsBdInstalled()) throw new Error("vits-bd is not installed — run `npm run vits-bd:setup`");
  const python = path.join(VITS_BD_VENV, "bin", "python");
  const txt = path.join(tmpDir, `line-${idx}.txt`);
  const rawWav = path.join(tmpDir, `line-${idx}-raw.wav`);
  fs.writeFileSync(txt, text);
  try {
    execFileSync(python, [path.join(ROOT, "scripts", "vits_bd_tts.py"), txt, rawWav], {
      cwd: ROOT,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, HF_HOME: path.join(VITS_BD_STORE, "hf"), HF_HUB_DISABLE_XET: "1", HF_HUB_OFFLINE: "1" },
    });
  } catch (err: any) {
    const stderr = (err?.stderr?.toString() ?? "").trim().split("\n").filter((l: string) => !/warn/i.test(l)).slice(-5).join("\n");
    throw new Error(`vits-bd dialogue line failed: ${stderr || "no error output"}`);
  }
  if (!fs.existsSync(rawWav) || fs.statSync(rawWav).size < 1024) throw new Error("vits-bd produced no audio for line");

  const p = Number(pitchFactor.toFixed(3));
  const s = Number(speedFactor.toFixed(3));
  if (Math.abs(p - 1.0) > 0.01 || Math.abs(s - 1.0) > 0.01) {
    const atempoVal = Math.max(0.5, Math.min(2.0, s / p));
    ffmpeg([
      "-i", rawWav,
      "-af", `asetrate=22050*${p},aresample=22050,atempo=${atempoVal.toFixed(3)}`,
      "-c:a", "libmp3lame", "-q:a", "2", "-y", dest
    ], `vits-filter-${idx}`);
  } else {
    ffmpeg([
      "-i", rawWav,
      "-c:a", "libmp3lame", "-q:a", "2", "-y", dest
    ], `vits-convert-${idx}`);
  }

  const duration = probeDuration(dest);
  return estimateWords(text, duration, 0);
}

/**
 * Multi-speaker dialogue synthesizer.
 * Synthesizes each dialogue line individually using its speaker's voice,
 * measures duration, aligns word timings, and stitches the audio together
 * with conversational micro-gaps.
 */
export async function synthesizeDialogue(job: DialogueJob): Promise<void> {
  const tmpDir = ensureDir(path.join(DIRS.tmp, `dialogue-${job.id}`));
  const gap = Math.max(0.1, job.gap ?? 0.65);
  const gapMp3 = path.join(tmpDir, "gap.mp3");

  ffmpeg([
    "-f", "lavfi", "-i", "anullsrc=channel_layout=mono:sample_rate=44100",
    "-t", gap.toFixed(3), "-c:a", "libmp3lame", "-q:a", "2", gapMp3,
  ], `dialogue-gap-${job.id}`);

  const lineFiles: string[] = [];
  const allWords: Word[] = [];
  let cursorTime = 0;

  for (let idx = 0; idx < job.lines.length; idx++) {
    const line = job.lines[idx];
    const speakerKey = line.speaker;
    const speakerCfg = job.speakers[speakerKey] ?? {};
    const lineDest = path.join(tmpDir, `line-${idx}.mp3`);
    const spokenText = spoken(line.text);

    let rawWords: Word[] = [];
    if (job.provider === "elevenlabs") {
      const cfg = resolveElevenLabsSpeaker(speakerKey, speakerCfg, job);
      rawWords = await synthElevenLabsLine(spokenText, lineDest, cfg);
    } else if (job.provider === "gemini") {
      const voice = speakerCfg.geminiVoice || resolveGeminiSpeaker(speakerKey, speakerCfg);
      rawWords = await synthGeminiLine(spokenText, voice, lineDest, job);
    } else if (job.provider === "vits-bd") {
      const { pitchFactor, speedFactor } = resolveVitsBdSpeaker(speakerKey, speakerCfg);
      rawWords = synthVitsBdLine(spokenText, lineDest, tmpDir, idx, pitchFactor, speedFactor);
    } else {
      const { voice, rate, pitch } = resolveEdgeSpeaker(speakerKey, speakerCfg);
      rawWords = synthEdgeLine(spokenText, voice, rate, pitch, lineDest, tmpDir, idx);
    }

    const duration = probeDuration(lineDest);
    if (!rawWords.length) {
      rawWords = estimateWords(line.text, duration, 0);
    }

    for (const w of rawWords) {
      allWords.push({
        word: w.word,
        start: Number((cursorTime + w.start).toFixed(3)),
        end: Number((cursorTime + w.end).toFixed(3)),
        speaker: speakerKey,
      });
    }

    lineFiles.push(lineDest);
    cursorTime += duration;
    if (idx < job.lines.length - 1) {
      lineFiles.push(gapMp3);
      cursorTime += gap;
    }
  }

  // Concatenate lines and gap files
  const concatList = path.join(tmpDir, "concat.txt");
  const listContent = lineFiles.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n");
  fs.writeFileSync(concatList, listContent);

  ensureDir(path.dirname(job.dest));
  ffmpeg([
    "-f", "concat", "-safe", "0", "-i", concatList,
    "-c:a", "libmp3lame", "-q:a", "2", "-y", job.dest,
  ], `dialogue-concat-${job.id}`);

  // Write merged word timings
  const wordFile: WordFile = { basis: "tts", words: allWords };
  writeJson(wordsPath(job.id), wordFile);
  log("tts", `${job.id} dialogue: ${job.lines.length} lines, ${allWords.length} words timed via ${job.provider}`);
}
