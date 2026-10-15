import fs from "node:fs";
import path from "node:path";
import { DIRS } from "./config";
import { readJson } from "./util";

export interface Word { word: string; start: number; end: number; speaker?: string }
export interface WordFile { basis: "tts" | "voice"; words: Word[] }

/** ElevenLabs returns per-character timings; fold them into words. */
export function wordsFromAlignment(a: {
  characters: string[];
  character_start_times_seconds: number[];
  character_end_times_seconds: number[];
}): Word[] {
  const words: Word[] = [];
  let current = "", start = 0, end = 0;
  a.characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (current) words.push({ word: current, start, end });
      current = "";
      return;
    }
    if (!current) start = a.character_start_times_seconds[i];
    current += ch;
    end = a.character_end_times_seconds[i];
  });
  if (current) words.push({ word: current, start, end });
  return words;
}

/** Whisper verbose_json (`words`) or the python CLI json (`segments[].words`). */
export function wordsFromWhisper(json: any): Word[] {
  const raw: any[] = json.words ?? (json.segments ?? []).flatMap((s: any) => s.words ?? []);
  return raw
    .map((w) => ({ word: String(w.word ?? w.text ?? "").trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.word && Number.isFinite(w.start) && Number.isFinite(w.end));
}

/** No timing data: spread words across the take, weighted by length. */
export function estimateWords(text: string, duration: number, offset = 0): Word[] {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return [];
  const weights = tokens.map((t) => t.replace(/[^\p{L}\p{N}]/gu, "").length + 1.4);
  const total = weights.reduce((a, b) => a + b, 0);
  let cursor = offset;
  return tokens.map((word, i) => {
    const span = (weights[i] / total) * duration;
    const w = { word, start: cursor, end: cursor + span };
    cursor += span;
    return w;
  });
}

const strip = (w: string) => w.normalize("NFC").replace(/[^\p{L}\p{M}\p{N}]/gu, "");

/**
 * Captions show the narration as written — timings come from the voice. The
 * timed words may differ from the written ones: the pronunciation dictionary
 * respells for the voice, Edge drops punctuation, whisper guesses spellings and
 * sometimes splits differently. Same count → pair them up. Otherwise walk both
 * lists, letting a written word absorb several timed ones (or the reverse) until
 * the letters line up; if that goes off the rails, spread the written words over
 * the voice's span instead — still the right text, still the right total time.
 */
export function relabel(timed: Word[], narration: string): Word[] {
  const tokens = narration.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !timed.length) return timed;
  if (tokens.length === timed.length) return timed.map((w, i) => ({ ...w, word: tokens[i] }));

  const out: Word[] = [];
  let j = 0, bad = 0;
  for (let i = 0; i < tokens.length; i++) {
    if (j >= timed.length) return spread(tokens, timed);
    const want = strip(tokens[i]);
    let acc = strip(timed[j].word);
    const first = timed[j];
    let last = timed[j];
    j++;
    if (!(want === acc || want.startsWith(acc) || acc.startsWith(want))) bad++;
    // absorb timed words while they are a prefix of what we want (whisper split a word)
    while (want.length > acc.length && j < timed.length && want.startsWith(acc + strip(timed[j].word).slice(0, 1))) {
      acc += strip(timed[j].word);
      last = timed[j];
      j++;
    }
    out.push({ word: tokens[i], start: first.start, end: last.end, speaker: first.speaker });
    // the timed word covered several written ones (whisper merged) — share its time
    if (acc.length > want.length + 2 && i + 1 < tokens.length && acc.startsWith(want)) {
      let rest = acc.slice(want.length);
      const group = [i];
      while (rest.length && i + 1 < tokens.length && rest.startsWith(strip(tokens[i + 1]))) {
        rest = rest.slice(strip(tokens[i + 1]).length);
        i++;
        group.push(i);
      }
      if (group.length > 1) {
        const span = (last.end - first.start) / group.length;
        out.pop();
        group.forEach((gi, n) => out.push({ word: tokens[gi], start: first.start + n * span, end: first.start + (n + 1) * span, speaker: first.speaker }));
      }
    }
  }
  // Timed words left over, or too many pairs that share no letters: the lists
  // never lined up, so don't pretend they did.
  if (j !== timed.length || bad > tokens.length / 3) return spread(tokens, timed);
  return out;
}

/** Written words laid over the voice's span, weighted by length — the estimate, but anchored to real speech. */
function spread(tokens: string[], timed: Word[]): Word[] {
  const start = timed[0].start, end = timed[timed.length - 1].end;
  const words = estimateWords(tokens.join(" "), end - start, start);
  if (timed.some((t) => t.speaker)) {
    return words.map((w, idx) => {
      const closest = timed.find((t) => t.start <= w.start && t.end >= w.end) || timed[Math.min(idx, timed.length - 1)];
      return { ...w, speaker: closest?.speaker };
    });
  }
  return words;
}

/**
 * Word timings for one scene, always relative to the FINAL voice track.
 * TTS-based timings are shifted by however much silence render:voice trimmed off.
 */
export function loadWords(id: string, narration: string, voiceDuration: number, start: number): Word[] {
  const file = path.join(DIRS.words, `${id}.json`);
  if (fs.existsSync(file)) {
    const data = readJson<WordFile>(file);
    if (data.words?.length) {
      let lead = 0;
      const trimFile = path.join(DIRS.voice, `${id}.trim.json`);
      if (data.basis === "tts" && fs.existsSync(trimFile)) lead = readJson<{ lead: number }>(trimFile).lead ?? 0;
      const timed = data.words
        .map((w) => ({ word: w.word, start: start + Math.max(0, w.start - lead), end: start + Math.max(0, w.end - lead), speaker: w.speaker }))
        .filter((w) => w.end > w.start);
      return relabel(timed, narration);
    }
  }
  return estimateWords(narration, voiceDuration, start);
}
