/**
 * Verse reels — a JSON verse set -> one finished video.
 *
 *   npm run fetch:recitation -- --project content/verses/demo.json
 *   npm run verses           -- --project content/verses/demo.json
 *
 * Unlike a reel, there are no per-scene images and no concat: one generated
 * background loop runs underneath the whole video, and only the text changes
 * over it.
 *
 * The audio is **recitation**, not speech synthesis — no engine recites Quran.
 * Each ayat is held for exactly as long as its recording takes. The translation
 * is caption only; it is spoken solely when `voiceover` is "bangla", and then it
 * sits under the recitation rather than replacing it.
 *
 *   background   assets/bg/<theme>-<w>x<h>.mp4     rendered on demand by render-bg
 *   recitation   assets/recitation/<reciter>/      fetched by fetch-recitation
 *   text         <OUT>/verses.ass                  Arabic over Bangla, burned in
 *   output       <OUT>/final.mp4
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DIRS, MUSIC_DIR, OUT, ROOT, env, hasFlag, loadEnv, loadVerseSet, verseDims } from "../src/config";
import { assColor, stamp, trackingFor } from "../src/ass";
import { buildBrand } from "../src/brand";
import { spoken, spokenChanges } from "../src/pronounce";
import { synthesize } from "../src/providers/tts";
import {
  ARABIC_FACES, BANGLA_FACES, DEFAULT_RECITER, FONTS_DIR, NO_BASMALA_SURAH, OPENINGS,
  clipPath, reciterById,
} from "../src/reciters";
import type { Project, Verse, VerseSet } from "../src/types";
import {
  defaultFontName, ensureDir, escPath, estimateSeconds, exists, ffmpeg,
  log, probeDuration, rememberTts, ttsCached, warn,
} from "../src/util";

interface Entry {
  id: string;
  start: number;
  duration: number;
  recite: string | null;
  reciteDuration: number;
  vo: string | null;
}
interface Plan {
  total: number; intro: number; outro: number;
  fps: number; width: number; height: number;
  entries: Entry[];
}

const RECITE_DIR = path.join(OUT, "07-recite");
const TRIM = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";

/**
 * One ASS style is one font, and the caption font used by the reels draws no
 * Arabic — Helvetica and Kohinoor Bangla both fall back to boxes. The Arabic
 * line therefore gets its own face, chosen per platform.
 */
/**
 * Arabic faces differ enormously in how much of the em they actually fill. The
 * Amiri family draws far smaller than a UI face like Geeza Pro at the same point
 * size — set to the same number, the translation ends up louder than the ayat.
 * These factors bring the default back to a consistent optical size; an explicit
 * `type.arabicSize` is taken literally and never scaled.
 */
const FACE_SCALE: Record<string, number> = {
  "Amiri Quran": 1.55,
  "Amiri": 1.40,
  "Scheherazade New": 1.35,
};
const faceScale = (font: string) => FACE_SCALE[font] ?? 1;

const haveBundledFonts = () =>
  exists(FONTS_DIR) && fs.readdirSync(FONTS_DIR).some((f) => f.toLowerCase().endsWith(".ttf"));

function defaultArabicFont(): string {
  if (process.env.ARABIC_FONT) return process.env.ARABIC_FONT;
  // Amiri Quran is cut for Quranic text: the tashkeel sits properly instead of
  // colliding with the letters the way a UI face's marks do at this size.
  if (haveBundledFonts()) return ARABIC_FACES[0];
  if (os.platform() === "darwin") return "Geeza Pro";
  if (os.platform() === "win32") return "Traditional Arabic";
  return "DejaVu Sans";
}
function defaultBanglaFont(): string {
  if (process.env.BANGLA_FONT) return process.env.BANGLA_FONT;
  if (haveBundledFonts()) return BANGLA_FACES[0];
  if (os.platform() === "darwin") return "Kohinoor Bangla";
  return defaultFontName();
}

