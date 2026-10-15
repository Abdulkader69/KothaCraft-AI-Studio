/**
 * Local UI server — `npm run ui`, then open http://localhost:5180
 *
 * Drives the existing pipeline scripts; nothing here duplicates their logic.
 * Binds to localhost only. API keys arrive per-request and are passed to the
 * child process as env vars — they are never written to .env.
 */
import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  BRAND_DEFAULT,
  CARDS,
  CARD_DEFAULTS,
  DIALOGUES,
  MUSIC_DIR,
  REELS,
  ROOT,
  VERSES,
  env,
  loadEnv,
} from '../src/config';
import { mfluxInstalled } from '../src/providers/images';
import { wanInstalled, ltx2Installed, LTX2_BIN, LTX2_CACHE } from '../src/providers/video';
import {
  AI_VIDEOS_DIR,
  AI_THUMBS_DIR,
  readVideoMeta,
  buildLtx2Args,
  deleteAiVideo,
  saveAiVideoToStock,
  generateThumb,
} from '../src/video-studio';

import {
  metaAuthUrl,
  metaConfigured,
  metaConnected,
  metaExchangeCode,
  metaPages,
  metaSelectPage,
} from '../src/publish/meta';
import {
  clearStore,
  readPublish,
  readSchedules,
  writeSchedules,
  ScheduledJob,
} from '../src/publish/store';
import { postText } from '../src/publish/text';
import {
  youtubeAuthUrl,
  youtubeChannel,
  youtubeConfigured,
  youtubeConnected,
  youtubeExchangeCode,
} from '../src/publish/youtube';
import {
  tiktokAccount,
  tiktokAuthUrl,
  tiktokConfigured,
  tiktokConnected,
  tiktokExchangeCode,
} from '../src/publish/tiktok';
import {
  EDGE_VOICES,
  PIPER_STORE,
  PIPER_VENV,
  edgeInstalled,
  piperInstalled,
  vitsBdInstalled,
  synthesizeDialogue,
  resolveEdgeSpeaker,
  resolveVitsBdSpeaker,
} from '../src/providers/tts';
import { STOCK_DIR, STOCK_EXT, listStock } from '../src/stock';
import { DEFAULT_RECITER, RECITERS, clipPath } from '../src/reciters';
import { ensureDir, hasFilter, probeDuration } from '../src/util';

const PORT = Number(env('UI_PORT', '5180'));
/** Shared logo library — the project file points at `assets/brand/<file>`. */
const BRAND_DIR = path.join(ROOT, 'assets', 'brand');
const BRAND_EXT = /\.(png|jpe?g|webp)$/i;
const PUBLIC = path.join(ROOT, 'public');
const LAST = path.join(REELS, '.last');

/**
 * Folder-safe name derived from the reel title.
 *
 * NFC, not NFKD: decomposing splits Bengali/Devanagari into base letters plus
 * combining marks, and marks are \p{M} rather than \p{L}, so a mark-stripping
 * filter turns "জ্ঞানের" into "-ন-র". Keeping \p{M} preserves conjuncts.
 */
function slugify(title: string): string {
  const cleaned = (title || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  // Slice by code point. Orphaned trailing marks are only stripped when the
  // slice actually cut a cluster — otherwise a legitimate final vowel sign
  // (মর্যাদা -> মর্যাদ) would be lost.
  const chars = Array.from(cleaned);
  const truncated = chars.length > 60;
  let s = chars.slice(0, 60).join('').replace(/-+$/u, '');
  if (truncated) s = s.replace(/\p{M}+$/u, '').replace(/-+$/u, '');
  return s || 'untitled';
}

/** Every path a reel owns, derived from its slug. Checks dialogue, verses, cards and reels. */
function reelPaths(
  slug: string,
  preferFolder?: 'dialogue' | 'reels' | 'verses' | 'cards',
) {
  const inDialogue = path.join(DIALOGUES, slug);
  const inVerses = path.join(VERSES, slug);
  const inCards = path.join(CARDS, slug);
  const inReels = path.join(REELS, slug);
  const dir = fs.existsSync(path.join(inDialogue, 'project.json'))
    ? inDialogue
    : fs.existsSync(path.join(inVerses, 'project.json'))
      ? inVerses
      : fs.existsSync(path.join(inCards, 'project.json'))
        ? inCards
        : fs.existsSync(path.join(inReels, 'project.json'))
          ? inReels
          : preferFolder === 'dialogue'
            ? inDialogue
            : preferFolder === 'verses'
              ? inVerses
              : preferFolder === 'cards'
                ? inCards
                : inReels;
  return {
    slug,
    dir,
    project: path.join(dir, 'project.json'),
    images: path.join(dir, '01-images'),
    motion: path.join(dir, '02-motion'),
    texture: path.join(dir, '03-texture'),
    final: path.join(dir, 'final.mp4'),
    picks: path.join(dir, 'stock.json'),
  };
}

/**
 * Every extra cut that has rendered: a hook letter ("b"), a platform code
 * ("ig"), or both ("b-ig"), so the page can offer them as tabs.
 */
const VARIANT = /^[a-z]{1,2}(-[a-z]{2})?$/;
function variantsOf(reel: ReturnType<typeof reelPaths>): string[] {
  if (!fs.existsSync(reel.dir)) return [];
  return fs
    .readdirSync(reel.dir)
    .map((f) => /^final-([a-z-]+)\.mp4$/.exec(f)?.[1])
    .filter((v): v is string => !!v && VARIANT.test(v))
    .sort();
}
const finalOf = (reel: ReturnType<typeof reelPaths>, variant: string) =>
  VARIANT.test(variant)
    ? path.join(reel.dir, `final-${variant}.mp4`)
    : reel.final;

/**
 * Accepts non-Latin folder names, and the "day-29 - title" shape (spaces inside),
 * still refuses anything that could escape the reels directory — separators,
 * dots, or a leading/trailing space.
 */
const isSlug = (s: string) =>
  typeof s === 'string' &&
  s.length > 0 &&
  s.length <= 120 &&
  !s.includes('/') &&
  !s.includes('\\') &&
  !s.includes('..') &&
  /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M} _:,-]*[\p{L}\p{N}\p{M}]$|^[\p{L}\p{N}\p{M}]$/u.test(
    s.normalize('NFC'),
  );

/**
 * Sequential numbered folder for dialogue reels: "01: <Title>", "02: <Title>", etc.
 * Reuses existing folder if the title matches, or assigns the next sequential number.
 */
function nextDialogueFolder(title: string): string {
  const cleanTitle = (title || 'নতুন সংলাপ রিল')
    .normalize('NFC')
    .replace(/[\/\\*?"<>|\x00-\x1f]+/g, ' ')
    .trim()
    .slice(0, 80);

  let maxNum = 0;
  if (fs.existsSync(DIALOGUES)) {
    for (const d of fs.readdirSync(DIALOGUES)) {
      if (!isSlug(d)) continue;
      const m = /^(\d+)\s*:\s*(.*)$/.exec(d);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxNum) maxNum = n;
        if (m[2].trim() === cleanTitle) return d;
      } else if (d === cleanTitle) {
        return d;
      }
    }
  }
  const nextNum = String(maxNum + 1).padStart(2, '0');
  const folderName = `${nextNum}: ${cleanTitle}`;
  return isSlug(folderName) ? folderName : `${nextNum}-${slugify(cleanTitle)}`;
}

/**
 * Folder for a project: "<file> - <title-slug>" when it came from a file
 * (day-29.json → "day-29 - সদকা-সম্পদ-কমায়-না"; the 17th of a bundle →
 * "bundle-17 - …"), else the title slug alone. `project.folder` pins it outright.
 */
function folderFor(p: any): string {
  if (p?.folder === 'dialogue' || p?.isDialogue || p?.voice?.mode === 'dialogue') {
    if (isSlug(p?.slug ?? '') && p.slug !== 'dialogue') return p.slug;
    return nextDialogueFolder(p?.title);
  }
  if (isSlug(p?.folder ?? '') && p.folder !== 'reels') return p.folder;
  const slug = slugify(p?.title);
  const from =
    typeof p?.__from === 'string'
      ? path.basename(p.__from).replace(/\.json$/i, '')
      : '';
  if (!from) return slug;
  const stem = from
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\p{M} _-]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const nth =
    Number(p.__count) > 1
      ? `-${String(Number(p.__index) + 1).padStart(2, '0')}`
      : '';
  const name = `${stem}${nth} - ${slug}`.slice(0, 120).trim();
  return isSlug(name) ? name : slug;
}

function currentSlug(): string {
  try {
    const s = fs.readFileSync(LAST, 'utf8').trim();
    if (isSlug(s) && fs.existsSync(reelPaths(s).project)) return s;
  } catch {}
  const all = listReels();
  return all[0]?.slug ?? '';
}

function listReels() {
  const seen = new Set<string>();
  const out: any[] = [];
  const scan = (baseDir: string, folderName: string) => {
    if (!fs.existsSync(baseDir)) return;
    for (const d of fs.readdirSync(baseDir)) {
      if (!isSlug(d) || seen.has(d)) continue;
      const projPath = path.join(baseDir, d, 'project.json');
      if (!fs.existsSync(projPath)) continue;
      seen.add(d);
      const r = reelPaths(d);
      let project: any = {};
      try {
        project = JSON.parse(fs.readFileSync(projPath, 'utf8'));
      } catch {}
      const stat = fs.statSync(projPath);
      out.push({
        slug: d,
        folder: folderName,
        title: project.title ?? d,
        scenes: (project.scenes ?? project.verses ?? project.cards ?? []).length,
        footage: project.footage === 'stock' ? 'stock' : 'images',
        hasVideo: fs.existsSync(r.final),
        variants: variantsOf(r),
        published: Object.keys(readPublish(r.dir)),
        updated: stat.mtimeMs,
        isDialogue: project.voice?.mode === 'dialogue' || folderName === 'dialogue',
      });
    }
  };
  scan(DIALOGUES, 'dialogue');
  scan(REELS, 'reels');
  scan(VERSES, 'verses');
  return out.sort((a, b) => b.updated - a.updated);
}

/** ffmpeg-full is keg-only, so never trust the inherited PATH to contain it. */
const FFMPEG_BIN = '/opt/homebrew/opt/ffmpeg-full/bin';
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const PATH = fs.existsSync(FFMPEG_BIN)
    ? `${FFMPEG_BIN}:${process.env.PATH}`
    : process.env.PATH;
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra))
    if (v !== '' && v != null) clean[k] = String(v);
  return { ...process.env, PATH, ...clean };
}

// ── stock footage ─────────────────────────────────────────────────────────────
/** A library-relative clip path from the browser, or "" if it is not in the library. */
function stockName(q: string): string {
  const name = q.normalize('NFC');
  return name &&
    !name.includes('..') &&
    !path.isAbsolute(name) &&
    listStock().includes(name)
    ? name
    : '';
}

/** Length and size of a clip, probed once per file version. */
const stockCache = new Map<
  string,
  {
    mtime: number;
    info: {
      name: string;
      seconds: number;
      width: number;
      height: number;
      bytes: number;
    };
  }
>();
function stockInfo(name: string) {
  const file = path.join(STOCK_DIR, name);
  const st = fs.statSync(file);
  const hit = stockCache.get(name);
  if (hit && hit.mtime === st.mtimeMs) return hit.info;
  let width = 0,
    height = 0;
  try {
    const out = execFileSync(
      'ffprobe',
      [
        '-v',
        'error',
        '-select_streams',
        'v:0',
        '-show_entries',
        'stream=width,height',
        '-of',
        'csv=p=0',
        file,
      ],
      { env: childEnv(), encoding: 'utf8' },
    );
    [width, height] = out.trim().split(',').map(Number);
  } catch {}
  const savedPath = process.env.PATH;
  process.env.PATH = childEnv().PATH;
  let seconds = 0;
  try {
    seconds = Math.round(probeDuration(file) * 10) / 10;
  } finally {
    process.env.PATH = savedPath;
  }
  const info = { name, seconds, width, height, bytes: st.size };
  stockCache.set(name, { mtime: st.mtimeMs, info });
  return info;
}

// ── log fan-out ───────────────────────────────────────────────────────────────
const clients = new Set<http.ServerResponse>();
const ANSI = /\x1b\[[0-9;]*m/g;

function broadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(payload);
}

// ── single job at a time ──────────────────────────────────────────────────────
let job: ChildProcess | null = null;
let jobLabel = '';
let oauthState = '';

function runScript(
  script: string,
  args: string[],
  overrides: Record<string, string>,
  label: string,
  reel: ReturnType<typeof reelPaths>,
  onDone: (code: number, output: string) => void,
): boolean {
  if (job) return false;
  jobLabel = label;
  let output = '';
  // OUT_DIR is read at import time by src/config, so each render writes into
  // its own reel folder instead of a shared out/.
  const child = spawn(
    'npx',
    ['tsx', `scripts/${script}.ts`, '--project', reel.project, ...args],
    {
      cwd: ROOT,
      env: childEnv({ ...overrides, OUT_DIR: reel.dir }),
    },
  );
  job = child;
  broadcast('start', { label });

  const pump = (buf: Buffer) => {
    const text = buf.toString();
    output += text;
    for (const line of text.split('\n')) {
      const clean = line.replace(ANSI, '').trimEnd();
      if (clean.trim()) broadcast('log', { line: clean });
    }
  };
  child.stdout?.on('data', pump);
  child.stderr?.on('data', pump);

  child.on('close', (code) => {
    job = null;
    onDone(code ?? 1, output);
    broadcast('done', { label, code: code ?? 1, ok: code === 0 });
    // Batch items resume themselves; a one-off job finishing also frees the queue.
    if (!label.startsWith('batch ')) setTimeout(pumpQueue, 300);
    setTimeout(checkSchedules, 500);
  });
  return true;
}

