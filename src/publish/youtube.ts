/**
 * YouTube — OAuth 2.0 (web client, localhost redirect), resumable upload as a
 * Short, and the Analytics API for views / watch time / retention.
 *
 * Needs YOUTUBE_CLIENT_ID + YOUTUBE_CLIENT_SECRET in .env (a Google Cloud OAuth
 * client with http://localhost:<UI_PORT>/oauth/youtube/callback as a redirect URI)
 * and the YouTube Data API v3 + YouTube Analytics API enabled on that project.
 *
 * Note: uploads from an API project that has not passed Google's compliance
 * audit are locked private — see README "Publishing".
 */
import fs from "node:fs";
import path from "node:path";
import { env } from "../config";
import { log, warn } from "../util";
import { fetchRetry, readStore, writeStore } from "./store";

const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
  "https://www.googleapis.com/auth/yt-analytics.readonly",
];

interface Tokens { access_token: string; refresh_token: string; expires_at: number; channel?: { id: string; title: string } }

export const youtubeConfigured = () => Boolean(env("YOUTUBE_CLIENT_ID") && env("YOUTUBE_CLIENT_SECRET"));
export const youtubeConnected = () => Boolean(readStore<Tokens>("youtube")?.refresh_token);
export const youtubeChannel = () => readStore<Tokens>("youtube")?.channel ?? null;

export function youtubeAuthUrl(redirect: string): string {
  const q = new URLSearchParams({
    client_id: env("YOUTUBE_CLIENT_ID"), redirect_uri: redirect, response_type: "code",
    scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", include_granted_scopes: "true",
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${q}`;
}

async function tokenRequest(params: Record<string, string>): Promise<any> {
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env("YOUTUBE_CLIENT_ID"), client_secret: env("YOUTUBE_CLIENT_SECRET"), ...params }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`google oauth: ${data.error_description ?? data.error ?? res.status}`);
  return data;
}

export async function youtubeExchangeCode(code: string, redirect: string): Promise<void> {
  const t = await tokenRequest({ code, redirect_uri: redirect, grant_type: "authorization_code" });
  const tokens: Tokens = { access_token: t.access_token, refresh_token: t.refresh_token, expires_at: Date.now() + t.expires_in * 1000 };
  writeStore("youtube", tokens);
  // Remember which channel this is, for the UI.
  const me = await api("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true");
  const ch = me.items?.[0];
  if (ch) writeStore("youtube", { ...tokens, channel: { id: ch.id, title: ch.snippet.title } });
}

async function accessToken(): Promise<string> {
  const t = readStore<Tokens>("youtube");
  if (!t?.refresh_token) throw new Error("YouTube not connected — use Connect in the Publish section");
  if (Date.now() < t.expires_at - 60_000) return t.access_token;
  const r = await tokenRequest({ refresh_token: t.refresh_token, grant_type: "refresh_token" });
  writeStore("youtube", { ...t, access_token: r.access_token, expires_at: Date.now() + r.expires_in * 1000 });
  return r.access_token;
}

async function api(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetchRetry(url, { ...init, headers: { ...(init.headers ?? {}), Authorization: `Bearer ${await accessToken()}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`youtube ${res.status}: ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  return data;
}

export interface YoutubeUpload { file: string; title: string; description: string; tags: string[]; privacy: "public" | "unlisted" | "private";
  /** 16:9 cover image. Ignored by YouTube unless the channel is verified. */
  thumbnail?: string;
  /** ISO 8601 publish timestamp for YouTube scheduling (video stays private until then). */
  publishAt?: string }

/**
 * Custom thumbnail. Only verified channels may set one, and an unverified
 * channel answers 403 — that is a channel setting, not a broken upload, so it
 * is reported and the post stands.
 */
export async function youtubeThumbnail(videoId: string, file: string): Promise<boolean> {
  if (!fs.existsSync(file)) { warn("publish", `youtube: no thumbnail at ${file}`); return false; }
  const res = await fetchRetry(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "image/png" },
    body: fs.readFileSync(file),
  });
  if (res.ok) { log("publish", `youtube: thumbnail set from ${path.basename(file)}`); return true; }
  const body = (await res.text()).slice(0, 300);
  warn("publish", res.status === 403
    ? "youtube: custom thumbnails need a verified channel — verify at youtube.com/verify, then re-run publish"
    : `youtube: thumbnail ${res.status}: ${body}`);
  return false;
}

/** Resumable upload: one session request, then the whole file in one PUT. */
export async function youtubeUpload(u: YoutubeUpload): Promise<{ videoId: string; url: string }> {
  const size = fs.statSync(u.file).size;
  const meta: any = {
    snippet: { title: u.title, description: u.description, tags: u.tags.map((t) => t.replace(/^#/, "")), categoryId: "22", defaultLanguage: "bn" },
    status: {
      privacyStatus: u.publishAt ? "private" : u.privacy,
      selfDeclaredMadeForKids: false,
      ...(u.publishAt ? { publishAt: u.publishAt } : {}),
    },
  };
  const start = await fetchRetry("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status", {
    method: "POST",
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(size), "X-Upload-Content-Type": "video/mp4" },
    body: JSON.stringify(meta),
  });
  if (!start.ok) throw new Error(`youtube upload start ${start.status}: ${(await start.text()).slice(0, 300)}`);
  const session = start.headers.get("location");
  if (!session) throw new Error("youtube: no upload session URL");
  log("publish", `youtube: uploading ${(size / 1024 / 1024).toFixed(1)} MB`);
  const put = await fetchRetry(session, {
    method: "PUT", headers: { "Content-Type": "video/mp4", "Content-Length": String(size) },
    body: fs.readFileSync(u.file),
  });
  const data = await put.json().catch(() => ({}));
  if (!put.ok) throw new Error(`youtube upload ${put.status}: ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  if (u.thumbnail) await youtubeThumbnail(data.id, u.thumbnail);
  return { videoId: data.id, url: `https://youtube.com/shorts/${data.id}` };
}

export interface YoutubeStats {
  views: number; likes: number; comments: number;
  avgWatchSeconds: number; avgWatchPercent: number;
  /** 0..1 audience watch ratio at each 1/100 of the video, when YouTube has enough data. */
  retention: number[] | null;
  privacy?: string;
}

export async function youtubeStats(videoId: string): Promise<YoutubeStats> {
  const base = "https://youtubeanalytics.googleapis.com/v2/reports";
  const common = { ids: "channel==MINE", startDate: "2020-01-01", endDate: new Date().toISOString().slice(0, 10), filters: `video==${videoId}` };
  const summary = await api(`${base}?${new URLSearchParams({ ...common, metrics: "views,likes,comments,averageViewDuration,averageViewPercentage" })}`);
  const row = summary.rows?.[0] ?? [0, 0, 0, 0, 0];
  let retention: number[] | null = null;
  try {
    const r = await api(`${base}?${new URLSearchParams({ ...common, dimensions: "elapsedVideoTimeRatio", metrics: "audienceWatchRatio" })}`);
    if (r.rows?.length) retention = r.rows.map((x: number[]) => Number(x[1]));
  } catch { /* retention needs a minimum of views; fine without */ }
  let privacy: string | undefined;
  try {
    const v = await api(`https://www.googleapis.com/youtube/v3/videos?part=status&id=${videoId}`);
    privacy = v.items?.[0]?.status?.privacyStatus;
  } catch { /* optional */ }
  return { views: +row[0], likes: +row[1], comments: +row[2], avgWatchSeconds: +row[3], avgWatchPercent: +row[4], retention, privacy };
}
