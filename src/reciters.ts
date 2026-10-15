/**
 * Qari registry.
 *
 * No speech engine recites Quran — tajwid, maqam and breath are a performance,
 * not pronunciation — so verse reels use real per-ayat recordings. Each entry
 * is the folder name used by the per-ayat host in RECITATION_BASE, verified to
 * resolve; `style` is what actually decides how a reel feels:
 *
 *   mujawwad  slow and melodic, the emotive classical style — long ayat, heavy
 *             use of maqam. What to pick when the reel should move someone.
 *   murattal  measured and even, for reading along. Shorter, fits more ayat
 *             into a reel, easier to caption.
 *
 * The recordings belong to the reciters and their publishers. They are shared
 * freely for da'wah; whether that extends to a monetised post is the channel
 * owner's call, not this file's.
 */

import path from "node:path";
import { ROOT } from "./config";

export type RecitationStyle = "mujawwad" | "murattal";

export interface Reciter {
  id: string;                 // folder on the per-ayat host
  name: string;
  arabic: string;
  style: RecitationStyle;
  note: string;
}

export const RECITERS: Reciter[] = [
  {
    id: "Abdul_Basit_Mujawwad_128kbps",
    name: "Abdul Basit Abdus Samad — mujawwad",
    arabic: "عبد الباسط عبد الصمد",
    style: "mujawwad",
    note: "The most celebrated mujawwad voice; enormous breath control and range. The default for an emotive reel.",
  },
  {
    id: "Minshawy_Mujawwad_192kbps",
    name: "Muhammad Siddiq Al-Minshawi — mujawwad",
    arabic: "محمد صديق المنشاوي",
    style: "mujawwad",
    note: "Widely described as the most moving of the classical reciters — softer and more plaintive than Abdul Basit.",
  },
  {
    id: "Mohammad_al_Tablaway_64kbps",
    name: "Mohammad Al-Tablawi",
    arabic: "محمد الطبلاوي",
    style: "mujawwad",
    note: "Classical Egyptian mujawwad, strong and declamatory.",
  },
  {
    id: "Abdul_Basit_Murattal_64kbps",
    name: "Abdul Basit Abdus Samad — murattal",
    arabic: "عبد الباسط عبد الصمد",
    style: "murattal",
    note: "The same voice, measured. Fits far more ayat into a short reel.",
  },
  {
    id: "Minshawy_Murattal_128kbps",
    name: "Muhammad Siddiq Al-Minshawi — murattal",
    arabic: "محمد صديق المنشاوي",
    style: "murattal",
    note: "Gentle and very clear; a common choice for teaching.",
  },
  {
    id: "Husary_64kbps",
    name: "Mahmoud Khalil Al-Husary",
    arabic: "محمود خليل الحصري",
    style: "murattal",
    note: "The reference recording for tajwid precision. Even and deliberate rather than emotive.",
  },
  {
    id: "Husary_Mujawwad_64kbps",
    name: "Mahmoud Khalil Al-Husary — mujawwad",
    arabic: "محمود خليل الحصري",
    style: "mujawwad",
    note: "Al-Husary's melodic register — precision with far more weight behind it.",
  },
  {
    id: "Alafasy_64kbps",
    name: "Mishary Rashid Alafasy",
    arabic: "مشاري راشد العفاسي",
    style: "murattal",
    note: "Warm modern voice and probably the most recognised today; reads well over a soft background.",
  },
  {
    id: "Yasser_Ad-Dussary_128kbps",
    name: "Yasser Al-Dosari",
    arabic: "ياسر الدوسري",
    style: "murattal",
    note: "Emotive contemporary reciter, widely used in short-form video.",
  },
  {
    id: "Ghamadi_40kbps",
    name: "Saad Al-Ghamdi",
    arabic: "سعد الغامدي",
    style: "murattal",
    note: "Calm and flowing; easy to listen to at length.",
  },
  {
    id: "Muhammad_Ayyoub_128kbps",
    name: "Muhammad Ayyoub",
    arabic: "محمد أيوب",
    style: "murattal",
    note: "Late imam of the Prophet's Mosque — gentle, unhurried, quietly moving.",
  },
  {
    id: "Maher_AlMuaiqly_64kbps",
    name: "Maher Al-Muaiqly",
    arabic: "ماهر المعيقلي",
    style: "murattal",
    note: "Imam of the Grand Mosque; clear and resonant.",
  },
  {
    id: "Abdurrahmaan_As-Sudais_64kbps",
    name: "Abdurrahman As-Sudais",
    arabic: "عبدالرحمن السديس",
    style: "murattal",
    note: "Imam of the Grand Mosque; powerful and instantly familiar.",
  },
  {
    id: "Saood_ash-Shuraym_64kbps",
    name: "Saud Ash-Shuraim",
    arabic: "سعود الشريم",
    style: "murattal",
    note: "Deep and grave; pairs well with ayat of warning.",
  },
  {
    id: "Ahmed_ibn_Ali_al_Ajamy_128kbps",
    name: "Ahmed Al-Ajamy",
    arabic: "أحمد بن علي العجمي",
    style: "murattal",
    note: "Rich tone with noticeable emotion.",
  },
  {
    id: "Hani_Rifai_192kbps",
    name: "Hani Ar-Rifai",
    arabic: "هاني الرفاعي",
    style: "murattal",
    note: "Steady and bright; good intelligibility under music.",
  },
];