// ── background ───────────────────────────────────────────────────────────────
function ensureBackground(set: VerseSet, width: number, height: number, force: boolean): string {
  if (set.background) {
    const file = path.resolve(ROOT, set.background);
    if (!exists(file)) throw new Error(`background not found: ${file}`);
    return file;
  }
  const theme = set.theme ?? "night-mosque";
  const dest = path.join(ROOT, "assets", "bg", `${theme}-${width}x${height}.mp4`);
  if (exists(dest) && !force) { log("verses", `background ${path.basename(dest)} (cached)`); return dest; }

  log("verses", `rendering background "${theme}" at ${width}x${height} — one time, then cached`);
  const res = spawnSync("npx", [
    "tsx", path.join(ROOT, "scripts", "render-bg.ts"),
    "--theme", theme, "--width", String(width), "--height", String(height),
    "--seconds", "10", "--out", dest,
  ], { cwd: ROOT, stdio: "inherit" });
  if (res.status !== 0) throw new Error(`background render failed for theme "${theme}"`);
  return dest;
}

/**
 * The ta'awwudh and basmala are prepended as ordinary verses, so they are held,
 * captioned and timed exactly like an ayat — no special case downstream.
 * They carry no ayat marker.
 */
function openingVerses(set: VerseSet): Verse[] {
  const mode = set.opening ?? "none";
  if (mode === "none") return [];
  const out: Verse[] = [];

  if (mode === "taawwudh" || mode === "both") {
    out.push({ id: "00a", arabic: OPENINGS.taawwudh.arabic, bangla: OPENINGS.taawwudh.bangla });
  }
  if (mode === "basmala" || mode === "both") {
    if (set.surah === NO_BASMALA_SURAH) {
      warn("verses", "surah 9 opens without the basmala — skipped");
    } else {
      // ayah 0 is the host's number for a surah's own basmala.
      out.push({ id: "00b", arabic: OPENINGS.basmala.arabic, bangla: OPENINGS.basmala.bangla, ayah: 0 });
    }
  }
  return out;
}

/** A clip for the ta'awwudh, if one has been dropped in. Nothing fetches it. */
function taawwudhClip(set: VerseSet): string | null {
  const reciter = set.recitation?.reciter ?? DEFAULT_RECITER;
  for (const c of [
    path.join(path.dirname(clipPath(reciter, 1, 1)), "taawwudh.mp3"),
    path.join(ROOT, "assets", "recitation", "taawwudh.mp3"),
  ]) if (exists(c)) return c;
  return null;
}

// ── recitation ───────────────────────────────────────────────────────────────
/** An explicit clip wins, then a local folder, then the shared fetch cache. */
function findClip(set: VerseSet, verse: Verse): string | null {
  if (verse.audio) {
    const file = path.resolve(ROOT, verse.audio);
    if (exists(file)) return file;
    warn("verses", `${verse.id}: audio "${verse.audio}" not found`);
    return null;
  }
  if (verse.id === "00a") return taawwudhClip(set);
  if (verse.ayah == null || !set.surah) return null;
  const reciter = set.recitation?.reciter ?? DEFAULT_RECITER;
  if (set.recitation?.dir) {
    const file = path.join(path.resolve(ROOT, set.recitation.dir),
      `${String(set.surah).padStart(3, "0")}${String(verse.ayah).padStart(3, "0")}.mp3`);
    if (exists(file)) return file;
  }
  const cached = clipPath(reciter, set.surah, verse.ayah);
  return exists(cached) ? cached : null;
}

/**
 * Recordings come from many sources at many levels, so each is trimmed of
 * leading silence and brought to the same loudness — otherwise one ayat
 * arrives twice as loud as the next.
 */
function prepareRecitation(set: VerseSet, force: boolean): Map<string, string> {
  ensureDir(RECITE_DIR);
  const gain = set.recitation?.gainDb ?? 0;
  const out = new Map<string, string>();
  let found = 0;

  for (const verse of set.verses) {
    const src = findClip(set, verse);
    if (!src) continue;
    found++;
    const dest = path.join(RECITE_DIR, `${verse.id}.wav`);
    if (!exists(dest) || fs.statSync(dest).mtimeMs < fs.statSync(src).mtimeMs || force) {
      ffmpeg([
        "-i", src,
        "-af", `${TRIM},loudnorm=I=-16:TP=-1.5:LRA=11${gain ? `,volume=${gain}dB` : ""},aresample=48000`,
        "-ac", "1", dest,
      ], `recite-${verse.id}`);
    }
    out.set(verse.id, dest);
  }

  if (!found) {
    const reciter = set.recitation?.reciter ?? DEFAULT_RECITER;
    warn("verses", `no recitation clips found — run: npm run fetch:recitation -- --project <file> --reciter ${reciter}`);
  } else {
    const r = reciterById(set.recitation?.reciter ?? DEFAULT_RECITER);
    log("verses", `recitation: ${r?.name ?? set.recitation?.reciter ?? DEFAULT_RECITER} — ${found}/${set.verses.length} ayat`);
  }
  return out;
}

