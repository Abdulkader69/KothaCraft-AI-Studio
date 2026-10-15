export type PanDirection = "in" | "out" | "left" | "right";
/** Eased push-in / pull-out that also drifts toward a corner — a dolly, not a zoom. */
export type Cinematic = "cinematic" | "cinematic-out";
/** "ai" = a generated image-to-video clip instead of ken-burns (paid, remote). */
export type Motion = PanDirection | Cinematic | "ai";
export type BrandCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export interface DialogueLine {
  speaker: string;            // e.g. "mother", "child"
  text: string;               // dialogue text spoken by this speaker
  tone?: string;              // e.g. "curious", "warm", "gentle"
}

export interface DialogueSpeaker {
  voiceId?: string;           // ElevenLabs voice ID
  profile?: string;           // preset profile key, e.g. "female_child", "female_adult", "male_adult"
  edgeVoice?: string;         // e.g. "bn-BD-NabanitaNeural"
  edgeRate?: string;          // e.g. "+5%"
  edgePitch?: string;         // e.g. "+20Hz"
  vitsPitch?: string;         // e.g. "+16%", "-12%"
  vitsRate?: string;          // e.g. "1.05x", "0.96x"
  geminiVoice?: string;       // e.g. "Kore", "Aoede", "Charon"
  name?: string;              // human display name, e.g. "মা", "মেয়ে"
  color?: string;             // caption highlight color, e.g. "#EBCB80", "#88C0D0"
  note?: string;              // note or character description
}

export interface Scene {
  id: string;                 // "01", "02" ... used for every filename in the pipeline
  prompt: string;             // image generation prompt
  narration: string;          // what the voice says over this scene (or combined text)
  lines?: DialogueLine[];     // optional multi-speaker dialogue lines for this scene
  seed?: number;              // pin the image roll; change it to re-roll just this scene
  source?: string;            // citation shown at the top of frame for this scene
  seconds?: number;           // rough estimate; `align` replaces it with the real TTS length
  motion?: Motion;
  /** A stock clip instead of a generated image: a file in stock/ (or a repo path). Absent + footage "stock" = auto-pick. */
  clip?: string;
}

/** An alternative opening — anything omitted is inherited from scene 1. */
export interface Hook {
  prompt?: string;
  narration?: string;
  lines?: DialogueLine[];
  seed?: number;
  motion?: Motion;
  motionPrompt?: string;      // what should move when motion is "ai"; default: gentle drift
  clip?: string;
}

export type StockMode = "scene" | "continuous";

export interface Project {
  title: string;
  description?: string;
  aspect?: "9:16" | "16:9" | "1:1";
  platform?: "none" | "instagram" | "facebook" | "tiktok" | "youtube";   // keep text/logo clear of that app's UI
  /** Also render one re-captioned cut per platform: final-ig.mp4, final-yt.mp4 … */
  platforms?: ("instagram" | "facebook" | "tiktok" | "youtube")[];
  /** "stock" = every scene is cut from local footage in stock/ (see pick-stock); default: generated images. */
  footage?: "images" | "stock";
  fps?: number;
  image?: { style?: string; negative?: string; model?: string };
  voice?: {
    provider?: string;
    model?: string;
    mode?: "single" | "dialogue";
    speakers?: Record<string, DialogueSpeaker>;
    voiceId?: string;
    kokoroVoice?: string;
    lang?: string;
    mmsLang?: string;
    piperSpeaker?: number;
    edgeVoice?: string;
    edgeRate?: string;
    geminiVoice?: string;
    stability?: number;
    similarity?: number;
    speed?: number;
    style?: number;
  };
  music?: { file?: string; gainDb?: number; duckDb?: number };
  captions?: {
    show?: boolean;           // false hides the word cues; citations and intro/outro cards stay
    style?: "highlight" | "word" | "chunk";
    showSource?: boolean;     // default true when a scene declares `source`
    sourceColor?: string;
    sourceMarginV?: number;
    wordsPerCue?: number;
    fontSize?: number;
    fontName?: string;
    primary?: string;
    highlight?: string;
    outline?: string;
    marginV?: number;
    speakerLabels?: boolean;  // show speaker name header above captions for dialogue turns
  };
  /** Generated-motion defaults for scenes with motion "ai". */
  video?: { seconds?: number; prompt?: string; negative?: string };
  /** Stock footage: push-in amount (0.08 = 8 %), fade at each cut in seconds, mode ("scene" = video per scene, "continuous" = finish video then use another one if needed), and an optional shortlist —
   *  when `only` names clips, auto-pick chooses from those alone (pinned clips may still be anything). */
  stock?: { zoom?: number; fade?: number; only?: string[]; mode?: StockMode };
  texture?: { grain?: number; vignette?: number; contrast?: number; saturation?: number; overlay?: string };
  /** Watermark burned in by `master`. `image` wins when both are set. */
  brand?: {
    off?: boolean;              // true = no watermark (the default is the channel name)
    text?: string;              // e.g. "@channel" — drawn with FONT_FILE, so Bangla works
    image?: string;             // PNG/JPG relative to the repo, e.g. assets/brand/logo.png
    position?: BrandCorner;     // default "top-right" — top corners stay clear of platform UI
    size?: number;              // image: width in px (default 140); text: font size (default 36)
    opacity?: number;           // 0..1, default 0.85
    margin?: number;            // px from the frame edge, default 64
    color?: string;             // text colour, default "white"
  };
  gap?: number;               // silence between scenes, seconds
  /** Title card before scene 1 — the first image, blurred and dimmed, with `text` (default: title). */
  intro?: { seconds?: number; text?: string };
  /** Closing card after the last scene — same treatment, `text` may span lines with \n. */
  outro?: { seconds?: number; text?: string };
  scenes: Scene[];
  /** Cover image written by `render:poster` — defaults: scene 1's image, the title. */
  poster?: { scene?: string; text?: string; tagline?: string };
  /** Post text for `publish`; anything omitted is derived from title, narration and sources. */
  publish?: { title?: string; description?: string; hashtags?: string[]; privacy?: "public" | "unlisted" | "private";
    /** YouTube cover: poster-16x9.png by default, or a repo path; "" turns it off. */
    thumbnail?: string;
    /** Instagram / Facebook cover: seconds into the video to freeze (default 1). */
    coverAt?: number };
  /** Hook variants: hooks[0] renders as final-b.mp4, hooks[1] as final-c.mp4 … sharing scenes 2+. */
  hooks?: Hook[];
}

