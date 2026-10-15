/**
 * Pronunciation dictionary — spellings the TTS reads wrong, and how to spell
 * them so it reads them right. Applied to the text sent to the voice only;
 * narration stays as written, so captions and post text keep the real spelling.
 *
 *   content/pronounce.json          every provider — abbreviations and the like
 *   content/pronounce.<provider>.json  that provider only, merged on top
 *
 * Each engine gets a different set of things wrong, so a spelling tuned by ear
 * on one voice is usually noise on another: content/pronounce.edge.json holds
 * what was heard wrong in Edge's bn-BD voices, and piper or voicestudio pick up
 * none of it. The shared file is for fixes that are true of any voice — (রাঃ)
 * is an abbreviation whoever reads it. A provider entry wins over a shared one,
 * and mapping a key to its own spelling in the provider file cancels a shared
 * rule for that provider.
 *
 * Keys are whole words; a match ignores the punctuation stuck to the word
 * (জানত। → জানতো।). A key starting with "*" is a suffix rule — "*ছিল": "ছিলো"
 * respells the ending of every word that ends in ছিল (গিয়েছিল → গিয়েছিলো).
 * A key starting with "~" is a letter rule, applied inside every word that no
 * whole-word or suffix entry already covers: "~য়": "য" and "~য": "য়" swap the
 * two letters the voice reads the wrong way round. Letter rules fire in ONE
 * pass, longest key first, so a pair like that swaps instead of undoing itself —
 * and a longer identity rule ("~্য": "্য") shields a sequence from a shorter
 * one, which is how the jo-phola conjunct survives the য swap.
 *
 * Whole word beats suffix beats letters. Keys starting with "_" are comments.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT, env } from "./config";

export const PRONOUNCE_FILE = path.resolve(ROOT, env("PRONOUNCE_FILE", "content/pronounce.json"));

/** The provider's own file, beside the shared one: content/pronounce.edge.json */
export function pronounceFiles(): string[] {
  const provider = env("TTS_PROVIDER", "kokoro").trim().toLowerCase();
  const own = PRONOUNCE_FILE.replace(/\.json$/i, `.${provider}.json`);
  return [PRONOUNCE_FILE, own].filter((f) => fs.existsSync(f));
}

interface Rules { words: Map<string, string>; suffixes: [string, string][]; letters: Map<string, string>; letterRe: RegExp | null }
let cache: { key: string; rules: Rules } | null = null;

export function pronounceRules(): Rules {
  const files = pronounceFiles();
  const empty: Rules = { words: new Map(), suffixes: [], letters: new Map(), letterRe: null };
  if (!files.length) return empty;
  const key = files.map((f) => `${f}:${fs.statSync(f).mtimeMs}`).join("|");
  if (cache && cache.key === key) return cache.rules;
  // Later files win: shared first, then the provider's own.
  const raw: Record<string, unknown> = {};
  for (const f of files) Object.assign(raw, JSON.parse(fs.readFileSync(f, "utf8")) as Record<string, unknown>);
  const rules: Rules = { words: new Map(), suffixes: [], letters: new Map(), letterRe: null };
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith("_") || typeof v !== "string") continue;
    const key = k.trim().normalize("NFC"), val = v.trim().normalize("NFC");
    // a letter rule may map to itself — that is how it shields a sequence
    if (!key || !val || (key === val && !key.startsWith("~"))) continue;
    if (key.startsWith("~")) rules.letters.set(key.slice(1), val);
    else if (key.startsWith("*")) rules.suffixes.push([key.slice(1), val]);
    else rules.words.set(key, val);
  }
  // longest suffix first, so "*য়েছিল" would beat "*ছিল" if both existed
  rules.suffixes.sort((a, b) => b[0].length - a[0].length);
  if (rules.letters.size) {
    // one alternation, longest key first: the match that wins is the longest one,
    // so identity shields work and a swap pair cannot undo itself
    const keys = [...rules.letters.keys()].sort((a, b) => b.length - a.length).map(esc);
    rules.letterRe = new RegExp(keys.join("|"), "gu");
  }
  cache = { key, rules };
  return rules;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One word as the voice should read it, or undefined when no rule applies. */
function respell(w: string, rules: Rules): string | undefined {
  let out = rules.words.get(w);
  if (out === undefined) {
    for (const [suffix, to] of rules.suffixes) {
      // the suffix must be an ending, not the whole word — "ছিল" alone is a whole-word matter
      if (w.length > suffix.length && w.endsWith(suffix)) { out = w.slice(0, -suffix.length) + to; break; }
    }
  }
  // Letters run last, over the respelling too: an expansion that itself contains
  // a letter the voice reads wrong (ওয়া in the honorifics) is fixed as well, so
  // the dictionary stays readable in its normal spelling.
  if (rules.letterRe) out = (out ?? w).replace(rules.letterRe, (m) => rules.letters.get(m) ?? m);
  return out !== undefined && out !== w ? out : undefined;
}

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
/** A word plus the abbreviating dot or colon that may follow it — "রা." / "রা:" */
const WORD_DOT = /([\p{L}\p{M}\p{N}]+)([.:]?)/gu;

/** The text as the voice should read it. */
export function spoken(text: string): string {
  const rules = pronounceRules();
  if (!rules.words.size && !rules.suffixes.length && !rules.letters.size) return text;
  return text.normalize("NFC").replace(WORD_DOT, (all, w: string, dot: string) => {
    const out = respell(w, rules);
    if (out === undefined) return all;
    // An abbreviation spelled out ("রা." → "রাদিয়াল্লাহু আনহু") must lose its dot,
    // or colon, or the voice hears the end of a sentence in the middle of one.
    // A respelling that is still a single word keeps whatever punctuation it had.
    return out + (dot && /\s/.test(out) ? "" : dot);
  });
}

/** Which respellings a text actually triggers — for the log. */
export function spokenChanges(text: string): [string, string][] {
  const rules = pronounceRules();
  const out = new Map<string, string>();
  for (const w of text.normalize("NFC").match(WORD) ?? []) {
    const r = respell(w, rules);
    if (r) out.set(w, r);
  }
  return [...out];
}
