/**
 * Connection state for publishing lives in .publish/ (gitignored): OAuth tokens
 * for YouTube and Meta, and which Facebook Page / Instagram account to post to.
 */
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config";

export const PUBLISH_DIR = path.join(ROOT, ".publish");

export function readStore<T>(name: string): T | null {
  const file = path.join(PUBLISH_DIR, `${name}.json`);
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return null; }
}
export function writeStore(name: string, data: unknown): void {
  fs.mkdirSync(PUBLISH_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLISH_DIR, `${name}.json`), JSON.stringify(data, null, 2), { mode: 0o600 });
}
export function clearStore(name: string): void {
  fs.rmSync(path.join(PUBLISH_DIR, `${name}.json`), { force: true });
}

/** What a reel has been published as — out/reels/<slug>/publish.json. */
export interface PublishRecord {
  youtube?: { videoId: string; url: string; privacy: string; at: number; scheduledAt?: string };
  facebook?: { videoId: string; url: string; pageId: string; at: number; scheduledAt?: string };
  instagram?: { mediaId: string; url: string; igUserId: string; at: number; scheduledAt?: string };
  tiktok?: { publishId: string; url?: string; at: number; status?: string };
}
export function readPublish(reelDir: string): PublishRecord {
  try { return JSON.parse(fs.readFileSync(path.join(reelDir, "publish.json"), "utf8")); } catch { return {}; }
}
export function writePublish(reelDir: string, rec: PublishRecord): void {
  fs.writeFileSync(path.join(reelDir, "publish.json"), JSON.stringify(rec, null, 2));
}

export interface ScheduledJob {
  id: string;
  slug: string;
  platforms: string[];
  scheduledAt: string;
  scheduledTime: number;
  createdAt: number;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  error?: string;
  nativeUpload?: boolean;
  title?: string;
  description?: string;
  hashtags?: string[];
  privacy?: string;
  coverAt?: number;
  platformData?: Record<string, any>;
}

export function readSchedules(): ScheduledJob[] {
  const file = path.join(PUBLISH_DIR, "schedules.json");
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return []; }
}

export function writeSchedules(list: ScheduledJob[]): void {
  fs.mkdirSync(PUBLISH_DIR, { recursive: true });
  fs.writeFileSync(path.join(PUBLISH_DIR, "schedules.json"), JSON.stringify(list, null, 2));
}

/** Retry a fetch a few times on 5xx / network errors — uploads are long and flaky. */
export async function fetchRetry(url: string, init: RequestInit, tries = 3): Promise<Response> {
  let last: any;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res;
      last = new Error(`${res.status} ${await res.text()}`);
    } catch (e) { last = e; }
    await new Promise((r) => setTimeout(r, 2000 * (i + 1)));
  }
  throw last;
}