// ── optional Bangla voiceover ────────────────────────────────────────────────
async function speak(set: VerseSet, force: boolean): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if ((set.voiceover ?? "none") !== "bangla") return out;

  const v = set.voice ?? {};
  const voiceKey = [
    env("TTS_PROVIDER", "kokoro"), v.voiceId, v.kokoroVoice, v.lang, v.mmsLang, v.piperSpeaker,
    v.geminiVoice ?? env("GEMINI_VOICE"), env("GEMINI_TTS_MODEL"), v.speed,
    v.edgeVoice ?? env("EDGE_VOICE"), v.edgeRate ?? env("EDGE_RATE"),
  ].map((x) => x ?? "").join("|");

  ensureDir(DIRS.tts); ensureDir(DIRS.voice);
  for (const verse of set.verses) {
    // The Arabic is never sent to a voice — only the translation, and only here.
    const source = (verse.narration ?? verse.bangla).trim();
    if (!source) continue;

    const mp3 = path.join(DIRS.tts, `${verse.id}.mp3`);
    const text = spoken(source);
    const key = `${voiceKey}\n${text}`;
    if (!ttsCached(mp3, key, force)) {
      const changes = spokenChanges(source);
      if (changes.length) log("verses", `${verse.id} pronounced: ${changes.map(([a, b]) => `${a}→${b}`).join(", ")}`);
      await synthesize({ ...v, text, id: verse.id, dest: mp3 });
      rememberTts(mp3, key);
    }
    const wav = path.join(DIRS.voice, `${verse.id}.wav`);
    if (!exists(wav) || fs.statSync(wav).mtimeMs < fs.statSync(mp3).mtimeMs || force) {
      ffmpeg(["-i", mp3, "-af", `${TRIM},loudnorm=I=-19:TP=-3:LRA=11,aresample=48000`, "-ac", "1", wav], `vo-${verse.id}`);
    }
    out.set(verse.id, wav);
  }
  log("verses", `Bangla voiceover under the recitation: ${out.size} ayat`);
  return out;
}

// ── timing ───────────────────────────────────────────────────────────────────
function plan(set: VerseSet, width: number, height: number,
              recite: Map<string, string>, vo: Map<string, string>): Plan {
  const fps = set.fps ?? 30;
  const gap = set.gap ?? 0.5;
  const intro = Math.max(0, set.intro?.seconds ?? 3.5);
  const outro = Math.max(0, set.outro?.seconds ?? 0);

  const entries: Entry[] = [];
  let cursor = intro;
  for (const verse of set.verses) {
    const clip = recite.get(verse.id) ?? null;
    const voFile = vo.get(verse.id) ?? null;
    const reciteDuration = clip ? probeDuration(clip) : 0;
    const voDuration = voFile ? probeDuration(voFile) : 0;
    // With no audio at all, fall back to a reading-speed estimate of the
    // translation so the ayat is at least on screen long enough to read.
    const spoken = Math.max(reciteDuration, voDuration) || estimateSeconds(verse.bangla);
    const duration = Math.max(spoken + gap, verse.seconds ?? 0, 1.2);
    entries.push({ id: verse.id, start: cursor, duration, recite: clip, reciteDuration, vo: voFile });
    cursor += duration;
  }
  return { total: cursor + outro, intro, outro, fps, width, height, entries };
}

// ── text ─────────────────────────────────────────────────────────────────────
const esc = (t: string) =>
  t.replace(/[{}]/g, "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\\N");

