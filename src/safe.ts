/**
 * Platform safe areas — the strips each app draws its own UI over. Anything the
 * pipeline places (captions, citations, cards, watermark) is kept out of them.
 * Fractions of the frame; measured from current Reels / TikTok / Shorts layouts.
 */
export type Platform = "none" | "instagram" | "facebook" | "tiktok" | "youtube";

export const PLATFORMS: Platform[] = ["none", "instagram", "facebook", "tiktok", "youtube"];

/** Short code used in file names: final-ig.mp4, final-yt.mp4 … */
export const PLATFORM_CODE: Record<Exclude<Platform, "none">, string> = {
  instagram: "ig", facebook: "fb", tiktok: "tt", youtube: "yt",
};
export const codeToPlatform = (code: string): Platform | undefined =>
  (Object.entries(PLATFORM_CODE).find(([, c]) => c === code)?.[0] as Platform | undefined);

const FRACTIONS: Record<Platform, { top: number; bottom: number; right: number; left: number }> = {
  none:      { top: 0,    bottom: 0,    right: 0,    left: 0 },
  instagram: { top: 0.08, bottom: 0.22, right: 0.14, left: 0 },
  // Facebook Reels: same right-hand action rail, a slightly shallower caption bar
  facebook:  { top: 0.08, bottom: 0.20, right: 0.14, left: 0 },
  tiktok:    { top: 0.10, bottom: 0.24, right: 0.15, left: 0 },
  youtube:   { top: 0.06, bottom: 0.20, right: 0.14, left: 0 },
};

export interface SafeArea { top: number; bottom: number; right: number; left: number }

/** Insets in pixels for this frame. Unknown platform names count as `none`. */
export function safeArea(platform: string | undefined, width: number, height: number): SafeArea {
  const f = FRACTIONS[(platform ?? "none") as Platform] ?? FRACTIONS.none;
  return {
    top: Math.round(f.top * height),
    bottom: Math.round(f.bottom * height),
    right: Math.round(f.right * width),
    left: Math.round(f.left * width),
  };
}
