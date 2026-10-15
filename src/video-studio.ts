import { ChildProcess, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, env } from './config';
import { LTX2_BIN, LTX2_CACHE, LTX2_MODEL, ltx2Installed } from './providers/video';
import { STOCK_DIR, listStock } from './stock';
import { ensureDir, probeDuration } from './util';

export const AI_VIDEOS_DIR = path.join(ROOT, 'out', 'ai-videos');
export const AI_THUMBS_DIR = path.join(AI_VIDEOS_DIR, 'thumbs');
const META_FILE = path.join(AI_VIDEOS_DIR, 'metadata.json');

export interface VideoMeta {
  id: string;
  filename: string;
  prompt: string;
  negative?: string;
  duration: number;
  frames: number;
  width: number;
  height: number;
  audio: boolean;
  aspect: string;
  createdAt: number;
  size: number;
  hasThumb: boolean;
}

export interface VideoGenerateOptions {
  prompt: string;
  negative_prompt?: string;
  duration?: number;
  frames?: number;
  width?: number;
  height?: number;
  aspect?: string;
  audio?: boolean;
  image?: string;
  seed?: number | string;
  engine?: string;
}

export function readVideoMeta(): VideoMeta[] {
  ensureDir(AI_VIDEOS_DIR);
  ensureDir(AI_THUMBS_DIR);
  let list: VideoMeta[] = [];
  if (fs.existsSync(META_FILE)) {
    try {
      list = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    } catch {
      list = [];
    }
  }

  // Also discover any unindexed MP4s in out/ai-videos
  try {
    const existing = new Set(list.map((v) => v.filename));
    const files = fs.readdirSync(AI_VIDEOS_DIR).filter((f) => f.endsWith('.mp4'));
    let changed = false;

    for (const f of files) {
      if (!existing.has(f)) {
        const full = path.join(AI_VIDEOS_DIR, f);
        const st = fs.statSync(full);
        const thumb = path.join(AI_THUMBS_DIR, `${f}.jpg`);
        if (!fs.existsSync(thumb)) {
          generateThumb(full, thumb);
        }
        let dur = 0;
        try {
          dur = Math.round(probeDuration(full) * 10) / 10;
        } catch {
          dur = 2.0;
        }
        list.push({
          id: f,
          filename: f,
          prompt: f.replace(/^\d+-/, '').replace(/\.mp4$/, '').replace(/-/g, ' '),
          duration: dur,
          frames: Math.round(dur * 24),
          width: 704,
          height: 448,
          audio: true,
          aspect: '16:9',
          createdAt: Math.round(st.mtimeMs),
          size: st.size,
          hasThumb: fs.existsSync(thumb),
        });
        changed = true;
      }
    }
    if (changed) {
      list.sort((a, b) => b.createdAt - a.createdAt);
      fs.writeFileSync(META_FILE, JSON.stringify(list, null, 2));
    }
  } catch {}

  return list;
}

export function generateThumb(videoFile: string, thumbFile: string): boolean {
  try {
    ensureDir(path.dirname(thumbFile));
    execFileSync('ffmpeg', ['-y', '-ss', '00:00:00.5', '-i', videoFile, '-frames:v', '1', '-q:v', '2', thumbFile], {
      stdio: 'ignore',
    });
    return fs.existsSync(thumbFile);
  } catch {
    return false;
  }
}

export function deleteAiVideo(filename: string): boolean {
  const safe = path.basename(filename);
  const video = path.join(AI_VIDEOS_DIR, safe);
  const thumb = path.join(AI_THUMBS_DIR, `${safe}.jpg`);
  if (fs.existsSync(video)) fs.rmSync(video, { force: true });
  if (fs.existsSync(thumb)) fs.rmSync(thumb, { force: true });

  const list = readVideoMeta().filter((v) => v.filename !== safe);
  fs.writeFileSync(META_FILE, JSON.stringify(list, null, 2));
  return true;
}

export function saveAiVideoToStock(filename: string, customName?: string): { ok: boolean; stockName: string } {
  const safe = path.basename(filename);
  const src = path.join(AI_VIDEOS_DIR, safe);
  if (!fs.existsSync(src)) throw new Error(`Video file ${safe} not found`);

  ensureDir(STOCK_DIR);
  const baseName = customName ? customName.replace(/[^\w.-]/g, '_') : safe;
  const stockName = baseName.endsWith('.mp4') ? baseName : `${baseName}.mp4`;
  const dest = path.join(STOCK_DIR, stockName);

  fs.copyFileSync(src, dest);

  // Generate thumbnail in stock/.thumbs
  const stockThumb = path.join(STOCK_DIR, '.thumbs', `${stockName}.jpg`);
  generateThumb(dest, stockThumb);

  return { ok: true, stockName };
}

export function buildLtx2Args(
  opts: VideoGenerateOptions,
  destFile: string,
): { args: string[]; frames: number; width: number; height: number; tempImage?: string } {
  const fps = 24;
  let frames = opts.frames ? Number(opts.frames) : 0;
  if (!frames) {
    const sec = Number(opts.duration || 2);
    const k = Math.max(3, Math.min(15, Math.round((sec * fps - 1) / 8)));
    frames = 8 * k + 1; // 25 (1s), 49 (2s), 73 (3s), 97 (4s), 121 (5s)
  }

  const aspect = opts.aspect || '9:16';
  let width = opts.width ? Number(opts.width) : 0;
  let height = opts.height ? Number(opts.height) : 0;

  if (!width || !height) {
    if (aspect === '9:16') {
      width = 448;
      height = 704;
    } else if (aspect === '16:9') {
      width = 704;
      height = 448;
    } else if (aspect === '1:1') {
      width = 512;
      height = 512;
    } else if (aspect === '9:16-hd') {
      width = 704;
      height = 1280;
    } else if (aspect === '16:9-hd') {
      width = 1280;
      height = 704;
    } else {
      width = 448;
      height = 704;
    }
  }

  let tempImage: string | undefined;
  if (opts.image && opts.image.startsWith('data:image')) {
    ensureDir(AI_VIDEOS_DIR);
    tempImage = path.join(AI_VIDEOS_DIR, `temp-input-${Date.now()}.png`);
    const b64 = opts.image.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(tempImage, Buffer.from(b64, 'base64'));
  } else if (opts.image && fs.existsSync(opts.image)) {
    tempImage = opts.image;
  }

  const args: string[] = [
    'generate',
    '--model',
    LTX2_MODEL,
    '--text-encoder',
    'mlx-community/gemma-3-12b-it-4bit',
    '--prompt',
    opts.prompt.trim(),
    '--distilled',
    '--low-ram',
    '-f',
    String(frames),
    '--frame-rate',
    String(fps),
    '--width',
    String(width),
    '--height',
    String(height),
    '-o',
    destFile,
  ];

  if (opts.audio !== false) {
    args.push('--audio');
  }

  if (opts.negative_prompt && opts.negative_prompt.trim()) {
    args.push('--negative-prompt', opts.negative_prompt.trim());
  }

  if (opts.seed !== undefined && opts.seed !== '') {
    args.push('--seed', String(opts.seed));
  }

  if (tempImage) {
    args.push('--image', tempImage);
  }

  return { args, frames, width, height, tempImage };
}

