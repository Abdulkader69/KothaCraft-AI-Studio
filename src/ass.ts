/** ASS subtitle helpers shared by the captions and poster steps. */

/**
 * Letter spacing makes libass position every glyph on its own, which shatters
 * Indic/Arabic/Thai clusters — Bangla renders as consonants plus dotted-circle
 * vowel signs. Latin keeps the 1px tracking; complex scripts must not have it.
 */
const COMPLEX_SCRIPT = /[\u0600-\u06FF\u0900-\u0DFF\u0E00-\u0E7F\u1000-\u109F]/;
export function trackingFor(text: string): number {
  return COMPLEX_SCRIPT.test(text) ? 0 : 1;
}

export const assColor = (hex: string) => {
  const h = hex.replace("#", "").padEnd(6, "0");
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
};

export const stamp = (t: number) => {
  const clamped = Math.max(0, t);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.round((clamped - Math.floor(clamped)) * 100);
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
};