// ── scheduled publish queue ──────────────────────────────────────────────────
function checkSchedules(): void {
  if (job) return;
  const schedules = readSchedules();
  const now = Date.now();
  const due = schedules.find((s) => s.status === 'pending' && s.scheduledTime <= now);
  if (!due) return;

  const reel = reelPaths(due.slug);
  if (!fs.existsSync(reel.final)) {
    due.status = 'failed';
    due.error = 'no final.mp4 found; render first';
    writeSchedules(schedules);
    broadcast('schedules', schedules);
    return;
  }

  due.status = 'running';
  writeSchedules(schedules);
  broadcast('schedules', schedules);

  const args = [
    '--to',
    due.platforms.join(','),
    ...(due.privacy ? ['--privacy', due.privacy] : []),
    '--again',
  ];

  const started = runScript(
    'publish',
    args,
    {},
    `scheduled publish ${due.slug} → ${due.platforms.join(', ')}`,
    reel,
    (code, output) => {
      const cur = readSchedules();
      const item = cur.find((s) => s.id === due.id);
      if (item) {
        item.status = code === 0 ? 'completed' : 'failed';
        if (code !== 0) {
          const errLine = (output || '')
            .split('\n')
            .map((s) => s.trim())
            .filter((s) => s.includes('failed:') || s.includes('Error:') || s.toLowerCase().includes('error'))
            .pop();
          item.error = errLine ? errLine.replace(/^\[publish\]\s*/, '') : `publish exited with code ${code}`;
        }
        writeSchedules(cur);
        broadcast('schedules', cur);
      }
      broadcast('published', {
        slug: due.slug,
        ok: code === 0,
        published: readPublish(reel.dir),
      });
      setTimeout(checkSchedules, 500);
    },
  );

  if (!started) {
    due.status = 'pending';
    writeSchedules(schedules);
  }
}

setInterval(checkSchedules, 10_000);

// ── batch queue ───────────────────────────────────────────────────────────────
// Reels render one after another through the same single-job lock. The queue
// is persisted so a server restart carries on where it left off.
interface QueueItem {
  id: string;
  slug: string;
  title: string;
  status: 'queued' | 'running' | 'done' | 'failed' | 'skipped';
  settings: Record<string, unknown>;
  fresh: boolean;
  code?: number;
  startedAt?: number;
  finishedAt?: number;
}
const QUEUE_FILE = path.join(REELS, '.queue.json');
let queue: QueueItem[] = [];
let queuePaused = false;

function loadQueue(): void {
  try {
    const saved = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8')) as {
      items: QueueItem[];
      paused?: boolean;
    };
    // A render that was mid-flight when the server died goes back to the front.
    queue = (saved.items ?? []).map((q) =>
      q.status === 'running'
        ? { ...q, status: 'queued' as const, startedAt: undefined }
        : q,
    );
    queuePaused = Boolean(saved.paused);
  } catch {
    queue = [];
  }
}
function saveQueue(): void {
  ensureDir(REELS);
  fs.writeFileSync(
    QUEUE_FILE,
    JSON.stringify({ items: queue, paused: queuePaused }, null, 2),
  );
}
function queueState() {
  return {
    items: queue,
    paused: queuePaused,
    busy: Boolean(job),
    current: job ? jobLabel : '',
  };
}
function queueChanged(): void {
  saveQueue();
  broadcast('queue', queueState());
}

/** Start the next queued reel if nothing is running. Called after every job ends. */
function pumpQueue(): void {
  if (job || queuePaused) return;
  const next = queue.find((q) => q.status === 'queued');
  if (!next) return;
  const reel = reelPaths(next.slug);
  if (!fs.existsSync(reel.project)) {
    next.status = 'failed';
    next.code = 1;
    next.finishedAt = Date.now();
    queueChanged();
    pumpQueue();
    return;
  }
  if (next.fresh) {
    for (const f of fs.readdirSync(reel.dir))
      if (f !== 'project.json')
        fs.rmSync(path.join(reel.dir, f), { recursive: true, force: true });
  }
  next.status = 'running';
  next.startedAt = Date.now();
  fs.writeFileSync(LAST, next.slug);
  queueChanged();
  const started = runScript(
    'pipeline',
    [],
    settingsEnv(next.settings),
    `batch ${queue.indexOf(next) + 1}/${queue.length}: ${next.slug}`,
    reel,
    (code) => {
      if (next.status === 'running')
        next.status = code === 0 ? 'done' : 'failed';
      next.code = code;
      next.finishedAt = Date.now();
      queueChanged();
      // A short breather so a cancel that was aimed at this reel lands before the next starts.
      setTimeout(pumpQueue, 800);
    },
  );
  if (!started) {
    next.status = 'queued';
    next.startedAt = undefined;
    queueChanged();
  }
}

// ── project file ──────────────────────────────────────────────────────────────
interface UiScene {
  id?: string;
  prompt: string;
  narration: string;
  motion?: string;
  seed?: number;
  clip?: string;
}

/**
 * `body.base` is whatever project file the page imported. The form only exposes a
 * handful of fields, so everything else — music, texture, image.negative, caption
 * colours, scenes[].seconds — is carried through untouched rather than silently lost.
 */
function writeProject(
  body: any,
  reel: ReturnType<typeof reelPaths>,
  remember = true,
): any {
  const base = body.base ?? {};
  const scenes = (body.scenes ?? []).map(
    (s: UiScene & Record<string, unknown>, i: number) => {
      const { motion, motionPrompt, seed, id, clip, ...rest } = s;
      return {
        ...rest,
        id: String(i + 1).padStart(2, '0'),
        prompt: s.prompt ?? '',
        narration: s.narration ?? '',
        ...(motion ? { motion } : {}),
        ...(motion === 'ai' &&
        typeof motionPrompt === 'string' &&
        motionPrompt.trim()
          ? { motionPrompt: motionPrompt.trim() }
          : {}),
        ...(Number.isFinite(seed) ? { seed: Number(seed) } : {}),
        ...(typeof clip === 'string' && clip.trim()
          ? { clip: clip.trim() }
          : {}),
      };
    },
  );
  const project = {
    ...base,
    title: body.title || base.title || 'Untitled reel',
    aspect: body.aspect || base.aspect || '9:16',
    platform: (body.platform ?? base.platform) || undefined,
    // Extra per-platform cuts. The form sends the list whole, so it replaces.
    platforms: (() => {
      const list = Array.isArray(body.platforms)
        ? body.platforms
        : base.platforms;
      const clean = [
        ...new Set(
          (Array.isArray(list) ? list : []).filter((p: string) =>
            ['instagram', 'facebook', 'tiktok', 'youtube'].includes(p),
          ),
        ),
      ];
      return clean.length ? clean : undefined;
    })(),
    // The Local video page sends "stock"; the Reels page sends nothing and keeps what was there.
    footage: (body.footage ?? base.footage) === 'stock' ? 'stock' : undefined,
    // The page's ticked shortlist replaces the file's; absent (Reels page) keeps it.
    stock: (() => {
      const st: Record<string, unknown> = { ...(base.stock ?? {}) };
      if (Array.isArray(body.stockOnly)) {
        const only = body.stockOnly
          .filter((x: unknown) => typeof x === 'string' && x.trim())
          .map((x: string) => x.trim());
        if (only.length) st.only = only;
        else delete st.only;
      }
      const mode = body.stockMode || body.stock?.mode || base.stock?.mode;
      if (mode) {
        st.mode = mode === 'continuous' ? 'continuous' : 'scene';
      }
      return Object.keys(st).length ? st : undefined;
    })(),
    fps: base.fps ?? 30,
    gap: body.gap !== undefined ? Number(body.gap) : (base.gap ?? 0.65),
    image: {
      ...(base.image ?? {}),
      style: body.style ?? base.image?.style ?? '',
    },
    // The voice picked in the page wins over whatever the imported project had —
    // otherwise a stale voiceId (e.g. an old library voice) silently overrides the
    // dropdown and .env, because src/providers/tts prefers project over env.
    voice: (() => {
      const v: Record<string, unknown> = { ...(base.voice ?? {}) };
      v.kokoroVoice = body.kokoroVoice || undefined;
      v.lang = body.kokoroLang || undefined;
      if (
        body.settings?.piperSpeaker !== undefined &&
        body.settings.piperSpeaker !== ''
      )
        v.piperSpeaker = Number(body.settings.piperSpeaker);
      if (body.settings?.edgeVoice) v.edgeVoice = body.settings.edgeVoice;
      else delete v.edgeVoice;
      if (body.settings?.edgeRate) v.edgeRate = body.settings.edgeRate;
      else delete v.edgeRate;
      if (body.settings?.geminiVoice) v.geminiVoice = body.settings.geminiVoice;
      else delete v.geminiVoice;
      if (body.settings?.elevenVoiceId) v.voiceId = body.settings.elevenVoiceId;
      else delete v.voiceId; // fall through to ELEVENLABS_VOICE_ID in .env
      if (body.voice?.speakers) {
        const spks: Record<string, any> = { ...body.voice.speakers };
        for (const [key, spk] of Object.entries(spks)) {
          const resolved = resolveEdgeSpeaker(key, spk);
          if (!spk.edgeVoice) spk.edgeVoice = resolved.voice;
          if (!spk.edgeRate) spk.edgeRate = resolved.rate;
          if (!spk.edgePitch) spk.edgePitch = resolved.pitch;
        }
        v.speakers = spks;
      }
      if (body.voice?.mode) v.mode = body.voice.mode;
      if (body.voice?.provider) v.provider = body.voice.provider;
      return v;
    })(),
    // The form only toggles visibility; style, colours and font come from the import.
    captions: (() => {
      const c: Record<string, unknown> = {
        ...(base.captions ?? { style: 'highlight', wordsPerCue: 3 }),
        ...(body.captions ?? {}),
      };
      if (c.show !== false) delete c.show;
      return c;
    })(),
    // `file: undefined` from the form means "auto" — drop it so render-music
    // falls back to the shared library instead of chasing a stale path.
    music: Object.fromEntries(
      Object.entries({ ...(base.music ?? {}), ...(body.music ?? {}) }).filter(
        ([, v]) => v !== undefined && v !== null && v !== '',
      ),
    ),
    brand: cleanBrand(body.brand === undefined ? base.brand : body.brand),
    hooks: cleanHooks(body.hooks === undefined ? base.hooks : body.hooks),
    intro: cleanCard(body.intro === undefined ? base.intro : body.intro),
    outro: cleanCard(body.outro === undefined ? base.outro : body.outro),
    scenes,
  };
  for (const k of [
    'brand',
    'intro',
    'outro',
    'platform',
    'platforms',
    'hooks',
    'footage',
    'stock',
  ] as const)
    if (!project[k] || project[k] === 'none') delete project[k];
  const br = project.brand as Record<string, unknown> | undefined;
  if (
    br &&
    !br.off &&
    !br.image &&
    br.text === BRAND_DEFAULT.text &&
    (br.position ?? 'top-right') === BRAND_DEFAULT.position &&
    ['size', 'opacity', 'margin', 'color'].every((k) => br[k] === undefined)
  )
    delete project.brand;
  // Cards that just say "default" need not be written at all.
  for (const k of ['intro', 'outro'] as const) {
    const c = project[k],
      d = CARD_DEFAULTS[k] as { seconds: number; text?: string };
    if (c && c.seconds === d.seconds && (!c.text || c.text === d.text))
      delete project[k];
  }
  ensureDir(reel.dir);
  fs.writeFileSync(reel.project, JSON.stringify(project, null, 2));
  if (remember) {
    ensureDir(REELS);
    fs.writeFileSync(LAST, reel.slug);
  }
  return project;
}

/** Scratch "reel" for voice previews — lives under out/tmp, never in the gallery. */
const PREVIEW = {
  ...reelPaths('voice-preview'),
  dir: path.join(ROOT, 'out', 'tmp', 'voice-preview'),
};
PREVIEW.project = path.join(PREVIEW.dir, 'project.json');
const PREVIEW_MP3 = path.join(PREVIEW.dir, 'preview.mp3');

/**
 * The form sends the whole brand block (or null for "off"), so it replaces rather
 * than merges. Only a text or an image makes it a watermark; numbers are coerced.
 */
function cleanBrand(b: any): Record<string, unknown> | undefined {
  if (b === null) return { off: true }; // the form's "off"
  if (!b || typeof b !== 'object') return undefined; // absent → pipeline default
  if (b.off) return { off: true };
  const out: Record<string, unknown> = {};
  const text = String(b.text ?? '').trim();
  const image = String(b.image ?? '').trim();
  if (image) out.image = image;
  else if (text) out.text = text;
  else return undefined;
  if (
    ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(
      b.position,
    )
  )
    out.position = b.position;
  for (const k of ['size', 'opacity', 'margin'] as const) {
    if (b[k] !== undefined && b[k] !== '' && Number.isFinite(Number(b[k])))
      out[k] = Number(b[k]);
  }
  if (typeof b.color === 'string' && b.color.trim()) out.color = b.color.trim();
  return out;
}