export const DEFAULT_RECITER = "Abdul_Basit_Mujawwad_128kbps";

export const reciterById = (id: string): Reciter | undefined => RECITERS.find((r) => r.id === id);

/** everyayah-style naming: three-digit surah, three-digit ayah. */
export const ayahFile = (surah: number, ayah: number): string =>
  `${String(surah).padStart(3, "0")}${String(ayah).padStart(3, "0")}.mp3`;

/** Shared clip cache — one copy of an ayat serves every verse set. */
export const RECITATION_DIR = path.join(ROOT, "assets", "recitation");

export const clipPath = (reciter: string, surah: number, ayah: number): string =>
  path.join(RECITATION_DIR, reciter, ayahFile(surah, ayah));

// ── how a recitation opens ────────────────────────────────────────────────────
/**
 * Reciting begins with the ta'awwudh; a surah then opens with the basmala.
 * Starting mid-surah, the ta'awwudh alone is the usual choice.
 *
 * The per-ayat host numbers each surah's basmala as ayah 000, so it arrives in
 * the reciter's own voice and maqam rather than being borrowed from al-Fatiha.
 * There is no such file for the ta'awwudh — supply a clip, or show it silently.
 */
export const OPENINGS = {
  taawwudh: {
    arabic: "\u0623\u064E\u0639\u064F\u0648\u0630\u064F \u0628\u0650\u0627\u0644\u0644\u0651\u064E\u0647\u0650 \u0645\u0650\u0646\u064E \u0627\u0644\u0634\u0651\u064E\u064A\u0652\u0637\u064E\u0627\u0646\u0650 \u0627\u0644\u0631\u0651\u064E\u062C\u0650\u064A\u0645\u0650",
    bangla: "\u0986\u09AE\u09BF \u09AC\u09BF\u09A4\u09BE\u09DC\u09BF\u09A4 \u09B6\u09DF\u09A4\u09BE\u09A8 \u09A5\u09C7\u0995\u09C7 \u0986\u09B2\u09CD\u09B2\u09BE\u09B9\u09B0 \u0986\u09B6\u09CD\u09B0\u09DF \u099A\u09BE\u0987\u0964",
  },
  basmala: {
    arabic: "\u0628\u0650\u0633\u0652\u0645\u0650 \u0627\u0644\u0644\u0651\u064E\u0647\u0650 \u0627\u0644\u0631\u0651\u064E\u062D\u0652\u0645\u064E\u0670\u0646\u0650 \u0627\u0644\u0631\u0651\u064E\u062D\u0650\u064A\u0645\u0650",
    bangla: "\u09AA\u09B0\u09AE \u0995\u09B0\u09C1\u09A3\u09BE\u09AE\u09DF, \u0985\u09B8\u09C0\u09AE \u09A6\u09DF\u09BE\u09B2\u09C1 \u0986\u09B2\u09CD\u09B2\u09BE\u09B9\u09B0 \u09A8\u09BE\u09AE\u09C7\u0964",
  },
} as const;

/** At-Tawbah is the one surah that opens without the basmala. */
export const NO_BASMALA_SURAH = 9;

/** Bundled OFL faces, handed to libass via the ass filter's fontsdir. */
export const FONTS_DIR = path.join(ROOT, "assets", "fonts");
export const ARABIC_FACES = ["Amiri Quran", "Scheherazade New", "Amiri"];
export const BANGLA_FACES = ["Hind Siliguri", "Noto Serif Bengali"];