function writeAss(set: VerseSet, p: Plan, dest: string): void {
  const T = set.type ?? {};
  const arabicFont = T.arabicFont ?? defaultArabicFont();
  const banglaFont = T.banglaFont ?? defaultBanglaFont();
  const arabicSize = T.arabicSize ?? Math.round((p.height / 22) * faceScale(arabicFont));
  const banglaSize = T.banglaSize ?? Math.round(p.height / 34);
  const lineGap = T.lineGap ?? Math.round(banglaSize * 0.6);
  const centerY = T.centerY ?? 0.42;

  const arabicColor = assColor(T.arabicColor ?? "#FFFFFF");
  const banglaColor = assColor(T.banglaColor ?? "#E9DCC0");
  const numberColor = assColor(T.numberColor ?? "#E9C987");
  const outline = assColor(T.outline ?? "#000000");
  const margin = Math.round(p.width * 0.09);

  // Arabic and Bangla are both complex scripts: any letter tracking would take
  // the glyphs apart. trackingFor already refuses it for either range.
  const spacing = trackingFor(set.verses.map((v) => v.arabic + v.bangla).join(""));

  const header = [
    "[Script Info]", "ScriptType: v4.00+",
    `PlayResX: ${p.width}`, `PlayResY: ${p.height}`,
    "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Verse,${arabicFont},${arabicSize},${arabicColor},&H000000FF,${outline},&H64000000,0,0,0,0,100,100,${spacing},0,1,${Math.max(2, Math.round(arabicSize / 18))},2,5,${margin},${margin},0,1`,
    `Style: Card,${banglaFont},${Math.round(p.height / 26)},${arabicColor},&H000000FF,${outline},&H64000000,-1,0,0,0,100,100,${spacing},0,1,3,2,5,${margin},${margin},0,1`,
    "", "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const lines: string[] = [];
  const at = (yFrac: number) => `{\\an5\\pos(${Math.round(p.width / 2)},${Math.round(p.height * yFrac)})}`;

  if (p.intro > 0) {
    const bits: string[] = [];
    if (set.arabicTitle) bits.push(`{\\fn${arabicFont}\\fs${Math.round((p.height / 15) * faceScale(arabicFont))}\\c${numberColor}}${esc(set.arabicTitle)}`);
    bits.push(`{\\fn${banglaFont}\\fs${Math.round(p.height / 24)}\\c${arabicColor}\\b1}${esc(set.title)}`);
    if (set.subtitle) bits.push(`{\\fn${banglaFont}\\fs${Math.round(p.height / 30)}\\c${banglaColor}\\b0}${esc(set.subtitle)}`);
    if (set.range) bits.push(`{\\fn${banglaFont}\\fs${Math.round(p.height / 44)}\\c${banglaColor}\\b0}${esc(set.range)}`);
    const spacer = `\\N{\\fs${Math.round(lineGap * 0.8)}} `;
    lines.push(`Dialogue: 0,${stamp(0)},${stamp(p.intro - 0.05)},Card,,0,0,0,,${at(0.40)}{\\fad(500,400)}${bits.join(spacer + "\\N")}`);
  }

  for (const [i, entry] of p.entries.entries()) {
    const verse = set.verses[i];
    const end = entry.start + entry.duration - 0.05;
    if (end <= entry.start) continue;

    // The ayat marker closes the verse, which in right-to-left order puts it on
    // the left — the same place a mushaf puts it.
    const marker = verse.number
      ? ` {\\c${numberColor}}﴿${esc(verse.number)}﴾{\\c${arabicColor}}`
      : "";
    const arabic = `{\\fn${arabicFont}\\fs${arabicSize}\\c${arabicColor}}${esc(verse.arabic)}${marker}`;
    const bangla = `{\\fn${banglaFont}\\fs${banglaSize}\\c${banglaColor}}${esc(verse.bangla)}`;
    const spacer = `\\N{\\fs${lineGap}} `;
    lines.push(`Dialogue: 0,${stamp(entry.start)},${stamp(end)},Verse,,0,0,0,,${at(centerY)}{\\fad(320,320)}${arabic}${spacer}\\N${bangla}`);
  }

  if (p.outro > 0 && set.outro?.text) {
    const from = p.total - p.outro;
    lines.push(`Dialogue: 0,${stamp(from)},${stamp(p.total - 0.05)},Card,,0,0,0,,${at(0.45)}{\\fad(400,600)}${esc(set.outro.text)}`);
  }

  ensureDir(path.dirname(dest));
  fs.writeFileSync(dest, [...header, ...lines].join("\n"));
  log("verses", `text: ${p.entries.length} ayat, ${lines.length} events — ${arabicFont} ${arabicSize}px / ${banglaFont} ${banglaSize}px`);
}

// ── audio ────────────────────────────────────────────────────────────────────
/**
 * Single-pass `loudnorm` is a dynamic filter, not a gain stage: asking it for
 * -16 LUFS gets close per clip but does not land there, and mixing mono sources
 * up to stereo loses a few dB more. So the finished track is measured once and
 * corrected with a flat gain — predictable, and no pumping across the silences
 * between ayat.
 */
function measureIntegrated(file: string): number | null {
  const read = (text: string) => {
    const m = text.match(/Input Integrated:\s*(-?\d+(?:\.\d+)?)\s*LUFS/);
    return m ? parseFloat(m[1]) : null;
  };
  // spawnSync, not execFileSync: loudnorm prints its summary on stderr, and
  // execFileSync only hands back stdout.
  const res = spawnSync("ffmpeg",
    ["-hide_banner", "-i", file, "-af", "loudnorm=print_format=summary", "-f", "null", "-"],
    { encoding: "utf8" });
  return read(`${res.stderr ?? ""}${res.stdout ?? ""}`);
}

function normalizeTo(src: string, target: number, total: number, dest: string): string {
  const measured = measureIntegrated(src);
  if (measured === null) { warn("verses", "could not measure loudness — leaving the mix as it is"); return src; }
  const gain = target - measured;
  log("verses", `loudness ${measured.toFixed(1)} → ${target.toFixed(1)} LUFS (${gain >= 0 ? "+" : ""}${gain.toFixed(1)} dB)`);
  if (Math.abs(gain) < 0.3) return src;
  ffmpeg([
    "-i", src, "-af", `volume=${gain.toFixed(2)}dB,alimiter=limit=0.97,aresample=48000`,
    "-t", total.toFixed(3), dest,
  ], "loudness");
  return dest;
}

/** Lay clips onto one timeline at their start times. */
function layer(files: { file: string; start: number }[], total: number, dest: string, label: string): string {
  if (!files.length) {
    ffmpeg(["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-t", total.toFixed(3), dest], `${label}-silence`);
    return dest;
  }
  const inputs = files.flatMap((f) => ["-i", f.file]);
  const delayed = files.map((f, i) =>
    `[${i}:a]aformat=channel_layouts=stereo:sample_rates=48000,adelay=${Math.round(f.start * 1000)}|${Math.round(f.start * 1000)}[d${i}]`
  );
  const join = files.map((_, i) => `[d${i}]`).join("");
  ffmpeg([
    ...inputs, "-filter_complex",
    `${delayed.join(";")};${join}amix=inputs=${files.length}:normalize=0:dropout_transition=0,apad[a]`,
    "-map", "[a]", "-t", total.toFixed(3), dest,
  ], label);
  return dest;
}

/** Recitation carries the reel; a Bangla voiceover, if asked for, sits under it. */
function buildAudio(set: VerseSet, p: Plan): string {
  const recitation = layer(
    p.entries.filter((e) => e.recite).map((e) => ({ file: e.recite!, start: e.start })),
    p.total, path.join(DIRS.tmp, "recitation.wav"), "recitation"
  );

  const voFiles = p.entries.filter((e) => e.vo).map((e) => ({ file: e.vo!, start: e.start }));
  let primary = recitation;
  if (voFiles.length) {
    const vo = layer(voFiles, p.total, path.join(DIRS.tmp, "voiceover.wav"), "voiceover");
    const dest = path.join(DIRS.tmp, "primary.wav");
    ffmpeg([
      "-i", recitation, "-i", vo, "-filter_complex",
      "[1:a]volume=-7dB[under];[0:a][under]amix=inputs=2:normalize=0:dropout_transition=0[a]",
      "-map", "[a]", "-t", p.total.toFixed(3), dest,
    ], "primary");
    primary = dest;
  }

  const target = Number(env("DELIVER_LUFS", "-14"));
  const name = set.music?.file;
  if (!name) return normalizeTo(primary, target, p.total, path.join(DIRS.tmp, "audio.wav"));
  const file = exists(path.resolve(ROOT, name)) ? path.resolve(ROOT, name) : path.join(MUSIC_DIR, name);
  if (!exists(file)) {
    warn("verses", `no music at ${name} — recitation only`);
    return normalizeTo(primary, target, p.total, path.join(DIRS.tmp, "audio.wav"));
  }

  const gain = set.music?.gainDb ?? -30;   // quieter than a reel: nothing competes with recitation
  const fade = 1.5;
  const bed = path.join(DIRS.tmp, "music.wav");
  ffmpeg([
    "-stream_loop", "-1", "-i", file, "-t", p.total.toFixed(3),
    "-af", `loudnorm=I=-20:TP=-2:LRA=11,volume=${gain}dB,` +
      `afade=t=in:st=0:d=${fade},afade=t=out:st=${Math.max(0, p.total - fade).toFixed(3)}:d=${fade},aresample=48000`,
    bed,
  ], "music-bed");

  const dest = path.join(DIRS.tmp, "audio.wav");
  ffmpeg([
    "-i", primary, "-i", bed, "-filter_complex",
    "[0:a]aformat=channel_layouts=stereo:sample_rates=48000,asplit=2[vo][sc];" +
    "[1:a]aformat=channel_layouts=stereo:sample_rates=48000[mu];" +
    "[mu][sc]sidechaincompress=threshold=0.03:ratio=12:attack=15:release=400[duck];" +
    "[vo][duck]amix=inputs=2:normalize=0:dropout_transition=0,alimiter=limit=0.95,aresample=48000[a]",
    "-map", "[a]", "-t", p.total.toFixed(3), dest,
  ], "mix");
  return normalizeTo(dest, target, p.total, path.join(DIRS.tmp, "audio-final.wav"));
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  loadEnv();
  const set = loadVerseSet();
  const { width, height } = verseDims(set);
  const force = hasFlag("force");
  ensureDir(DIRS.tmp);

  const bg = ensureBackground(set, width, height, hasFlag("rebuild-bg"));
  // Openings are spliced in once, up front, so timing, text and audio all agree.
  set.verses = [...openingVerses(set), ...set.verses];
  const recite = prepareRecitation(set, force);
  const vo = await speak(set, force);

  const p = plan(set, width, height, recite, vo);
  log("verses", `${p.entries.length} ayat, ${p.total.toFixed(2)}s total (intro ${p.intro}s, outro ${p.outro}s)`);

  const ass = path.join(OUT, "verses.ass");
  writeAss(set, p, ass);
  const audio = buildAudio(set, p);

  const asProject = { brand: set.brand, captions: {}, scenes: [] } as unknown as Project;
  const brand = buildBrand(asProject, { width, height, logoInput: 2 });
  if (brand) log("verses", `watermark: ${brand.label}`);

  const final = path.join(OUT, "final.mp4");
  // The background is looped to length rather than cut per verse — that is the
  // whole point of this format: nothing behind the text ever jumps.
  const graph =
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,` +
    `crop=${width}:${height},fps=${p.fps},setsar=1,` +
    // fontsdir lets libass use assets/fonts without installing anything system-wide.
    `ass=${escPath(ass)}${haveBundledFonts() ? `:fontsdir=${escPath(FONTS_DIR)}` : ""}[base];` +
    (brand ? brand.filter : "[base]null") + "[v]";

  ffmpeg([
    "-stream_loop", "-1", "-i", bg,
    "-i", audio,
    ...(brand?.inputs ?? []),
    "-filter_complex", graph,
    "-map", "[v]", "-map", "1:a:0",
    "-t", p.total.toFixed(3),
    "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p",
    "-profile:v", "high", "-level", "4.0", "-movflags", "+faststart",
    "-c:a", "aac", "-b:a", "192k", "-ar", "48000",
    final,
  ], "verses-master");

  const mb = (fs.statSync(final).size / 1024 / 1024).toFixed(1);
  log("verses", `${final} — ${probeDuration(final).toFixed(2)}s, ${width}x${height}, ${mb} MB`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