/** Hook variants: keep only entries that actually change something about scene 1. */
function cleanHooks(h: any): Record<string, unknown>[] | undefined {
  if (!Array.isArray(h)) return undefined;
  const out = h
    .slice(0, 3)
    .map((x) => {
      const o: Record<string, unknown> = {};
      if (typeof x?.prompt === 'string' && x.prompt.trim())
        o.prompt = x.prompt.trim();
      if (typeof x?.narration === 'string' && x.narration.trim())
        o.narration = x.narration.trim();
      if (Number.isFinite(Number(x?.seed)) && x?.seed !== '' && x?.seed != null)
        o.seed = Number(x.seed);
      if (
        [
          'in',
          'out',
          'left',
          'right',
          'cinematic',
          'cinematic-out',
          'ai',
        ].includes(x?.motion)
      )
        o.motion = x.motion;
      if (typeof x?.clip === 'string' && x.clip.trim()) o.clip = x.clip.trim();
      return o;
    })
    .filter((o) => o.prompt || o.narration || o.clip);
  return out.length ? out : undefined;
}

/**
 * Intro/outro card. Absent → the pipeline's defaults (3 s title, 6 s follow card);
 * `seconds: 0` is kept, because it is how a project turns a card off.
 */
function cleanCard(c: any): { seconds: number; text?: string } | undefined {
  if (!c || typeof c !== 'object') return undefined;
  const seconds = Number(c.seconds);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  const text = String(c.text ?? '')
    .replace(/\r/g, '')
    .trim();
  return text ? { seconds, text } : { seconds };
}

// ── photo cards ───────────────────────────────────────────────────────────────
function cardPaths(slug: string) {
  const dir = path.join(CARDS, slug);
  // runScript only needs dir + project; the rest mirrors reelPaths for invalidateScene.
  return {
    slug,
    dir,
    project: path.join(dir, 'project.json'),
    images: path.join(dir, '01-images'),
    motion: path.join(dir, '02-motion'),
    texture: path.join(dir, '03-texture'),
    final: path.join(dir, 'final.mp4'),
    picks: path.join(dir, 'stock.json'),
  };
}

/** Rendered card ids in a set folder — <id>.png beside project.json. */
function renderedCards(set: ReturnType<typeof cardPaths>): string[] {
  if (!fs.existsSync(set.dir)) return [];
  return fs
    .readdirSync(set.dir)
    .map((f) => /^(\d{2})\.png$/.exec(f)?.[1])
    .filter((v): v is string => !!v)
    .sort();
}

function listCardSets() {
  if (!fs.existsSync(CARDS)) return [];
  return fs
    .readdirSync(CARDS)
    .filter(
      (d) => isSlug(d) && fs.existsSync(path.join(CARDS, d, 'project.json')),
    )
    .map((slug) => {
      const set = cardPaths(slug);
      let project: any = {};
      try {
        project = JSON.parse(fs.readFileSync(set.project, 'utf8'));
      } catch {}
      return {
        slug,
        title: project.title ?? slug,
        cards: (project.cards ?? []).length,
        rendered: renderedCards(set),
        updated: fs.statSync(set.project).mtimeMs,
      };
    })
    .sort((a, b) => b.updated - a.updated);
}

/** The card-set JSON is the contract — the form sends it whole; only tidy it. */
function writeCardSet(body: any, set: ReturnType<typeof cardPaths>): any {
  const cards = (Array.isArray(body.cards) ? body.cards : [])
    .map((c: any, i: number) => {
      const o: Record<string, unknown> = {
        id: String(i + 1).padStart(2, '0'),
        text: String(c?.text ?? '')
          .replace(/\r/g, '')
          .trim(),
      };
      for (const k of ['source', 'heading', 'prompt'] as const)
        if (typeof c?.[k] === 'string' && c[k].trim()) o[k] = c[k].trim();
      if (c?.seed !== '' && c?.seed != null && Number.isFinite(Number(c.seed)))
        o.seed = Number(c.seed);
      if (['center', 'bottom'].includes(c?.layout)) o.layout = c.layout;
      return o;
    })
    .filter((c: any) => c.text);
  const project: Record<string, unknown> = {
    title: body.title || 'Untitled cards',
    aspect: ['1:1', '4:5', '9:16'].includes(body.aspect) ? body.aspect : '1:1',
    layout: body.layout === 'bottom' ? 'bottom' : 'center',
    ...(String(body.heading ?? '').trim()
      ? { heading: String(body.heading).trim() }
      : {}),
    ...(String(body.prompt ?? '').trim()
      ? { prompt: String(body.prompt).trim() }
      : {}),
    image: {
      ...(body.image ?? {}),
      ...(body.style ? { style: body.style } : {}),
    },
    captions: body.captions ?? {},
    brand: cleanBrand(body.brand),
    cards,
  };
  if (!project.brand) delete project.brand;
  ensureDir(set.dir);
  fs.writeFileSync(set.project, JSON.stringify(project, null, 2));
  return project;
}

// ── verse sets ────────────────────────────────────────────────────────────────
function versePaths(slug: string) {
  const dir = path.join(VERSES, slug);
  return {
    slug,
    dir,
    project: path.join(dir, 'project.json'),
    images: path.join(dir, '01-images'),
    motion: path.join(dir, '02-motion'),
    texture: path.join(dir, '03-texture'),
    final: path.join(dir, 'final.mp4'),
    picks: path.join(dir, 'stock.json'),
  };
}

/** Theme names come from the folder, so a new preset shows up without a rebuild. */
function bgThemes(): { name: string; note: string }[] {
  const dir = path.join(ROOT, 'scripts', 'bg', 'themes');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => {
      let note = '';
      try {
        note =
          JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))._note ?? '';
      } catch {}
      return { name: f.replace(/\.json$/, ''), note };
    });
}

function listVerseSets() {
  if (!fs.existsSync(VERSES)) return [];
  return fs
    .readdirSync(VERSES)
    .filter(
      (d) => isSlug(d) && fs.existsSync(path.join(VERSES, d, 'project.json')),
    )
    .map((slug) => {
      const set = versePaths(slug);
      let project: any = {};
      try {
        project = JSON.parse(fs.readFileSync(set.project, 'utf8'));
      } catch {}
      return {
        slug,
        title: project.title ?? slug,
        theme: project.theme ?? '',
        verses: (project.verses ?? []).length,
        rendered: fs.existsSync(set.final),
        updated: fs.statSync(set.project).mtimeMs,
      };
    })
    .sort((a, b) => b.updated - a.updated);
}

/** The verse-set JSON is the contract — the form sends it whole; only tidy it. */
function writeVerseSet(body: any, set: ReturnType<typeof versePaths>): any {
  const verses = (Array.isArray(body.verses) ? body.verses : [])
    .map((v: any, i: number) => {
      const o: Record<string, unknown> = {
        id: String(i + 1).padStart(2, '0'),
        arabic: String(v?.arabic ?? '')
          .replace(/\r/g, '')
          .trim(),
        bangla: String(v?.bangla ?? '')
          .replace(/\r/g, '')
          .trim(),
      };
      for (const k of ['number', 'narration', 'audio'] as const)
        if (typeof v?.[k] === 'string' && v[k].trim()) o[k] = v[k].trim();
      if (Number(v?.ayah) > 0) o.ayah = Number(v.ayah);
      if (
        v?.seconds !== '' &&
        v?.seconds != null &&
        Number.isFinite(Number(v.seconds))
      )
        o.seconds = Number(v.seconds);
      return o;
    })
    // A verse with no text at all would render an empty held frame.
    .filter((v: any) => v.arabic || v.bangla);

  const project: Record<string, unknown> = {
    title: body.title || 'Untitled verses',
    aspect: body.aspect === '1:1' ? '1:1' : '9:16',
    fps: Number(body.fps) > 0 ? Number(body.fps) : 30,
    theme: String(body.theme ?? 'night-mosque'),
    gap: Number.isFinite(Number(body.gap)) ? Number(body.gap) : 0.6,
    ...(Number(body.surah) > 0 ? { surah: Number(body.surah) } : {}),
    recitation: { reciter: String(body.reciter || DEFAULT_RECITER) },
    voiceover: body.voiceover === 'bangla' ? 'bangla' : 'none',
    opening: ['taawwudh', 'basmala', 'both'].includes(body.opening)
      ? body.opening
      : 'none',
    intro: {
      seconds: Number.isFinite(Number(body.introSeconds))
        ? Number(body.introSeconds)
        : 4,
    },
    voice: body.voice ?? {},
    music: body.music ?? {},
    type: body.type ?? {},
    brand: cleanBrand(body.brand),
    verses,
  };
  for (const k of ['arabicTitle', 'subtitle', 'range'] as const) {
    if (String(body[k] ?? '').trim()) project[k] = String(body[k]).trim();
  }
  if (String(body.outroText ?? '').trim()) {
    project.outro = {
      seconds: Number(body.outroSeconds) || 5,
      text: String(body.outroText).trim(),
    };
  }
  if (!project.brand) delete project.brand;
  ensureDir(set.dir);
  fs.writeFileSync(set.project, JSON.stringify(project, null, 2));
  return project;
}

// ── credentials in .env ───────────────────────────────────────────────────────
/** Only these may be written from the browser — never arbitrary keys. */
const SAVEABLE = [
  'CF_ACCOUNT_ID',
  'CF_API_TOKEN',
  'CF_MODEL',
  'FAL_KEY',
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'ELEVENLABS_VOICE_ID',
  'GEMINI_API_KEY',
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'META_APP_ID',
  'META_APP_SECRET',
  'TIKTOK_CLIENT_KEY',
  'TIKTOK_CLIENT_SECRET',
] as const;

const SECRET_KEYS = [
  'CF_API_TOKEN',
  'FAL_KEY',
  'OPENAI_API_KEY',
  'ELEVENLABS_API_KEY',
  'GEMINI_API_KEY',
  'YOUTUBE_CLIENT_SECRET',
  'META_APP_SECRET',
  'TIKTOK_CLIENT_SECRET',
];

const ENV_FILE = path.join(ROOT, '.env');