export interface TimelineEntry {
  id: string;
  index: number;
  start: number;              // seconds from the top of the reel
  duration: number;           // final on-screen duration for this scene
  voiceDuration: number;      // length of the narration audio itself
  narration: string;
  voiceFile: string | null;
}

export interface Timeline {
  total: number;              // includes intro + outro
  intro: number;              // seconds of title card before entries[0].start (0 = none)
  outro: number;              // seconds of closing card after the last entry (0 = none)
  fps: number;
  width: number;
  height: number;
  entries: TimelineEntry[];
}

// ── photo cards ───────────────────────────────────────────────────────────────
export type CardAspect = "1:1" | "4:5" | "9:16";
export type CardLayout = "center" | "bottom";

export interface Card {
  id: string;                 // "01", "02" … used for the background and output file
  text: string;               // the message — line breaks are kept
  source?: string;            // small accent line under the text, e.g. "সূরা বাকারা ২:১৫৩"
  heading?: string;           // small label at the top, e.g. "আজকের আয়াত"; falls back to the set's
  prompt?: string;            // background image prompt; falls back to the set's `prompt`
  seed?: number;
  layout?: CardLayout;        // per-card override
}

/** A set of photo cards — one JSON file in content/cards/, one folder in out/cards/. */
export interface CardSet {
  title: string;
  aspect?: CardAspect;        // default "1:1"
  layout?: CardLayout;        // "center" dims the whole image; "bottom" ramps the lower half
  heading?: string;
  prompt?: string;            // default background prompt when a card has none
  image?: Project["image"];
  captions?: Project["captions"];   // fontName / primary / highlight / outline reused for the text
  brand?: Project["brand"];
  cards: Card[];
}

// ── verse reels ───────────────────────────────────────────────────────────────
/**
 * One ayat held on screen: the Arabic above, the translation under it, both
 * static for the whole verse. Unlike a reel scene there is no image and no
 * word-level highlight — the background runs underneath, unbroken.
 */
export interface Verse {
  id: string;                 // "01", "02" … used for every filename
  arabic: string;             // shown large and centred
  /** Translation — shown on screen only. Never spoken: the audio is recitation. */
  bangla: string;
  number?: string;            // ayat number for the medallion, e.g. "৮"
  ayah?: number;              // ayat number within the surah, used to find the recitation
  audio?: string;             // an explicit clip for this ayat, overriding the reciter
  /** A Bangla voiceover mixed UNDER the recitation — only when voiceover is "bangla". */
  narration?: string;
  seconds?: number;           // floor duration; a longer recitation still wins
}

/**
 * Where the recited audio comes from. `reciter` is an id from src/reciters.ts;
 * clips are cached in assets/recitation/<reciter>/ and shared by every set.
 */
export interface Recitation {
  reciter?: string;
  dir?: string;               // a local folder of per-ayat clips, instead of the cache
  baseUrl?: string;           // overrides RECITATION_BASE for `fetch:recitation`
  gainDb?: number;            // trim the recitation level, default 0
}

export interface VerseType {
  arabicFont?: string;        // must be a font that draws Arabic (Geeza Pro, .SF Arabic)
  banglaFont?: string;
  arabicSize?: number;        // px at the render height; default height/22
  banglaSize?: number;        // default height/34
  arabicColor?: string;
  banglaColor?: string;
  numberColor?: string;
  outline?: string;
  lineGap?: number;           // blank space between the Arabic and the translation
  centerY?: number;           // 0..1 — where the block's centre sits, default 0.40
}

/** A set of verses — one JSON file in content/verses/, one folder in out/verses/. */
export interface VerseSet {
  title: string;
  arabicTitle?: string;       // e.g. "الواقعة" — the big gold line on the opening card
  subtitle?: string;          // e.g. "সূরা আল-ওয়াকিয়াহ"
  range?: string;             // e.g. "আয়াত ৮–১২"
  aspect?: "9:16" | "1:1";
  fps?: number;
  /** A theme in scripts/bg/themes — rendered on demand if its clip is missing. */
  theme?: string;
  background?: string;        // an explicit clip, overriding `theme`
  gap?: number;               // silence between verses, seconds
  surah?: number;             // needed to locate each ayat's recitation clip
  recitation?: Recitation;
  /** "none" (default) = recitation alone. "bangla" adds a ducked voiceover under it. */
  voiceover?: "none" | "bangla";
  /**
   * What is recited before the first ayat. "taawwudh" suits starting mid-surah;
   * "both" suits opening a surah. Surah 9 has no basmala and is skipped.
   */
  opening?: "none" | "taawwudh" | "basmala" | "both";
  intro?: { seconds?: number };
  outro?: { seconds?: number; text?: string };
  voice?: Project["voice"];
  music?: Project["music"];
  brand?: Project["brand"];
  type?: VerseType;
  publish?: Project["publish"];
  verses: Verse[];
}
