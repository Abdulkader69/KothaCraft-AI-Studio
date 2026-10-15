/**
 * Step 7 — Caption (word level)
 * timeline.json + out/06-words/<id>.json -> out/captions.ass
 *
 * styles:
 *   highlight (default) — a short cue stays on screen, the spoken word lights up
 *   word                — one word at a time, centre screen, with a pop-in
 *   chunk               — plain cue, no per-word highlight
 */
import fs from "node:fs";
import path from "node:path";
import { CAPTIONS, DIRS, PLAT, TIMELINE, cardsFor, loadEnv, loadProject } from "../src/config";
import type { Timeline } from "../src/types";
import type { Word } from "../src/words";
import { loadWords } from "../src/words";
import { codeToPlatform, safeArea } from "../src/safe";
import { assColor, stamp, trackingFor } from "../src/ass";
import { defaultFontName, ensureDir, exists, log, readJson, warn } from "../src/util";


const escText = (t: string) => t.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();

function group<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function main() {
  loadEnv();
  const project = loadProject();
  if (!exists(TIMELINE)) throw new Error("timeline.json not found — run `npm run align` first");
  const timeline = readJson<Timeline>(TIMELINE);

  const c = project.captions ?? {};
  const style = c.style ?? "highlight";
  const size = c.fontSize ?? Math.round(timeline.width / (style === "word" ? 11 : 16));
  const perCue = Math.max(1, c.wordsPerCue ?? 3);
  const primary = assColor(c.primary ?? "#FFFFFF");
  const accent = assColor(c.highlight ?? "#FFD166");
  const fontName = c.fontName ?? defaultFontName();
  // Decided from the narration, so an English reel keeps its tracking.
  const spacing = trackingFor(project.scenes.map((sc) => sc.narration).join(" "));
  // Explicit margins win; otherwise sit just outside the platform's own UI strips.
  // A platform variant re-captions the same cut for that app's UI.
  const platform = (PLAT && codeToPlatform(PLAT)) || project.platform;
  const safe = safeArea(platform, timeline.width, timeline.height);
  const marginV = c.marginV ?? Math.max(Math.round(timeline.height * 0.16), safe.bottom + 40);
  const sourceMarginV = c.sourceMarginV ?? Math.max(90, safe.top + 24);
  const cardMargin = Math.max(120, safe.right + 40, safe.left + 40);

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${timeline.width}`,
    `PlayResY: ${timeline.height}`,
    "WrapStyle: 2",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    `Style: Main,${fontName},${size},${primary},&H000000FF,${assColor(c.outline ?? "#000000")},&H96000000,-1,0,0,0,100,100,${spacing},0,1,` +
      `${Math.max(2, Math.round(size / 14))},2,${style === "word" ? 5 : 2},80,80,${marginV},1`,
    // Speaker label: distinctly larger than captions, sits comfortably above Main captions for speaker turn duration.
    `Style: SpeakerLabel,${fontName},${Math.round(size * 1.25)},${primary},&H000000FF,${assColor(c.outline ?? "#000000")},&H96000000,-1,0,0,0,100,100,${spacing},0,1,` +
      `${Math.max(2, Math.round(size / 11))},2,2,80,80,${marginV + Math.round(size * 1.65)},1`,
    // Alignment 8 = top-centre, so citations never collide with the captions,
    // which sit bottom-centre. Deliberately dim — present, not competing.
    `Style: Source,${fontName},${Math.round(size * 0.42)},${assColor(c.sourceColor ?? "#D8D2C4")},&H000000FF,` +
      `${assColor(c.outline ?? "#000000")},&H64000000,0,0,0,0,100,100,${spacing},0,1,2,1,8,80,80,${sourceMarginV},1`,
    // Intro/outro cards: centred (alignment 5) over the live first/last scene, so
    // they take the caption outline for legibility on any frame.
    `Style: Title,${fontName},${Math.round(timeline.width / 11)},${primary},&H000000FF,${assColor(c.outline ?? "#000000")},&H96000000,-1,0,0,0,100,100,${spacing},0,1,4,3,5,${cardMargin},${cardMargin},0,1`,
    `Style: Outro,${fontName},${Math.round(timeline.width / 17)},${primary},&H000000FF,${assColor(c.outline ?? "#000000")},&H96000000,-1,0,0,0,100,100,${spacing},0,1,3,2,5,${cardMargin},${cardMargin},0,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const lines: string[] = [];
  let wordCount = 0;
  let estimated = 0;

  // Multi-line card text: keep the author's line breaks, drop stray blank ones.
  const cardText = (t: string) => t.split(/\r?\n/).map(escText).filter(Boolean).join("\\N");
  const cards = cardsFor(project);
  if (timeline.intro > 0) {
    const text = cardText(cards.intro.text);
    if (text) lines.push(`Dialogue: 0,${stamp(0)},${stamp(timeline.intro - 0.05)},Title,,0,0,0,,{\\fad(400,400)}${text}`);
  }
  if (timeline.outro > 0 && cards.outro.text) {
    const from = timeline.total - timeline.outro;
    lines.push(`Dialogue: 0,${stamp(from)},${stamp(timeline.total - 0.05)},Outro,,0,0,0,,{\\fad(400,600)}${cardText(cards.outro.text)}`);
  }

  const sourceOf = new Map<string, string>(
    project.scenes
      .map((sc) => [sc.id, (sc.source ?? "").trim()] as const)
      .filter(([, src]) => src.length > 0)
  );
  let sourced = 0;

  for (const entry of timeline.entries) {
    const src = sourceOf.get(entry.id);
    if (src && c.showSource !== false) {
      // Held for the whole scene, fading with it.
      const end = entry.start + entry.duration - 0.05;
      if (end > entry.start) {
        lines.push(`Dialogue: 0,${stamp(entry.start)},${stamp(end)},Source,,0,0,0,,{\\fad(200,200)}${escText(src)}`);
        sourced++;
      }
    }

    if (c.show === false) continue;   // narration-only reel: no word cues
    const words: Word[] = loadWords(entry.id, entry.narration, entry.voiceDuration, entry.start);
    if (!words.length) continue;
    if (!fs.existsSync(path.join(DIRS.words, `${entry.id}.json`))) estimated++;
    wordCount += words.length;
    const sceneEnd = entry.start + entry.duration - 0.05;

    // Group words into cues per speaker so a cue NEVER mixes words from two different speakers
    const cues: Word[][] = [];
    const speakerRuns: { speaker?: string; words: Word[] }[] = [];
    for (const w of words) {
      const last = speakerRuns[speakerRuns.length - 1];
      if (last && last.speaker === w.speaker) {
        last.words.push(w);
      } else {
        speakerRuns.push({ speaker: w.speaker, words: [w] });
      }
    }
    for (const run of speakerRuns) {
      cues.push(...group(run.words, perCue));
    }

    // A cue may never outlive the start of the next one.
    // When a speaker's turn ends, the cue cleanly ends rather than lingering into the pause or overlapping the next speaker.
    const cueEnd = (i: number) => {
      const thisCue = cues[i];
      const nextCue = cues[i + 1];
      const lastWordEnd = thisCue[thisCue.length - 1].end;
      const isSameSpeaker = nextCue && nextCue[0]?.speaker === thisCue[0]?.speaker;
      if (!isSameSpeaker) {
        return Math.min(lastWordEnd + 0.15, sceneEnd);
      }
      return Math.min(lastWordEnd + 0.12, nextCue[0]?.start ?? sceneEnd, sceneEnd);
    };

    // Speaker header on top of captions (for dialogue mode):
    // Stays visible for each speaker's continuous turn, while words highlight below.
    if (c.speakerLabels !== false && words.some((w) => w.speaker)) {
      let runSpeaker = words[0].speaker;
      let runStart = words[0].start;
      let runEnd = words[0].end;

      for (let i = 1; i <= words.length; i++) {
        const w = words[i];
        if (w && w.speaker === runSpeaker) {
          runEnd = w.end;
        } else {
          if (runSpeaker) {
            const spk = project.voice?.speakers?.[runSpeaker];
            const defaultNames: Record<string, string> = {
              child: "মেয়ে", daughter: "মেয়ে", girl: "মেয়ে",
              mother: "মা", mom: "মা",
              father: "বাবা", dad: "বাবা",
              son: "ছেলে", boy: "ছেলে",
              teacher: "শিক্ষক", student: "শিক্ষার্থী",
            };
            let name = spk?.name || defaultNames[runSpeaker.toLowerCase()] || runSpeaker;
            if (!name.endsWith(":") && !name.endsWith("ঃ")) name = `${name}ঃ`;
            const spkColor = spk?.color ? assColor(spk.color) : accent;
            const end = Math.min(runEnd + 0.15, sceneEnd);
            if (end > runStart) {
              lines.push(
                `Dialogue: 0,${stamp(runStart)},${stamp(end)},SpeakerLabel,,0,0,0,,{\\fad(80,80)\\c${spkColor}\\b1}${escText(name)}`
              );
            }
          }
          if (w) {
            runSpeaker = w.speaker;
            runStart = w.start;
            runEnd = w.end;
          }
        }
      }
    }

    if (style === "chunk") {
      cues.forEach((cue, i) => {
        const end = cueEnd(i);
        if (end <= cue[0].start) return;
        lines.push(`Dialogue: 0,${stamp(cue[0].start)},${stamp(end)},Main,,0,0,0,,{\\fad(60,60)}${escText(cue.map((w) => w.word).join(" "))}`);
      });
      continue;
    }

    if (style === "word") {
      words.forEach((w, i) => {
        const end = Math.min(words[i + 1]?.start ?? w.end + 0.18, sceneEnd);
        if (end <= w.start) return;
        lines.push(
          `Dialogue: 0,${stamp(w.start)},${stamp(end)},Main,,0,0,0,,` +
          `{\\fscx86\\fscy86\\t(0,90,\\fscx100\\fscy100)\\fad(40,40)}${escText(w.word)}`
        );
      });
      continue;
    }

    // highlight: the cue stays put, one Dialogue per word repaints the active one
    cues.forEach((cue, ci) => {
      const end0 = cueEnd(ci);
      cue.forEach((w, i) => {
        const end = Math.min(cue[i + 1]?.start ?? end0, end0);
        if (end <= w.start) return;
        const spk = w.speaker ? project.voice?.speakers?.[w.speaker] : undefined;
        const wordAccent = spk?.color ? assColor(spk.color) : accent;
        const text = cue
          .map((x, j) =>
            j === i
              ? `{\\c${wordAccent}\\fscx106\\fscy106}${escText(x.word)}{\\c${primary}\\fscx100\\fscy100}`
              : escText(x.word)
          )
          .join(" ");
        lines.push(`Dialogue: 0,${stamp(w.start)},${stamp(end)},Main,,0,0,0,,${i === 0 ? "{\\fad(60,0)}" : ""}${text}`);
      });
    });
  }

  ensureDir(path.dirname(CAPTIONS));
  fs.writeFileSync(CAPTIONS, [...header, ...lines].join("\n"));
  if (estimated) warn("captions", `${estimated} scene(s) had no word-timing file — spacing estimated (see WORD_TIMING in .env)`);
  if (sourced) log("captions", `${sourced} citation(s) shown top of frame`);
  if (timeline.intro || timeline.outro) log("captions", `cards: intro ${timeline.intro}s, outro ${timeline.outro}s`);
  if (platform && platform !== "none") log("captions", `${platform} safe area — captions ${marginV}px up, citations ${sourceMarginV}px down`);
  if (c.show === false) log("captions", `hidden (captions.show=false) — ${lines.length} card/citation events → ${CAPTIONS}`);
  else log("captions", `style=${style}, ${wordCount} words, ${lines.length} events → ${CAPTIONS}`);
}

main();