/** Parse .env from disk, so a key saved after boot is still seen. */
function readEnvFile(): Record<string, string> {
  if (!fs.existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && m[2]) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Update keys in place, keeping comments and ordering; append anything new. */
function saveToEnvFile(values: Record<string, string>): string[] {
  const lines = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, 'utf8').split('\n')
    : [];
  const written: string[] = [];
  for (const key of SAVEABLE) {
    if (!(key in values)) continue;
    const value = String(values[key] ?? '').trim();
    const at = lines.findIndex((l) => new RegExp(`^\\s*${key}\\s*=`).test(l));
    if (!value) {
      if (at > -1) lines.splice(at, 1); // blank clears it
      delete process.env[key];
      written.push(`${key} (cleared)`);
      continue;
    }
    if (at > -1) lines[at] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
    // Keep this process in sync, or children inherit the stale value.
    process.env[key] = value;
    written.push(key);
  }
  fs.writeFileSync(ENV_FILE, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
  loadEnv(true);
  return written;
}

function readProject(slug: string): any {
  const f = slug ? reelPaths(slug).project : '';
  return f && fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

/** Whether a scene id ("02", or "01b" for hook B) is cut from footage in this project. */
function sceneUsesStock(project: any, id: string): boolean {
  if (!project) return false;
  if (project.footage === 'stock') return true;
  const hook = id.slice(2);
  const scene = hook
    ? project.hooks?.[hook.charCodeAt(0) - 'b'.charCodeAt(0)]
    : project.scenes?.[Number(id) - 1];
  return (
    Boolean(scene?.clip) ||
    (Boolean(hook) && Boolean(project.scenes?.[0]?.clip))
  );
}

const readPicksOf = (
  reel: ReturnType<typeof reelPaths>,
): Record<string, unknown> => {
  try {
    return JSON.parse(fs.readFileSync(reel.picks, 'utf8'));
  } catch {
    return {};
  }
};

/** A new image invalidates that scene's clips and the master — `skippable` only checks existence. */
function invalidateScene(reel: ReturnType<typeof reelPaths>, id: string): void {
  const finals = [reel.final, ...variantsOf(reel).map((v) => finalOf(reel, v))];
  // A new image also invalidates any generated clip made from the old one.
  for (const f of [
    path.join(reel.motion, `${id}.mp4`),
    path.join(reel.motion, `${id}.ai.mp4`),
    path.join(reel.motion, `${id}.pp.mp4`),
    path.join(reel.motion, `${id}.src.mp4`),
    path.join(reel.texture, `${id}.mp4`),
    ...finals,
  ]) {
    fs.rmSync(f, { force: true });
  }
}

function settingsEnv(s: any = {}): Record<string, string> {
  return {
    IMAGE_PROVIDER: s.imageProvider,
    POLLINATIONS_MODEL: s.pollinationsModel,
    CF_ACCOUNT_ID: s.cfAccountId,
    CF_API_TOKEN: s.cfApiToken,
    CF_MODEL: s.cfModel,
    MFLUX_MODEL: s.mfluxModel,
    MFLUX_STEPS: s.mfluxSteps,
    FAL_KEY: s.falKey,
    VIDEO_PROVIDER: s.videoProvider,
    OPENAI_API_KEY: s.openaiKey,
    TTS_PROVIDER: s.ttsProvider,
    ELEVENLABS_API_KEY: s.elevenKey,
    ELEVENLABS_VOICE_ID: s.elevenVoiceId,
    ELEVENLABS_MODEL: s.elevenModel,
    GEMINI_API_KEY: s.geminiKey,
    GEMINI_TTS_MODEL: s.geminiModel,
    KOKORO_VOICE: s.kokoroVoice,
    KOKORO_LANG: s.kokoroLang,
    MMS_LANG: s.mmsLang,
    PIPER_SPEAKER: s.piperSpeaker,
    EDGE_VOICE: s.edgeVoice,
    EDGE_RATE: s.edgeRate,
    WORD_TIMING: s.wordTiming,
    WHISPER_CMD: s.whisperCmd,
    FONT_FILE: s.fontFile,
    CAPTION_FONT: s.captionFont,
  };
}

// ── capability probe, so the UI can grey out what is not installed ────────────
function kokoroVoices(): string[] {
  const bin = env('KOKORO_BIN', 'kokoro-tts');
  try {
    const out = execFileSync(bin, ['--help-voices'], {
      env: childEnv(),
      encoding: 'utf8',
    });
    // English only: `a*` = American, `b*` = British. The other prefixes are
    // Spanish/French/Hindi/Italian/Japanese/Portuguese/Chinese.
    return out
      .split('\n')
      .map((l) => l.match(/^\s*\d+\.\s*([a-z]{2}_[a-z]+)\s*$/i)?.[1])
      .filter((v): v is string => Boolean(v) && /^[ab][fm]_/.test(v!));
  } catch {
    return [];
  }
}

function capabilities() {
  const bin = env('KOKORO_BIN', 'kokoro-tts');
  let kokoro = false;
  try {
    execFileSync(bin, ['--version'], { env: childEnv(), stdio: 'ignore' });
    kokoro = true;
  } catch {
    kokoro = false;
  }
  const models = ['kokoro-v1.0.onnx', 'voices-v1.0.bin'].filter(
    (f) =>
      !fs.existsSync(path.join(path.resolve(env('KOKORO_MODEL_DIR', ROOT)), f)),
  );

  // hasFilter shells out to bare `ffmpeg`, so point PATH at ffmpeg-full first.
  const savedPath = process.env.PATH;
  process.env.PATH = childEnv().PATH;
  const ffmpegFound = hasFilter('scale');
  const filters = ffmpegFound
    ? ['drawtext', 'ass', 'zoompan'].filter((f) => !hasFilter(f))
    : [];
  process.env.PATH = savedPath;

  return {
    ffmpeg: {
      ok: ffmpegFound && filters.length === 0,
      found: ffmpegFound,
      missingFilters: filters,
    },
    kokoro: {
      ok: kokoro && models.length === 0,
      cli: kokoro,
      missingModels: models,
    },
    mflux: { ok: mfluxInstalled(), arm64: process.arch === 'arm64' },
    wan: { ok: wanInstalled(), arm64: process.arch === 'arm64' },
    ltx2: {
      ok: ltx2Installed(),
      model: 'LTX-2.3 Distilled Q8 (Local Apple Silicon)',
      arm64: process.arch === 'arm64',
    },

    piper: { ok: piperInstalled() },
    vitsBd: { ok: vitsBdInstalled() },
    edge: { ok: edgeInstalled(), voices: EDGE_VOICES },
    voices: kokoroVoices(),
    hasVideo: fs.existsSync(reelPaths(currentSlug() || 'x').final),
    variants: variantsOf(reelPaths(currentSlug() || 'x')),
    stock: { dir: path.relative(ROOT, STOCK_DIR), count: listStock().length },
    queue: queueState(),
    savedKeys: Object.fromEntries(
      SAVEABLE.map((k) => [k, Boolean(readEnvFile()[k])]),
    ),
    savedPublicKeys: Object.fromEntries(
      SAVEABLE.filter((k) => !SECRET_KEYS.includes(k)).map((k) => [
        k,
        readEnvFile()[k] || '',
      ]),
    ),
    envDefaults: {
      imageProvider: env('IMAGE_PROVIDER', 'pollinations'),
      ttsProvider: env('TTS_PROVIDER', 'kokoro'),
      kokoroVoice: env('KOKORO_VOICE', 'af_sarah'),
      kokoroLang: env('KOKORO_LANG', 'en-us'),
      wordTiming: env('WORD_TIMING', 'off'),
      fontFile: env('FONT_FILE', ''),
      captionFont: env('CAPTION_FONT', ''),
    },
  };
}

// ── http helpers ──────────────────────────────────────────────────────────────
function json(res: http.ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
}

/** Headers are Latin-1 only — a Bangla file name has to go in the RFC 5987 form. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '');
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function readBody(
  req: http.IncomingMessage,
  limit = 40 * 1024 * 1024,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Range-aware so the browser can scrub the result instead of only downloading it. */
function sendVideo(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  file: string,
): void {
  if (!fs.existsSync(file)) {
    res.writeHead(404).end();
    return;
  }
  const size = fs.statSync(file).size;
  const range = req.headers.range;
  const ext = path.extname(file).toLowerCase();
  const mime =
    ext === '.wav'
      ? 'audio/wav'
      : ext === '.mp3'
        ? 'audio/mpeg'
        : ext === '.m4a' || ext === '.aac'
          ? 'audio/mp4'
          : ext === '.ogg' || ext === '.opus'
            ? 'audio/ogg'
            : 'video/mp4';
  if (!range) {
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
    });
    fs.createReadStream(file).pipe(res);
    return;
  }
  const m = /bytes=(\d*)-(\d*)/.exec(range);
  const start = m?.[1] ? Number(m[1]) : 0;
  const end = m?.[2] ? Number(m[2]) : size - 1;
  res.writeHead(206, {
    'Content-Type': mime,
    'Content-Range': `bytes ${start}-${end}/${size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
  });
  fs.createReadStream(file, { start, end }).pipe(res);
}

// ── routes ────────────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const route = url.pathname;

  try {
    // Three pages share one stylesheet: / (reels), /stock (the same page, cutting
    // local footage instead of generating images) and /cards (photo cards).
    const page: Record<string, string> = {
      '/': 'index.html',
      '/index.html': 'index.html',
      '/reels': 'reels.html',
      '/reels.html': 'reels.html',
      '/stock': 'reels.html',
      '/cards': 'cards.html',

      '/cards.html': 'cards.html',
      '/verses': 'verses.html',
      '/verses.html': 'verses.html',
      '/dialogue': 'dialogue.html',
      '/dialogue.html': 'dialogue.html',
      '/video': 'video.html',
      '/video.html': 'video.html',
      '/terms': 'terms.html',

      '/terms.html': 'terms.html',
      '/privacy': 'privacy.html',
      '/privacy.html': 'privacy.html',
      '/ui.css': 'ui.css',
      '/publish-box.js': 'publish-box.js',
    };
    if (page[route]) {
      const file = path.join(PUBLIC, page[route]);
      if (!fs.existsSync(file)) {
        res.writeHead(500).end(`public/${page[route]} missing`);
        return;
      }
      res.writeHead(200, {
        'Content-Type': file.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : file.endsWith('.js')
            ? 'application/javascript; charset=utf-8'
            : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (route === '/api/state') {
      const slug = currentSlug();
      json(res, 200, {
        ...capabilities(),
        slug,
        project: readProject(slug),
        reels: listReels(),
        busy: Boolean(job),
        jobLabel,
      });
      return;
    }

    if (route === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(
        `event: hello\ndata: ${JSON.stringify({ busy: Boolean(job) })}\n\n`,
      );
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (route === '/api/render' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      // A reel loaded from the gallery renders back into its own folder as long as
      const isDialogue =
        body.folder === 'dialogue' ||
        body.isDialogue ||
        body.voice?.mode === 'dialogue';
      const loaded = isSlug(body.slug ?? '') ? readProject(body.slug) : null;
      const targetSlug =
        loaded && loaded.title === body.title && body.slug !== 'dialogue'
          ? body.slug
          : folderFor({ ...body, __from: body.from, isDialogue });
      const reel = reelPaths(targetSlug, isDialogue ? 'dialogue' : 'reels');
      if (body.fresh) fs.rmSync(reel.dir, { recursive: true, force: true });
      writeProject(body, reel);
      const started = runScript(
        'pipeline',
        [],
        settingsEnv(body.settings),
        `render ${reel.slug}`,
        reel,
        () => {},
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true } : { error: 'busy' },
      );
      return;
    }

    // One line through the chosen voice, so a provider/voice can be judged before
    // a full render. Goes through the same job lock and log stream as a render.
    if (route === '/api/preview-voice' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const text =
        String(body.text ?? '').trim() ||
        String(body.scenes?.[0]?.narration ?? '').trim();
      if (!text) {
        json(res, 400, {
          error: 'nothing to say — type a line or give scene 1 some narration',
        });
        return;
      }
      fs.rmSync(PREVIEW_MP3, { force: true });
      writeProject(
        {
          ...body,
          title: 'voice preview',
          scenes: [{ prompt: '', narration: text }],
        },
        PREVIEW,
        false,
      );
      const started = runScript(
        'preview-voice',
        ['--text', text],
        settingsEnv(body.settings),
        'voice preview',
        PREVIEW,
        (code) => {
          if (code === 0 && fs.existsSync(PREVIEW_MP3))
            broadcast('preview', { url: `/api/preview-voice?v=${Date.now()}` });
        },
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true } : { error: 'busy' },
      );
      return;
    }

    if (route === '/api/preview-voice') {
      if (!fs.existsSync(PREVIEW_MP3)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': fs.statSync(PREVIEW_MP3).size,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(PREVIEW_MP3).pipe(res);
      return;
    }

    // ── dialogue reels import & audition ───────────────────────────────────────
    if (route === '/api/dialogue/import' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const project = body.project ?? body;
        if (!project || !Array.isArray(project.scenes) || !project.title) {
          json(res, 400, {
            error: 'invalid project JSON: must have title and scenes array',
          });
          return;
        }
        if (project.voice?.speakers) {
          for (const [key, spk] of Object.entries(project.voice.speakers as Record<string, any>)) {
            const resolved = resolveEdgeSpeaker(key, spk);
            if (!spk.edgeVoice) spk.edgeVoice = resolved.voice;
            if (!spk.edgeRate) spk.edgeRate = resolved.rate;
            if (!spk.edgePitch) spk.edgePitch = resolved.pitch;
          }
        }
        const slug =
          isSlug(body.slug ?? '') && body.slug !== 'dialogue'
            ? body.slug
            : nextDialogueFolder(project.title);
        const reel = reelPaths(slug, 'dialogue');
        ensureDir(reel.dir);
        fs.writeFileSync(reel.project, JSON.stringify(project, null, 2));
        json(res, 200, { ok: true, slug, project });
      } catch (err: any) {
        json(res, 400, {
          error: `import failed: ${err?.message || String(err)}`,
        });
      }
      return;
    }

    if (route === '/api/dialogue/audition' && req.method === 'POST') {
      try {
        const body = JSON.parse((await readBody(req)).toString() || '{}');
        const tmpDir = ensureDir(
          path.join(ROOT, 'out', 'tmp', 'dialogue-audition'),
        );
        const auditionMp3 = path.join(tmpDir, 'audition.mp3');
        fs.rmSync(auditionMp3, { force: true });

        const lines = Array.isArray(body.lines)
          ? body.lines
          : body.text
            ? [{ speaker: body.speaker || 's1', text: String(body.text) }]
            : [];
        if (!lines.length) {
          json(res, 400, { error: 'no lines to audition' });
          return;
        }

        const speakers = body.speakers ?? {
          [body.speaker || 's1']: {
            voiceId: body.voiceId,
            geminiVoice: body.geminiVoice,
            edgeVoice: body.edgeVoice,
            edgeRate: body.edgeRate,
            edgePitch: body.edgePitch,
            vitsPitch: body.vitsPitch,
            vitsRate: body.vitsRate,
          },
        };

        const provider = (body.provider === 'elevenlabs'
          ? 'elevenlabs'
          : body.provider === 'gemini'
            ? 'gemini'
            : body.provider === 'vits-bd'
              ? 'vits-bd'
              : 'edge') as 'elevenlabs' | 'gemini' | 'vits-bd' | 'edge';
        await synthesizeDialogue({
          id: 'audition',
          dest: auditionMp3,
          lines,
          speakers,
          provider,
          gap: Number(body.gap) || 0.65,
          speed: Number(body.speed) || 1.0,
        });

        json(res, 200, {
          ok: true,
          url: `/api/dialogue/audition?v=${Date.now()}`,
        });
      } catch (err: any) {
        json(res, 500, {
          error: `audition failed: ${err?.message || String(err)}`,
        });
      }
      return;
    }

    if (route === '/api/dialogue/audition') {
      const auditionMp3 = path.join(
        ROOT,
        'out',
        'tmp',
        'dialogue-audition',
        'audition.mp3',
      );
      if (!fs.existsSync(auditionMp3)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Content-Length': fs.statSync(auditionMp3).size,
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(auditionMp3).pipe(res);
      return;
    }

    if (route === '/api/reroll' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const id = String(body.sceneId ?? '');
      if (!/^\d{2}[a-z]?$/.test(id)) {
        json(res, 400, { error: 'bad sceneId' });
        return;
      }
      const reel = reelPaths(
        isSlug(body.slug ?? '') ? body.slug : currentSlug(),
      );
      if (!fs.existsSync(reel.project)) {
        json(res, 400, { error: 'no such reel' });
        return;
      }
      fs.rmSync(path.join(reel.images, `${id}.png`), { force: true });
      invalidateScene(reel, id);
      // "01b" is hook B's opening — the script sees it as scene 1 under HOOK=b.
      const hookEnv = { HOOK: id.slice(2) };
      // A footage scene rerolls its clip, not an image.
      if (sceneUsesStock(readProject(reel.slug), id)) {
        const started = runScript(
          'pick-stock',
          ['--reroll', id],
          hookEnv,
          `reroll ${id}`,
          reel,
          (code) => {
            if (code === 0)
              broadcast('picks', { slug: reel.slug, picks: readPicksOf(reel) });
          },
        );
        json(
          res,
          started ? 200 : 409,
          started ? { ok: true } : { error: 'busy' },
        );
        return;
      }
      const started = runScript(
        'render-images',
        ['--reroll', id],
        { ...settingsEnv(body.settings), ...hookEnv },
        `reroll ${id}`,
        reel,
        (code, out) => {
          const seed = out
            .replace(ANSI, '')
            .match(new RegExp(`${id} rolled seed (\\d+)`))?.[1];
          if (code === 0 && seed)
            broadcast('seed', { sceneId: id, seed: Number(seed) });
        },
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true } : { error: 'busy' },
      );
      return;
    }

    // Raw PUT of one image file — avoids hand-rolling multipart parsing.
    if (route === '/api/replace' && req.method === 'PUT') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const id = url.searchParams.get('sceneId') ?? '';
      if (!/^\d{2}[a-z]?$/.test(id)) {
        json(res, 400, { error: 'bad sceneId' });
        return;
      }
      const buf = await readBody(req);
      if (!buf.length) {
        json(res, 400, { error: 'empty upload' });
        return;
      }
      const reel = reelPaths(
        isSlug(url.searchParams.get('slug') ?? '')
          ? url.searchParams.get('slug')!
          : currentSlug(),
      );
      const project = readProject(reel.slug);
      const w =
        project?.aspect === '16:9'
          ? 1920
          : project?.aspect === '1:1'
            ? 1080
            : 1080;
      const h =
        project?.aspect === '16:9'
          ? 1080
          : project?.aspect === '1:1'
            ? 1080
            : 1920;
      const tmp = path.join(
        ensureDir(path.join(reel.dir, 'tmp')),
        `upload-${id}`,
      );
      fs.writeFileSync(tmp, buf);
      ensureDir(reel.images);
      execFileSync(
        'ffmpeg',
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-y',
          '-i',
          tmp,
          '-vf',
          `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=lanczos,crop=${w}:${h}`,
          '-frames:v',
          '1',
          path.join(reel.images, `${id}.png`),
        ],
        { env: childEnv() },
      );
      fs.rmSync(tmp, { force: true });
      invalidateScene(reel, id);
      json(res, 200, { ok: true });
      return;
    }

    if (route === '/api/save-keys' && req.method === 'POST') {
      const body = JSON.parse(
        (await readBody(req, 64 * 1024)).toString() || '{}',
      );
      const written = saveToEnvFile(body);
      json(res, 200, {
        ok: true,
        written,
        savedKeys: Object.fromEntries(
          SAVEABLE.map((k) => [k, Boolean(readEnvFile()[k])]),
        ),
        savedPublicKeys: Object.fromEntries(
          SAVEABLE.filter((k) => !SECRET_KEYS.includes(k)).map((k) => [
            k,
            readEnvFile()[k] || '',
          ]),
        ),
      });
      return;
    }

    if (route === '/api/cancel' && req.method === 'POST') {
      if (job) {
        const pid = job.pid;
        try {
          if (pid) execFileSync('pkill', ['-TERM', '-P', String(pid)], { stdio: 'ignore' });
        } catch {}
        try {
          job.kill('SIGTERM');
        } catch {}
        setTimeout(() => {
          try {
            if (pid) execFileSync('pkill', ['-KILL', '-P', String(pid)], { stdio: 'ignore' });
          } catch {}
          try {
            job?.kill('SIGKILL');
          } catch {}
        }, 400);
      }
      json(res, 200, { ok: true });
      return;
    }

    if (route.startsWith('/api/image/')) {
      const id = route.slice('/api/image/'.length).replace(/[^0-9a-z]/g, '');
      const q = url.searchParams.get('slug') ?? '';
      const file = path.join(
        reelPaths(isSlug(q) ? q : currentSlug()).images,
        `${id}.png`,
      );
      if (!fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // ── publishing ───────────────────────────────────────────────────────────
    const redirectFor = (p: string) =>
      `http://localhost:${PORT}/oauth/${p}/callback`;
    const publishStatus = (slug: string) => {
      loadEnv();
      const reel = reelPaths(slug || 'x');
      const project = readProject(slug);
      return {
        youtube: {
          configured: youtubeConfigured(),
          connected: youtubeConnected(),
          channel: youtubeChannel(),
          redirect: redirectFor('youtube'),
        },
        meta: {
          configured: metaConfigured(),
          connected: metaConnected(),
          ...metaPages(),
          redirect: redirectFor('meta'),
        },
        tiktok: {
          configured: tiktokConfigured(),
          connected: tiktokConnected(),
          account: tiktokAccount(),
          redirect: redirectFor('tiktok'),
        },
        schedules: readSchedules(),
        reels: listReels(),
        reel: slug
          ? {
              slug,
              hasVideo: fs.existsSync(reel.final),
              published: readPublish(reel.dir),
              text: project ? postText(project) : null,
              publishConfig: project?.publish ?? null,
            }
          : null,
      };
    };

    if (route === '/api/publish/status') {
      const q = url.searchParams.get('slug') ?? '';
      json(res, 200, publishStatus(isSlug(q) ? q : ''));
      return;
    }

    if (route === '/oauth/youtube/start') {
      if (!youtubeConfigured()) {
        res
          .writeHead(400)
          .end('YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET missing in .env');
        return;
      }
      res
        .writeHead(302, { Location: youtubeAuthUrl(redirectFor('youtube')) })
        .end();
      return;
    }
    if (route === '/oauth/youtube/callback') {
      const code = url.searchParams.get('code');
      const err = url.searchParams.get('error');
      try {
        if (!code) throw new Error(err ?? 'no code');
        await youtubeExchangeCode(code, redirectFor('youtube'));
        res.writeHead(302, { Location: '/#publish' }).end();
      } catch (e: any) {
        res
          .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(`YouTube connection failed: ${e.message}`);
      }
      return;
    }

    if (route === '/oauth/meta/start') {
      if (!metaConfigured()) {
        res.writeHead(400).end('META_APP_ID / META_APP_SECRET missing in .env');
        return;
      }
      oauthState = Math.random().toString(36).slice(2);
      res
        .writeHead(302, {
          Location: metaAuthUrl(redirectFor('meta'), oauthState),
        })
        .end();
      return;
    }
    if (route === '/oauth/meta/callback') {
      const code = url.searchParams.get('code');
      try {
        if (url.searchParams.get('state') !== oauthState)
          throw new Error(
            'state mismatch — start the connection again from the page',
          );
        if (!code)
          throw new Error(
            url.searchParams.get('error_description') ??
              url.searchParams.get('error') ??
              'no code',
          );
        await metaExchangeCode(code, redirectFor('meta'));
        res.writeHead(302, { Location: '/#publish' }).end();
      } catch (e: any) {
        const detail = e.cause ? `${e.message} (${e.cause.message || e.cause.code || e.cause})` : e.message;
        console.error('Meta connection error:', e);
        res
          .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(`Meta connection failed: ${detail}`);
      }
      return;
    }

    if (route === '/oauth/tiktok/start') {
      if (!tiktokConfigured()) {
        res.writeHead(400).end('TIKTOK_CLIENT_KEY / TIKTOK_CLIENT_SECRET missing in .env');
        return;
      }
      oauthState = Math.random().toString(36).slice(2);
      res
        .writeHead(302, {
          Location: tiktokAuthUrl(redirectFor('tiktok'), oauthState),
        })
        .end();
      return;
    }
    if (route === '/oauth/tiktok/callback') {
      const code = url.searchParams.get('code');
      try {
        if (url.searchParams.get('state') !== oauthState)
          throw new Error(
            'state mismatch — start the connection again from the page',
          );
        if (!code)
          throw new Error(
            url.searchParams.get('error_description') ??
              url.searchParams.get('error') ??
              'no code',
          );
        await tiktokExchangeCode(code, redirectFor('tiktok'));
        res.writeHead(302, { Location: '/#publish' }).end();
      } catch (e: any) {
        const detail = e.cause ? `${e.message} (${e.cause.message || e.cause.code || e.cause})` : e.message;
        console.error('TikTok connection error:', e);
        res
          .writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' })
          .end(`TikTok connection failed: ${detail}`);
      }
      return;
    }

    if (route === '/api/publish/disconnect' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (body.platform === 'youtube' || body.platform === 'meta' || body.platform === 'tiktok')
        clearStore(body.platform);
      json(res, 200, publishStatus(''));
      return;
    }

    if (route === '/api/publish/page' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      metaSelectPage(String(body.pageId ?? ''));
      json(res, 200, publishStatus(''));
      return;
    }

    // Publish the reel's final.mp4 to the chosen platforms — a job like any other.
    if (route === '/api/publish' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const slug = isSlug(body.slug ?? '') ? body.slug : currentSlug();
      const reel = reelPaths(slug);
      if (!fs.existsSync(reel.final)) {
        json(res, 400, { error: 'render the reel first — no final.mp4' });
        return;
      }
      const to = (Array.isArray(body.platforms) ? body.platforms : []).filter(
        (p: string) => ['youtube', 'facebook', 'instagram', 'tiktok'].includes(p),
      );
      if (!to.length) {
        json(res, 400, { error: 'pick at least one platform' });
        return;
      }
      // Remember the post text on the project so a repost or the CLI uses the same words.
      const project = readProject(slug);
      if (project) {
        project.publish = {
          ...(project.publish ?? {}),
          ...(body.title ? { title: body.title } : {}),
          ...(body.description ? { description: body.description } : {}),
          ...(Array.isArray(body.hashtags) && body.hashtags.length
            ? { hashtags: body.hashtags }
            : {}),
          ...(body.privacy ? { privacy: body.privacy } : {}),
          ...(Number.isFinite(Number(body.coverAt)) &&
          body.coverAt !== '' &&
          body.coverAt != null
            ? { coverAt: Number(body.coverAt) }
            : {}),
          ...(body.platformData && typeof body.platformData === 'object'
            ? body.platformData
            : {}),
        };
        fs.writeFileSync(reel.project, JSON.stringify(project, null, 2));
      }
      const scheduleIso = body.schedule ?? body.publishAt;
      const args = [
        '--to',
        to.join(','),
        ...(body.privacy ? ['--privacy', body.privacy] : []),
        ...(scheduleIso ? ['--schedule', scheduleIso] : []),
        ...(body.again ? ['--again'] : []),
      ];
      const started = runScript(
        'publish',
        args,
        {},
        to.length === 1 ? `publish ${to[0]} ${slug}` : `publish ${slug}`,
        reel,
        (code) => {
          broadcast('published', {
            slug,
            ok: code === 0,
            published: readPublish(reel.dir),
          });
        },
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true } : { error: 'busy' },
      );
      return;
    }

    if (route === '/api/publish/save' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const slug = isSlug(body.slug ?? '') ? body.slug : currentSlug();
      const reel = reelPaths(slug);
      const project = readProject(slug);
      if (project) {
        project.publish = {
          ...(project.publish ?? {}),
          ...(body.title ? { title: body.title } : {}),
          ...(body.description ? { description: body.description } : {}),
          ...(Array.isArray(body.hashtags) ? { hashtags: body.hashtags } : {}),
          ...(body.privacy ? { privacy: body.privacy } : {}),
          ...(body.platformData && typeof body.platformData === 'object'
            ? body.platformData
            : {}),
        };
        fs.writeFileSync(reel.project, JSON.stringify(project, null, 2));
      }
      json(res, 200, { ok: true });
      return;
    }

    if (route === '/api/publish/schedules' && req.method === 'GET') {
      json(res, 200, readSchedules());
      return;
    }

    if (route === '/api/publish/schedule' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const slug = isSlug(body.slug ?? '') ? body.slug : currentSlug();
      const reel = reelPaths(slug);
      if (!fs.existsSync(reel.final)) {
        json(res, 400, { error: 'render the reel first — no final.mp4' });
        return;
      }
      const to = (Array.isArray(body.platforms) ? body.platforms : []).filter(
        (p: string) => ['youtube', 'facebook', 'instagram', 'tiktok'].includes(p),
      );
      if (!to.length) {
        json(res, 400, { error: 'pick at least one platform' });
        return;
      }
      const scheduledAt = String(body.scheduledAt || '');
      const scheduledTime = new Date(scheduledAt).getTime();
      if (isNaN(scheduledTime) || scheduledTime <= Date.now() + 10_000) {
        json(res, 400, { error: 'scheduled time must be at least 1 minute in the future' });
        return;
      }

      const project = readProject(slug);
      if (project) {
        project.publish = {
          ...(project.publish ?? {}),
          ...(body.title ? { title: body.title } : {}),
          ...(body.description ? { description: body.description } : {}),
          ...(Array.isArray(body.hashtags) && body.hashtags.length
            ? { hashtags: body.hashtags }
            : {}),
          ...(body.privacy ? { privacy: body.privacy } : {}),
          ...(Number.isFinite(Number(body.coverAt)) &&
          body.coverAt !== '' &&
          body.coverAt != null
            ? { coverAt: Number(body.coverAt) }
            : {}),
          ...(body.platformData && typeof body.platformData === 'object'
            ? body.platformData
            : {}),
          publishAt: scheduledAt,
        };
        fs.writeFileSync(reel.project, JSON.stringify(project, null, 2));
      }

      const schedules = readSchedules();
      const newJob: ScheduledJob = {
        id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        slug,
        platforms: to,
        scheduledAt,
        scheduledTime,
        createdAt: Date.now(),
        status: 'pending',
        nativeUpload: Boolean(body.nativeUpload),
        title: body.title,
        description: body.description,
        hashtags: body.hashtags,
        privacy: body.privacy,
        coverAt: Number(body.coverAt) || 1,
        platformData: body.platformData,
      };

      schedules.push(newJob);
      writeSchedules(schedules);
      broadcast('schedules', schedules);
      json(res, 200, { ok: true, job: newJob, schedules });
      return;
    }

    if (route === '/api/publish/schedule/cancel' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const schedules = readSchedules();
      const filtered = schedules.filter((s) => s.id !== body.id);
      writeSchedules(filtered);
      broadcast('schedules', filtered);
      json(res, 200, { ok: true, schedules: filtered });
      return;
    }

    if (route === '/api/publish/schedule/run-now' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const schedules = readSchedules();
      const item = schedules.find((s) => s.id === body.id);
      if (!item) {
        json(res, 404, { error: 'schedule not found' });
        return;
      }
      item.scheduledTime = Date.now() - 1000;
      item.status = 'pending';
      writeSchedules(schedules);
      setTimeout(checkSchedules, 50);
      json(res, 200, { ok: true });
      return;
    }

    // ── analytics ────────────────────────────────────────────────────────────
    if (route === '/api/analytics' && req.method === 'GET') {
      const file = path.join(ROOT, 'out', 'analytics.json');
      json(
        res,
        200,
        fs.existsSync(file)
          ? JSON.parse(fs.readFileSync(file, 'utf8'))
          : { fetchedAt: 0, reels: [] },
      );
      return;
    }
    if (route === '/api/analytics' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const reel = reelPaths(currentSlug() || 'x');
      const started = runScript(
        'analytics',
        ['--all'],
        {},
        'analytics',
        reel,
        (code) => {
          broadcast('analytics', { ok: code === 0 });
        },
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true } : { error: 'busy' },
      );
      return;
    }

    // ── content folder browser ──────────────────────────────────────────────
    // Project files under content/ (recursively), so the batch picker can load
    // them without a file dialog. Card sets (a "cards" array) are left out.
    if (route === '/api/content' && req.method === 'GET') {
      const want = url.searchParams.get('files');
      const root = path.join(ROOT, 'content');
      const walk = (dir: string): string[] =>
        fs.existsSync(dir)
          ? fs
              .readdirSync(dir, { withFileTypes: true })
              .flatMap((e) =>
                e.isDirectory()
                  ? walk(path.join(dir, e.name))
                  : /\.json$/i.test(e.name)
                    ? [path.join(dir, e.name)]
                    : [],
              )
          : [];
      const describe = (file: string) => {
        try {
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          const list = Array.isArray(data)
            ? data
            : Array.isArray(data?.projects)
              ? data.projects
              : data?.scenes
                ? [data]
                : [];
          if (!list.length || list.some((p: any) => !Array.isArray(p?.scenes)))
            return null;
          return {
            file: path.relative(ROOT, file),
            projects: list.length,
            title: list.length === 1 ? (list[0].title ?? '') : '',
            scenes: list.reduce((n: number, p: any) => n + p.scenes.length, 0),
          };
        } catch {
          return null;
        }
      };
      if (want) {
        // Load the chosen files' projects, in the order given, tagged with their file.
        const out: any[] = [];
        for (const rel of want.split(',')) {
          const file = path.resolve(root, rel.replace(/^content\//, ''));
          if (!file.startsWith(root) || !fs.existsSync(file)) continue;
          const data = JSON.parse(fs.readFileSync(file, 'utf8'));
          const list = Array.isArray(data)
            ? data
            : Array.isArray(data?.projects)
              ? data.projects
              : [data];
          list.forEach((p: any, i: number) => {
            if (Array.isArray(p?.scenes))
              out.push({
                ...p,
                __from: path.relative(ROOT, file),
                __index: i,
                __count: list.length,
              });
          });
        }
        json(res, 200, { projects: out });
        return;
      }
      json(res, 200, {
        files: walk(root)
          .map(describe)
          .filter(Boolean)
          .sort((a, b) => a!.file.localeCompare(b!.file)),
      });
      return;
    }

    // ── batch queue ──────────────────────────────────────────────────────────
    if (route === '/api/queue' && req.method === 'GET') {
      json(res, 200, queueState());
      return;
    }

    // Enqueue whole project objects (e.g. the 60-day bundle). Each becomes a reel
    // folder; rendering starts as soon as the lock is free.
    if (route === '/api/queue' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const projects: any[] = Array.isArray(body.projects) ? body.projects : [];
      const defaultPlatforms: string[] =
        Array.isArray(body.platforms) && body.platforms.length > 0
          ? body.platforms.filter((p: string) =>
              ['instagram', 'facebook', 'tiktok', 'youtube'].includes(p),
            )
          : ['instagram', 'facebook', 'tiktok', 'youtube'];
      const added: string[] = [];
      for (const p of projects) {
        if (!p || !Array.isArray(p.scenes) || !p.scenes.length) continue;
        const slug = folderFor(p);
        if (!isSlug(slug)) continue;
        const reel = reelPaths(slug);
        const { __from, __index, __count, folder, ...clean } = p;
        clean.scenes = clean.scenes.map((sc: any, i: number) => ({
          ...sc,
          id: String(i + 1).padStart(2, '0'),
        }));
        const plats =
          Array.isArray(body.platforms) && body.platforms.length > 0
            ? defaultPlatforms
            : Array.isArray(clean.platforms) && clean.platforms.length
              ? clean.platforms.filter((pl: string) =>
                  ['instagram', 'facebook', 'tiktok', 'youtube'].includes(pl),
                )
              : defaultPlatforms;
        clean.platforms = [...new Set(plats)];
        const targetPlats: string[] = clean.platforms ?? [];
        const hasAllPlatCuts =
          targetPlats.length > 0 &&
          targetPlats.every((pl: string) => {
            const code = ({
              instagram: 'ig',
              facebook: 'fb',
              tiktok: 'tt',
              youtube: 'yt',
            } as Record<string, string>)[pl];
            return (
              code && fs.existsSync(path.join(reel.dir, `final-${code}.mp4`))
            );
          });
        if (
          body.skipRendered &&
          fs.existsSync(reel.final) &&
          (targetPlats.length === 0 || hasAllPlatCuts)
        )
          continue;
        if (
          queue.some(
            (q) =>
              q.slug === slug &&
              (q.status === 'queued' || q.status === 'running'),
          )
        )
          continue;
        ensureDir(reel.dir);
        fs.writeFileSync(reel.project, JSON.stringify(clean, null, 2));
        queue.push({
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          slug,
          title: clean.title ?? slug,
          status: 'queued',
          settings: body.settings ?? {},
          fresh: Boolean(body.fresh),
        });
        added.push(slug);
      }
      queueChanged();
      pumpQueue();
      json(res, 200, { ok: true, added, ...queueState() });
      return;
    }

    if (route === '/api/queue' && req.method === 'DELETE') {
      const id = url.searchParams.get('id') ?? '';
      const what = url.searchParams.get('what') ?? '';
      if (what === 'finished')
        queue = queue.filter(
          (q) => q.status === 'queued' || q.status === 'running',
        );
      else if (what === 'all') {
        queue = queue.filter((q) => q.status === 'running');
      } else queue = queue.filter((q) => q.id !== id || q.status === 'running');
      queueChanged();
      json(res, 200, queueState());
      return;
    }

    if (route === '/api/queue/pause' && req.method === 'POST') {
      queuePaused = !queuePaused;
      queueChanged();
      if (!queuePaused) pumpQueue();
      json(res, 200, queueState());
      return;
    }

    // Skip the reel that is rendering now and carry on with the next.
    if (route === '/api/queue/skip' && req.method === 'POST') {
      const cur = queue.find((q) => q.status === 'running');
      if (cur) {
        cur.status = 'skipped';
        cur.finishedAt = Date.now();
        queueChanged();
      }
      job?.kill('SIGTERM');
      json(res, 200, { ok: true });
      return;
    }

    // ── photo cards ──────────────────────────────────────────────────────────
    if (route === '/api/cards' && req.method === 'GET') {
      const slug = url.searchParams.get('slug') ?? '';
      if (!slug) {
        json(res, 200, { sets: listCardSets() });
        return;
      }
      if (!isSlug(slug)) {
        json(res, 400, { error: 'bad slug' });
        return;
      }
      const set = cardPaths(slug);
      if (!fs.existsSync(set.project)) {
        json(res, 404, { error: 'no such card set' });
        return;
      }
      json(res, 200, {
        slug,
        project: JSON.parse(fs.readFileSync(set.project, 'utf8')),
        rendered: renderedCards(set),
      });
      return;
    }

    // Write the set and render it. `reroll: "02"` re-generates just that background.
    if (route === '/api/cards' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const set = cardPaths(slugify(body.title));
      const project = writeCardSet(body, set);
      if (!project.cards.length) {
        json(res, 400, { error: 'no cards with text' });
        return;
      }
      const reroll = /^\d{2}$/.test(body.reroll ?? '')
        ? ['--reroll', body.reroll]
        : [];
      const started = runScript(
        'render-cards',
        reroll,
        settingsEnv(body.settings),
        `cards ${set.slug}`,
        set,
        (code) => {
          if (code === 0)
            broadcast('cards', {
              slug: set.slug,
              rendered: renderedCards(set),
            });
        },
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true, slug: set.slug } : { error: 'busy' },
      );
      return;
    }

    if (route === '/api/cards' && req.method === 'DELETE') {
      const slug = url.searchParams.get('slug') ?? '';
      if (!isSlug(slug)) {
        json(res, 400, { error: 'bad slug' });
        return;
      }
      fs.rmSync(cardPaths(slug).dir, { recursive: true, force: true });
      json(res, 200, { ok: true, sets: listCardSets() });
      return;
    }

    if (route === '/api/bg-themes') {
      json(res, 200, { themes: bgThemes() });
      return;
    }

    /** The verse sets that ship in content/verses — the starting points to import. */
    if (route === '/api/verse-templates') {
      const dir = path.join(ROOT, 'content', 'verses');
      const name = url.searchParams.get('name') ?? '';
      if (name) {
        if (!/^[A-Za-z0-9._-]+$/.test(name)) {
          json(res, 400, { error: 'bad name' });
          return;
        }
        const file = path.join(dir, `${name}.json`);
        // path.join with a validated name cannot escape dir, but check anyway.
        if (!file.startsWith(dir + path.sep) || !fs.existsSync(file)) {
          json(res, 404, { error: 'no such template' });
          return;
        }
        json(res, 200, {
          name,
          project: JSON.parse(fs.readFileSync(file, 'utf8')),
        });
        return;
      }
      const list = !fs.existsSync(dir)
        ? []
        : fs
            .readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => {
              let p: any = {};
              try {
                p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
              } catch {}
              return {
                name: f.replace(/\.json$/, ''),
                title: p.title ?? f,
                verses: (p.verses ?? []).length,
                surah: p.surah ?? null,
              };
            });
      json(res, 200, { templates: list });
      return;
    }

    if (route === '/api/reciters') {
      json(res, 200, { reciters: RECITERS, default: DEFAULT_RECITER });
      return;
    }

    /** Which ayat of this set are already in the shared clip cache. */
    if (route === '/api/recitation' && req.method === 'GET') {
      const slug = url.searchParams.get('slug') ?? '';
      if (!isSlug(slug)) {
        json(res, 400, { error: 'bad slug' });
        return;
      }
      const file = versePaths(slug).project;
      if (!fs.existsSync(file)) {
        json(res, 404, { error: 'no such verse set' });
        return;
      }
      const p = JSON.parse(fs.readFileSync(file, 'utf8'));
      const reciter = p.recitation?.reciter ?? DEFAULT_RECITER;
      const have = (p.verses ?? []).filter(
        (v: any) =>
          v.ayah &&
          p.surah &&
          fs.existsSync(clipPath(reciter, p.surah, v.ayah)),
      ).length;
      json(res, 200, { reciter, have, total: (p.verses ?? []).length });
      return;
    }

    // Saves the set, then downloads whatever ayat it still needs.
    if (route === '/api/recitation' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const set = versePaths(slugify(body.title));
      const project = writeVerseSet(body, set);
      if (!project.surah) {
        json(res, 400, { error: 'set a surah number first' });
        return;
      }
      const started = runScript(
        'fetch-recitation',
        [],
        settingsEnv(body.settings),
        `recitation ${set.slug}`,
        set,
        () => {},
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true, slug: set.slug } : { error: 'busy' },
      );
      return;
    }

    if (route === '/api/verses' && req.method === 'GET') {
      const slug = url.searchParams.get('slug') ?? '';
      if (!slug) {
        json(res, 200, { sets: listVerseSets(), themes: bgThemes() });
        return;
      }
      if (!isSlug(slug)) {
        json(res, 400, { error: 'bad slug' });
        return;
      }
      const set = versePaths(slug);
      if (!fs.existsSync(set.project)) {
        json(res, 404, { error: 'no such verse set' });
        return;
      }
      json(res, 200, {
        slug,
        project: JSON.parse(fs.readFileSync(set.project, 'utf8')),
        rendered: fs.existsSync(set.final),
      });
      return;
    }

    if (route === '/api/verses' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const set = versePaths(slugify(body.title));
      const project = writeVerseSet(body, set);
      if (!project.verses.length) {
        json(res, 400, { error: 'no verses with text' });
        return;
      }
      // The first render of a theme/size also renders its background loop, which
      // takes a couple of minutes; every later one reuses the cached clip.
      const args = body.rebuildBg ? ['--rebuild-bg'] : [];
      const started = runScript(
        'render-verses',
        args,
        settingsEnv(body.settings),
        `verses ${set.slug}`,
        set,
        (code) => {
          if (code === 0)
            broadcast('verses', {
              slug: set.slug,
              rendered: fs.existsSync(set.final),
            });
        },
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true, slug: set.slug } : { error: 'busy' },
      );
      return;
    }

    if (route === '/api/verses' && req.method === 'DELETE') {
      const slug = url.searchParams.get('slug') ?? '';
      if (!isSlug(slug)) {
        json(res, 400, { error: 'bad slug' });
        return;
      }
      fs.rmSync(versePaths(slug).dir, { recursive: true, force: true });
      json(res, 200, { ok: true, sets: listVerseSets() });
      return;
    }

    if (route === '/api/verse-video') {
      const slug = url.searchParams.get('slug') ?? '';
      if (!isSlug(slug)) {
        res.writeHead(404).end();
        return;
      }
      sendVideo(req, res, versePaths(slug).final);
      return;
    }

    if (route === '/api/card') {
      const slug = url.searchParams.get('slug') ?? '',
        id = url.searchParams.get('id') ?? '';
      if (!isSlug(slug) || !/^\d{2}$/.test(id)) {
        res.writeHead(404).end();
        return;
      }
      const file = path.join(cardPaths(slug).dir, `${id}.png`);
      if (!fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'no-store',
        'Content-Disposition': disposition(`${slug}-${id}.png`),
      });
      fs.createReadStream(file).pipe(res);
      return;
    }

    if (route === '/api/variants') {
      const q = url.searchParams.get('slug') ?? '';
      json(res, 200, {
        variants: variantsOf(reelPaths(isSlug(q) ? q : currentSlug() || 'x')),
      });
      return;
    }

    if (route === '/api/video') {
      const q = url.searchParams.get('slug') ?? '';
      const reel = reelPaths(isSlug(q) ? q : currentSlug());
      sendVideo(req, res, finalOf(reel, url.searchParams.get('variant') ?? ''));
      return;
    }

    // ── AI Video Generation Studio Endpoints ─────────────────────────────────
    if (route === '/api/video/gallery' && req.method === 'GET') {
      const videos = readVideoMeta();
      json(res, 200, { ok: true, videos });
      return;
    }

    if (route === '/api/video/stream') {
      const file = path.basename(url.searchParams.get('file') ?? '');
      if (!file) {
        res.writeHead(400).end('missing file parameter');
        return;
      }
      const full = path.join(AI_VIDEOS_DIR, file);
      sendVideo(req, res, full);
      return;
    }

    if (route === '/api/video/thumb') {
      const file = path.basename(url.searchParams.get('file') ?? '');
      const thumb = path.join(AI_THUMBS_DIR, `${file}.jpg`);
      if (!fs.existsSync(thumb)) {
        const videoFile = path.join(AI_VIDEOS_DIR, file);
        if (fs.existsSync(videoFile)) generateThumb(videoFile, thumb);
      }
      if (!fs.existsSync(thumb)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=3600',
      });
      fs.createReadStream(thumb).pipe(res);
      return;
    }

    if (route === '/api/video/to-stock' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const file = path.basename(body.file ?? '');
      if (!file) {
        json(res, 400, { error: 'no file provided' });
        return;
      }
      try {
        const result = saveAiVideoToStock(file, body.name);
        json(res, 200, result);
      } catch (err: any) {
        json(res, 500, { error: err?.message || String(err) });
      }
      return;
    }

    if (route === '/api/video/to-scene' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const file = path.basename(body.file ?? '');
      const slug = isSlug(body.slug ?? '') ? body.slug : currentSlug();
      const sceneIdx = Number(body.sceneIndex ?? 0);
      const isDialogue = body.mode === 'dialogue' || body.isDialogue;
      const reel = reelPaths(slug, isDialogue ? 'dialogue' : 'reels');
      const project = readProject(reel.slug);
      if (!project) {
        json(res, 404, { error: `Project ${slug} not found` });
        return;
      }

      // Also copy to stock so it's a persistent asset across the studio
      const stockResult = saveAiVideoToStock(file);
      const scenes = (project.scenes as any[]) || [];
      if (sceneIdx >= 0 && sceneIdx < scenes.length) {
        scenes[sceneIdx].stock = stockResult.stockName;
        scenes[sceneIdx].motion = 'pan-left';
      }
      writeProject(project, reel);
      broadcast('project', { slug: reel.slug, project });
      json(res, 200, { ok: true, stockName: stockResult.stockName });
      return;
    }

    if (route === '/api/video' && req.method === 'DELETE') {
      const file = path.basename(url.searchParams.get('file') ?? '');
      if (!file) {
        json(res, 400, { error: 'file param required' });
        return;
      }
      deleteAiVideo(file);
      json(res, 200, { ok: true });
      return;
    }

    if (route === '/api/video/generate' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      if (!ltx2Installed()) {
        json(res, 400, { error: 'LTX-2 model not installed on Mac Drive' });
        return;
      }

      const body = JSON.parse((await readBody(req)).toString() || '{}');
      if (!body.prompt || !body.prompt.trim()) {
        json(res, 400, { error: 'prompt is required' });
        return;
      }

      const cleanPrompt = body.prompt.trim();
      const slug = slugify(cleanPrompt.slice(0, 30)) || 'video';
      const filename = `${Date.now()}-${slug}.mp4`;
      const destFile = path.join(AI_VIDEOS_DIR, filename);

      const { args, frames, width, height, tempImage } = buildLtx2Args(
        body,
        destFile,
      );

      jobLabel = `AI Video: ${slug.slice(0, 20)}`;
      broadcast('start', { label: jobLabel });
      broadcast('video-progress', {
        stage: 1,
        step: 0,
        total: 8,
        percent: 5,
        status: 'Starting LTX-2 MLX inference...',
      });

      const envVars = {
        ...childEnv(),
        HF_HOME: LTX2_CACHE,
        HUGGINGFACE_HUB_CACHE: path.join(LTX2_CACHE, 'hub'),
        HF_HUB_OFFLINE: '1',
      };

      const child = spawn(LTX2_BIN, args, { cwd: ROOT, env: envVars });
      job = child;

      const pump = (buf: Buffer) => {
        const text = buf.toString();
        for (const rawLine of text.split('\n')) {
          const line = rawLine.replace(ANSI, '').trimEnd();
          if (!line.trim()) continue;
          broadcast('log', { line });

          const stage2Match = line.match(/Stage\s*2.*?(\d+)\s*\/\s*(\d+)/i);
          const stage1Match =
            line.match(/Stage\s*1.*?(\d+)\s*\/\s*(\d+)/i) ||
            (!line.includes('Stage 2') && line.match(/(\d+)\s*\/\s*(\d+)/));

          if (stage2Match) {
            const cur = Number(stage2Match[1]);
            const tot = Number(stage2Match[2]) || 3;
            const pct = Math.round(60 + (cur / tot) * 30);
            broadcast('video-progress', {
              stage: 2,
              step: cur,
              total: tot,
              percent: pct,
              status: `Stage 2 Refine: ${cur}/${tot}`,
              line,
            });
          } else if (stage1Match) {
            const cur = Number(stage1Match[1]);
            const tot = Number(stage1Match[2]) || 8;
            const pct = Math.round(10 + (cur / tot) * 50);
            broadcast('video-progress', {
              stage: 1,
              step: cur,
              total: tot,
              percent: pct,
              status: `Stage 1 Denoise: ${cur}/${tot}`,
              line,
            });
          } else if (
            line.toLowerCase().includes('decode') ||
            line.toLowerCase().includes('audio') ||
            line.toLowerCase().includes('vae')
          ) {
            broadcast('video-progress', {
              stage: 3,
              step: 1,
              total: 1,
              percent: 94,
              status: 'Decoding Video & Generating Audio...',
              line,
            });
          }
        }
      };

      child.stdout?.on('data', pump);
      child.stderr?.on('data', pump);

      child.on('close', (code) => {
        job = null;
        if (
          tempImage &&
          fs.existsSync(tempImage) &&
          tempImage.includes('temp-input-')
        ) {
          try {
            fs.rmSync(tempImage, { force: true });
          } catch {}
        }

        if (code === 0 && fs.existsSync(destFile)) {
          const thumbFile = path.join(AI_THUMBS_DIR, `${filename}.jpg`);
          generateThumb(destFile, thumbFile);

          let duration = frames / 24;
          try {
            duration = Math.round(probeDuration(destFile) * 10) / 10;
          } catch {}

          const st = fs.statSync(destFile);
          const meta = readVideoMeta();
          const record = {
            id: filename,
            filename,
            prompt: cleanPrompt,
            negative: body.negative_prompt,
            duration,
            frames,
            width,
            height,
            audio: body.audio !== false,
            aspect: body.aspect || '9:16',
            createdAt: Date.now(),
            size: st.size,
            hasThumb: fs.existsSync(thumbFile),
          };
          meta.unshift(record);
          fs.writeFileSync(
            path.join(AI_VIDEOS_DIR, 'metadata.json'),
            JSON.stringify(meta, null, 2),
          );

          broadcast('video-progress', {
            stage: 3,
            percent: 100,
            status: 'Generation Completed!',
          });
          broadcast('video-done', { ok: true, video: record });
          broadcast('done', { label: jobLabel, code: 0, ok: true });
        } else {
          broadcast('video-progress', {
            stage: 0,
            percent: 0,
            status: `Failed (exit code ${code})`,
          });
          broadcast('video-done', {
            ok: false,
            error: `Process exited with code ${code}`,
          });
          broadcast('done', { label: jobLabel, code: code ?? 1, ok: false });
        }
      });

      json(res, 200, { ok: true, filename, started: true });
      return;
    }


    // Fast Remaster: re-runs only render-music + master-final in 2-3s
    if (route === '/api/remaster' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const slug = isSlug(body.slug ?? '') ? body.slug : currentSlug();
      if (!slug) {
        json(res, 400, { error: 'no reel specified' });
        return;
      }
      const isDialogue =
        body.folder === 'dialogue' ||
        body.isDialogue ||
        body.voice?.mode === 'dialogue';
      const reel = reelPaths(slug, isDialogue ? 'dialogue' : 'reels');
      const project = readProject(reel.slug);
      if (!project) {
        json(res, 404, { error: 'reel not found' });
        return;
      }

      // Update music settings
      if (body.music) {
        project.music = {
          ...(project.music ?? {}),
          ...(body.music.file !== undefined ? { file: body.music.file } : {}),
          ...(body.music.gainDb !== undefined ? { gainDb: Number(body.music.gainDb) } : {}),
        };
      }
      if (body.captions && body.captions.show !== undefined) {
        project.captions = {
          ...(project.captions ?? {}),
          show: Boolean(body.captions.show),
        };
      }
      if (body.brand) {
        project.brand = { ...(project.brand ?? {}), ...body.brand };
      }

      fs.writeFileSync(reel.project, JSON.stringify(project, null, 2));
      ensureDir(REELS);
      fs.writeFileSync(LAST, reel.slug);

      // Remove cached music bed and old master so render-music rebuilds cleanly
      fs.rmSync(path.join(reel.dir, 'music-bed.wav'), { force: true });
      fs.rmSync(reel.final, { force: true });

      const started = runScript(
        'remaster',
        [],
        settingsEnv(body.settings),
        `remaster ${reel.slug}`,
        reel,
        () => {},
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true, slug: reel.slug } : { error: 'busy' },
      );
      return;
    }

    // Stream a background music track from music/ for instant in-browser audition
    if (route === '/api/music-stream') {
      const track = path.basename(url.searchParams.get('track') ?? '').replace(/[^\w.\- ]+/g, '');
      if (!track) {
        res.writeHead(400).end();
        return;
      }
      const file = path.join(MUSIC_DIR, track);
      sendVideo(req, res, file);
      return;
    }

    // Stream reel audio components (voice narration track or music bed)
    if (route === '/api/reel-audio') {
      const q = url.searchParams.get('slug') ?? '';
      const reel = reelPaths(isSlug(q) ? q : currentSlug());
      const type = url.searchParams.get('type') ?? 'voice';
      const file =
        type === 'voice'
          ? (fs.existsSync(path.join(reel.dir, 'tmp', 'voice.wav'))
              ? path.join(reel.dir, 'tmp', 'voice.wav')
              : path.join(reel.dir, 'tmp', 'audio.wav'))
          : path.join(reel.dir, 'music-bed.wav');
      sendVideo(req, res, file);
      return;
    }

    // ── reels ────────────────────────────────────────────────────────────────
    // Voices the account may actually use. Library voices are excluded because
    // free plans get a 402 on them, which reads like a billing fault.
    if (route === '/api/eleven-voices') {
      const key = env('ELEVENLABS_API_KEY');
      if (!key) {
        json(res, 200, { voices: [], reason: 'no ELEVENLABS_API_KEY' });
        return;
      }
      try {
        const r = await fetch('https://api.elevenlabs.io/v1/voices', {
          headers: { 'xi-api-key': key },
        });
        if (!r.ok) {
          json(res, 200, { voices: [], reason: `elevenlabs ${r.status}` });
          return;
        }
        const d = (await r.json()) as { voices: any[] };
        json(res, 200, {
          voices: d.voices
            .filter(
              (v) =>
                v.category === 'premade' ||
                v.category === 'cloned' ||
                v.category === 'generated',
            )
            .map((v) => ({
              id: v.voice_id,
              name: String(v.name ?? '').split(' - ')[0],
              gender: v.labels?.gender ?? '',
              age: v.labels?.age ?? '',
              accent: v.labels?.accent ?? '',
              style: v.labels?.descriptive ?? v.labels?.description ?? '',
            })),
        });
      } catch (e: any) {
        json(res, 200, { voices: [], reason: e?.message ?? 'lookup failed' });
      }
      return;
    }

    // One line in every bn_BD speaker, beep-separated, so a voice can be chosen by ear.
    if (route === '/api/piper-audition') {
      const out = path.join(
        ROOT,
        'out',
        'tts-compare',
        'piper-bnBD-all-16-speakers.mp3',
      );
      if (req.method === 'POST') {
        if (!piperInstalled()) {
          json(res, 400, {
            error: 'piper not installed — npm run piper:setup',
          });
          return;
        }
        const line =
          'আসসালামু আলাইকুম। সমুদ্রের পঁচানব্বই শতাংশ কখনো মানুষের চোখে দেখা হয়নি।';
        const tmp = ensureDir(path.join(ROOT, 'out', 'tmp', 'audition'));
        const dataDir = execFileSync(
          path.join(PIPER_VENV, 'bin', 'python'),
          [
            '-c',
            "import piper,os;print(os.path.join(os.path.dirname(piper.__file__),'espeak-ng-data'))",
          ],
          { encoding: 'utf8' },
        ).trim();
        const wavs: string[] = [];
        for (let spk = 0; spk < 16; spk++) {
          const wav = path.join(tmp, `spk${spk}.wav`);
          execFileSync(
            path.join(PIPER_VENV, 'bin', 'piper'),
            [
              '--model',
              path.join(PIPER_STORE, 'bn_BD-google-medium.onnx'),
              '--speaker',
              String(spk),
              '--output_file',
              wav,
            ],
            {
              input: line,
              stdio: ['pipe', 'ignore', 'ignore'],
              env: { ...process.env, ESPEAK_DATA_PATH: dataDir },
            },
          );
          wavs.push(wav);
        }
        // beep, "speaker N" is implied by order; concat into one mp3
        const inputs = wavs.flatMap((w) => ['-i', w]);
        const chain = wavs.map((_, i) => `[b][${i}:a]`).join('');
        ensureDir(path.dirname(out));
        execFileSync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=880:duration=0.2:sample_rate=22050',
            ...inputs,
            '-filter_complex',
            `[0:a]aformat=channel_layouts=mono[b0];` +
              wavs
                .map(
                  (_, i) =>
                    `[${i + 1}:a]aresample=22050,aformat=channel_layouts=mono,loudnorm=I=-18[s${i}]`,
                )
                .join(';') +
              ';' +
              wavs.map((_, i) => `[b0]acopy[b${i}]`).join(';') +
              ';' +
              wavs.map((_, i) => `[b${i}][s${i}]`).join('') +
              `concat=n=${wavs.length * 2}:v=0:a=1[out]`,
            '-map',
            '[out]',
            '-c:a',
            'libmp3lame',
            '-q:a',
            '2',
            out,
          ],
          { env: childEnv() },
        );
        json(res, 200, { ok: true, file: path.relative(ROOT, out) });
        return;
      }
      if (!fs.existsSync(out)) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(out).pipe(res);
      return;
    }

    if (route === '/api/reels') {
      json(res, 200, { reels: listReels(), current: currentSlug() });
      return;
    }

    if (route === '/api/reel' && req.method !== 'DELETE') {
      const slug = url.searchParams.get('slug') ?? '';
      if (!isSlug(slug)) {
        json(res, 400, { error: 'bad slug' });
        return;
      }
      const project = readProject(slug);
      if (!project) {
        json(res, 404, { error: 'no such reel' });
        return;
      }
      ensureDir(REELS);
      fs.writeFileSync(LAST, slug);
      json(res, 200, {
        slug,
        project,
        hasVideo: fs.existsSync(reelPaths(slug).final),
        variants: variantsOf(reelPaths(slug)),
      });
      return;
    }

    if (route === '/api/reel' && req.method === 'DELETE') {
      const slug = url.searchParams.get('slug') ?? '';
      if (!isSlug(slug)) {
        json(res, 400, { error: 'bad slug' });
        return;
      }
      fs.rmSync(reelPaths(slug).dir, { recursive: true, force: true });
      json(res, 200, { ok: true, reels: listReels() });
      return;
    }

    // ── brand / watermark library (assets/brand) ─────────────────────────────
    if (route === '/api/brand' && req.method !== 'PUT') {
      const images = fs.existsSync(BRAND_DIR)
        ? fs
            .readdirSync(BRAND_DIR)
            .filter((f) => BRAND_EXT.test(f))
            .sort()
        : [];
      json(res, 200, { dir: path.relative(ROOT, BRAND_DIR), images });
      return;
    }

    if (route === '/api/brand' && req.method === 'PUT') {
      const name = path
        .basename(url.searchParams.get('name') ?? '')
        .replace(/[^\w.\- ]+/g, '');
      if (!BRAND_EXT.test(name)) {
        json(res, 400, { error: 'use a PNG, JPG or WebP' });
        return;
      }
      const buf = await readBody(req, 20 * 1024 * 1024);
      if (!buf.length) {
        json(res, 400, { error: 'empty upload' });
        return;
      }
      ensureDir(BRAND_DIR);
      fs.writeFileSync(path.join(BRAND_DIR, name), buf);
      json(res, 200, { ok: true, name });
      return;
    }

    if (route === '/api/brand/file') {
      const name = path.basename(url.searchParams.get('name') ?? '');
      const file = path.join(BRAND_DIR, name);
      if (!BRAND_EXT.test(name) || !fs.existsSync(file)) {
        res.writeHead(404).end();
        return;
      }
      const type = /\.png$/i.test(name)
        ? 'image/png'
        : /\.webp$/i.test(name)
          ? 'image/webp'
          : 'image/jpeg';
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      fs.createReadStream(file).pipe(res);
      return;
    }

    // ── stock footage library (stock/) ───────────────────────────────────────
    if (route === '/api/stock' && req.method === 'GET') {
      json(res, 200, {
        dir: path.relative(ROOT, STOCK_DIR),
        clips: listStock().map(stockInfo),
      });
      return;
    }

    if (route === '/api/stock' && req.method === 'PUT') {
      const name = path
        .basename(url.searchParams.get('name') ?? '')
        .replace(/[^\p{L}\p{N}.\- _]+/gu, '');
      if (!STOCK_EXT.test(name)) {
        json(res, 400, {
          error: 'unsupported video type — mp4, mov, m4v, webm or mkv',
        });
        return;
      }
      const buf = await readBody(req, 500 * 1024 * 1024);
      if (!buf.length) {
        json(res, 400, { error: 'empty upload' });
        return;
      }
      ensureDir(STOCK_DIR);
      fs.writeFileSync(path.join(STOCK_DIR, name), buf);
      json(res, 200, { ok: true, name, clip: stockInfo(name) });
      return;
    }

    if (route === '/api/stock' && req.method === 'DELETE') {
      const name = stockName(url.searchParams.get('name') ?? '');
      if (!name) {
        json(res, 400, { error: 'bad name' });
        return;
      }
      fs.rmSync(path.join(STOCK_DIR, name), { force: true });
      fs.rmSync(path.join(STOCK_DIR, '.thumbs', `${name}.jpg`), {
        force: true,
      });
      json(res, 200, { ok: true, clips: listStock().map(stockInfo) });
      return;
    }

    if (route === '/api/stock/file') {
      const name = stockName(url.searchParams.get('name') ?? '');
      if (!name) {
        res.writeHead(404).end();
        return;
      }
      sendVideo(req, res, path.join(STOCK_DIR, name));
      return;
    }

    // A small JPEG a second in, made once and kept beside the clips in stock/.thumbs.
    if (route === '/api/stock/thumb') {
      const name = stockName(url.searchParams.get('name') ?? '');
      if (!name) {
        res.writeHead(404).end();
        return;
      }
      const src = path.join(STOCK_DIR, name);
      const thumb = path.join(STOCK_DIR, '.thumbs', `${name}.jpg`);
      if (
        !fs.existsSync(thumb) ||
        fs.statSync(thumb).mtimeMs < fs.statSync(src).mtimeMs
      ) {
        ensureDir(path.dirname(thumb));
        const at = Math.min(1, Math.max(0, stockInfo(name).seconds / 2));
        try {
          execFileSync(
            'ffmpeg',
            [
              '-hide_banner',
              '-loglevel',
              'error',
              '-y',
              '-ss',
              String(at),
              '-i',
              src,
              '-vf',
              'scale=320:320:force_original_aspect_ratio=increase,crop=320:320',
              '-frames:v',
              '1',
              '-q:v',
              '4',
              thumb,
            ],
            { env: childEnv() },
          );
        } catch {
          res.writeHead(404).end();
          return;
        }
      }
      res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
      });
      fs.createReadStream(thumb).pipe(res);
      return;
    }

    // Which clip each scene of a reel got (out/reels/<slug>/stock.json).
    if (route === '/api/picks') {
      const q = url.searchParams.get('slug') ?? '';
      const slug = isSlug(q) ? q : currentSlug();
      json(res, 200, { slug, picks: slug ? readPicksOf(reelPaths(slug)) : {} });
      return;
    }

    // Pin a library clip to a scene ("" = back to auto), then re-pick that scene.
    if (route === '/api/assign' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const id = String(body.sceneId ?? '');
      if (!/^\d{2}[a-z]?$/.test(id)) {
        json(res, 400, { error: 'bad sceneId' });
        return;
      }
      const clip = String(body.clip ?? '').trim();
      if (clip && !listStock().includes(clip)) {
        json(res, 400, { error: 'no such clip in the library' });
        return;
      }
      const reel = reelPaths(
        isSlug(body.slug ?? '') ? body.slug : currentSlug(),
      );
      const project = readProject(reel.slug);
      if (!project) {
        json(res, 400, { error: 'no such reel — render or save it first' });
        return;
      }
      const hook = id.slice(2);
      const target = hook
        ? project.hooks?.[hook.charCodeAt(0) - 'b'.charCodeAt(0)]
        : project.scenes?.[Number(id) - 1];
      if (!target) {
        json(res, 400, { error: 'no such scene' });
        return;
      }
      if (clip) target.clip = clip;
      else delete target.clip;
      fs.writeFileSync(reel.project, JSON.stringify(project, null, 2));
      fs.rmSync(path.join(reel.images, `${id}.png`), { force: true });
      invalidateScene(reel, id);
      const started = runScript(
        'pick-stock',
        [],
        { HOOK: hook },
        `assign ${id}`,
        reel,
        (code) => {
          if (code === 0)
            broadcast('picks', { slug: reel.slug, picks: readPicksOf(reel) });
        },
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true, project } : { error: 'busy' },
      );
      return;
    }

    // Switch video sequence mode ("scene" vs "continuous") and re-pick all scenes.
    if (route === '/api/stock-mode' && req.method === 'POST') {
      if (job) {
        json(res, 409, { error: `busy: ${jobLabel}` });
        return;
      }
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const mode = body.mode === 'continuous' ? 'continuous' : 'scene';
      const reel = reelPaths(
        isSlug(body.slug ?? '') ? body.slug : currentSlug(),
      );
      const project = readProject(reel.slug);
      if (!project) {
        json(res, 400, { error: 'no such reel — render or save it first' });
        return;
      }
      project.stock = { ...(project.stock ?? {}), mode };
      fs.writeFileSync(reel.project, JSON.stringify(project, null, 2));
      for (const scene of project.scenes ?? []) {
        fs.rmSync(path.join(reel.images, `${scene.id}.png`), { force: true });
        invalidateScene(reel, scene.id);
      }
      const started = runScript(
        'pick-stock',
        ['--force'],
        {},
        `mode ${mode}`,
        reel,
        (code) => {
          if (code === 0)
            broadcast('picks', { slug: reel.slug, picks: readPicksOf(reel) });
        },
      );
      json(
        res,
        started ? 200 : 409,
        started ? { ok: true, project } : { error: 'busy' },
      );
      return;
    }

    // ── music library ────────────────────────────────────────────────────────
    if (route === '/api/music' && req.method !== 'PUT') {
      const tracks = fs.existsSync(MUSIC_DIR)
        ? fs
            .readdirSync(MUSIC_DIR)
            .filter((f) => /\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(f))
            .sort()
        : [];
      json(res, 200, { dir: path.relative(ROOT, MUSIC_DIR), tracks });
      return;
    }

    if (route === '/api/music' && req.method === 'PUT') {
      const name = path
        .basename(url.searchParams.get('name') ?? '')
        .replace(/[^\w.\- ]+/g, '');
      if (!/\.(mp3|m4a|aac|wav|flac|ogg|opus)$/i.test(name)) {
        json(res, 400, { error: 'unsupported audio type' });
        return;
      }
      const buf = await readBody(req, 60 * 1024 * 1024);
      if (!buf.length) {
        json(res, 400, { error: 'empty upload' });
        return;
      }
      ensureDir(MUSIC_DIR);
      fs.writeFileSync(path.join(MUSIC_DIR, name), buf);
      json(res, 200, { ok: true, name });
      return;
    }

    res.writeHead(404).end('not found');
  } catch (err: any) {
    json(res, 500, { error: err?.message ?? String(err) });
  }
});

loadEnv();
loadQueue();
server.listen(PORT, '127.0.0.1', () => {
  const pending = queue.filter((q) => q.status === 'queued').length;
  if (pending) {
    console.log(
      `\x1b[36m  batch queue: ${pending} reel(s) pending${queuePaused ? ' (paused)' : ' — resuming'}\x1b[0m`,
    );
    pumpQueue();
  }
  console.log(
    `\x1b[35mfaceless-pipeline UI\x1b[0m  →  http://localhost:${PORT}`,
  );
  const caps = capabilities();
  if (!caps.ffmpeg.ok)
    console.log(
      `\x1b[33m  ffmpeg missing filters: ${caps.ffmpeg.missingFilters.join(', ') || 'ffmpeg not found'}\x1b[0m`,
    );
  if (!caps.kokoro.ok)
    console.log(
      `\x1b[33m  kokoro unavailable — the UI will offer placeholder voice instead\x1b[0m`,
    );
});
