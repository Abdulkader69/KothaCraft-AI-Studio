/**
 * Meta — one Facebook Login connects both a Facebook Page (Reels) and the
 * Instagram professional account linked to it (Reels), plus insights for both.
 *
 * Needs META_APP_ID + META_APP_SECRET in .env (a Meta app with Facebook Login,
 * http://localhost:<UI_PORT>/oauth/meta/callback as a valid redirect URI). In
 * Development mode the app's admins can publish to Pages they manage without
 * App Review — enough for your own channel.
 */
import fs from "node:fs";
import { env } from "../config";
import { log } from "../util";
import { fetchRetry, readStore, writeStore } from "./store";

const V = "v25.0";
const G = `https://graph.facebook.com/${V}`;
const SCOPES = [
  "pages_show_list", "pages_read_engagement", "pages_manage_posts", "publish_video", "read_insights",
  "instagram_basic", "instagram_content_publish", "instagram_manage_insights",
];

export interface MetaPage { id: string; name: string; token: string; igUserId?: string; igUsername?: string }
interface MetaStore { userToken: string; expiresAt: number; pages: MetaPage[]; pageId?: string }

export const metaConfigured = () => Boolean(env("META_APP_ID") && env("META_APP_SECRET"));
export const metaConnected = () => Boolean(readStore<MetaStore>("meta")?.userToken);
export function metaPages(): { pages: MetaPage[]; pageId: string } {
  const s = readStore<MetaStore>("meta");
  return { pages: (s?.pages ?? []).map(({ token, ...p }) => p as MetaPage), pageId: s?.pageId ?? s?.pages?.[0]?.id ?? "" };
}
export function metaSelectPage(pageId: string): void {
  const s = readStore<MetaStore>("meta");
  if (s && s.pages.some((p) => p.id === pageId)) writeStore("meta", { ...s, pageId });
}
function currentPage(): MetaPage {
  const s = readStore<MetaStore>("meta");
  if (!s?.userToken) throw new Error("Meta not connected — use Connect in the Publish section");
  const page = s.pages.find((p) => p.id === (s.pageId ?? s.pages[0]?.id));
  if (!page) throw new Error("no Facebook Page selected — the connected account manages no Pages, or none is chosen");
  return page;
}

export function metaAuthUrl(redirect: string, state: string): string {
  const q = new URLSearchParams({ client_id: env("META_APP_ID"), redirect_uri: redirect, state, scope: SCOPES.join(","), response_type: "code" });
  return `https://www.facebook.com/${V}/dialog/oauth?${q}`;
}

async function g(url: string, init: RequestInit = {}): Promise<any> {
  const res = await fetchRetry(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error(`meta ${res.status}: ${data.error?.message ?? JSON.stringify(data).slice(0, 200)}`);
  return data;
}

/** Code → short-lived user token → long-lived (60 days) → Pages with their tokens + IG accounts. */
export async function metaExchangeCode(code: string, redirect: string): Promise<void> {
  const id = env("META_APP_ID"), secret = env("META_APP_SECRET");
  const short = await g(`${G}/oauth/access_token?${new URLSearchParams({ client_id: id, client_secret: secret, redirect_uri: redirect, code })}`);
  const long = await g(`${G}/oauth/access_token?${new URLSearchParams({ grant_type: "fb_exchange_token", client_id: id, client_secret: secret, fb_exchange_token: short.access_token })}`);
  const userToken: string = long.access_token;
  const pagesRes = await g(`${G}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${userToken}`);
  const pages: MetaPage[] = (pagesRes.data ?? []).map((p: any) => ({
    id: p.id, name: p.name, token: p.access_token,
    igUserId: p.instagram_business_account?.id, igUsername: p.instagram_business_account?.username,
  }));
  const prev = readStore<MetaStore>("meta");
  writeStore("meta", { userToken, expiresAt: Date.now() + (long.expires_in ?? 5184000) * 1000, pages, pageId: prev?.pageId && pages.some((p) => p.id === prev.pageId) ? prev.pageId : pages[0]?.id });
}

export interface ReelPost { file: string; title: string; description: string;
  /** Milliseconds into the video to use as the cover frame. */
  coverMs?: number;
  /** Unix timestamp in seconds for scheduled Facebook release. */
  scheduledPublishTime?: number }

/** Facebook Page Reel: start → binary upload → finish (published or scheduled). */
export async function facebookReel(r: ReelPost): Promise<{ videoId: string; url: string; pageId: string }> {
  const page = currentPage();
  const start = await g(`${G}/${page.id}/video_reels`, { method: "POST", body: new URLSearchParams({ upload_phase: "start", access_token: page.token }) });
  const size = fs.statSync(r.file).size;
  log("publish", `facebook: uploading ${(size / 1024 / 1024).toFixed(1)} MB to page "${page.name}"`);
  const up = await fetchRetry(`https://rupload.facebook.com/video-upload/${V}/${start.video_id}`, {
    method: "POST", headers: { Authorization: `OAuth ${page.token}`, offset: "0", file_size: String(size), "Content-Type": "application/octet-stream" },
    body: fs.readFileSync(r.file),
  });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok || !upData.success) throw new Error(`facebook upload: ${JSON.stringify(upData).slice(0, 200)}`);
  const isScheduled = Boolean(
    r.scheduledPublishTime &&
    r.scheduledPublishTime > Math.floor(Date.now() / 1000) + 600
  );
  await g(`${G}/${page.id}/video_reels`, { method: "POST", body: new URLSearchParams({
    upload_phase: "finish",
    video_id: start.video_id,
    video_state: isScheduled ? "SCHEDULED" : "PUBLISHED",
    title: r.title,
    description: r.description,
    ...(r.coverMs !== undefined ? { thumb_offset: String(r.coverMs) } : {}),
    ...(isScheduled ? { scheduled_publish_time: String(r.scheduledPublishTime) } : {}),
    access_token: page.token }) });
  return { videoId: start.video_id, url: `https://www.facebook.com/reel/${start.video_id}`, pageId: page.id };
}

/** Instagram Reel: resumable container → binary upload → wait for FINISHED → publish. */
export async function instagramReel(r: ReelPost): Promise<{ mediaId: string; url: string; igUserId: string }> {
  const page = currentPage();
  if (!page.igUserId) throw new Error(`page "${page.name}" has no Instagram professional account linked — link one in Meta Business Suite`);
  const caption = `${r.title}\n\n${r.description}`.slice(0, 2200);
  const container = await g(`${G}/${page.igUserId}/media`, { method: "POST", body: new URLSearchParams({
    media_type: "REELS", upload_type: "resumable", caption, share_to_feed: "true",
    ...(r.coverMs !== undefined ? { thumb_offset: String(r.coverMs) } : {}),
    access_token: page.token }) });
  const size = fs.statSync(r.file).size;
  log("publish", `instagram: uploading ${(size / 1024 / 1024).toFixed(1)} MB to @${page.igUsername ?? page.igUserId}`);
  const up = await fetchRetry(`https://rupload.facebook.com/ig-api-upload/${V}/${container.id}`, {
    method: "POST", headers: { Authorization: `OAuth ${page.token}`, offset: "0", file_size: String(size), "Content-Type": "application/octet-stream" },
    body: fs.readFileSync(r.file),
  });
  const upData = await up.json().catch(() => ({}));
  if (!up.ok || !upData.success) throw new Error(`instagram upload: ${JSON.stringify(upData).slice(0, 200)}`);
  // Processing takes a while; publish only once the container says FINISHED.
  for (let i = 0; i < 40; i++) {
    const st = await g(`${G}/${container.id}?fields=status_code,status&access_token=${page.token}`);
    if (st.status_code === "FINISHED") break;
    if (st.status_code === "ERROR" || st.status_code === "EXPIRED") throw new Error(`instagram processing: ${st.status ?? st.status_code}`);
    await new Promise((res) => setTimeout(res, 5000));
  }
  const pub = await g(`${G}/${page.igUserId}/media_publish`, { method: "POST", body: new URLSearchParams({ creation_id: container.id, access_token: page.token }) });
  let url = `https://www.instagram.com/reel/${pub.id}`;
  try { const m = await g(`${G}/${pub.id}?fields=permalink&access_token=${page.token}`); if (m.permalink) url = m.permalink; } catch { /* optional */ }
  return { mediaId: pub.id, url, igUserId: page.igUserId };
}

export interface MetaStats { views: number; likes: number; comments: number; shares: number; saved?: number; reach?: number;
  avgWatchSeconds: number; totalWatchSeconds?: number; retention: number[] | null }

export async function facebookStats(videoId: string): Promise<MetaStats> {
  const page = currentPage();
  const metrics = "total_video_views,total_video_avg_time_watched,total_video_view_total_time,post_video_retention_graph,total_video_views_unique";
  const d = await g(`${G}/${videoId}/video_insights?metric=${metrics}&period=lifetime&access_token=${page.token}`);
  const get = (name: string) => d.data?.find((m: any) => m.name === name)?.values?.[0]?.value;
  const graph = get("post_video_retention_graph");
  const retention = graph && typeof graph === "object" ? Object.keys(graph).sort((a, b) => +a - +b).map((k) => Number(graph[k])) : null;
  let likes = 0, comments = 0, shares = 0;
  try {
    const v = await g(`${G}/${videoId}?fields=likes.summary(true),comments.summary(true)&access_token=${page.token}`);
    likes = v.likes?.summary?.total_count ?? 0; comments = v.comments?.summary?.total_count ?? 0;
  } catch { /* optional */ }
  return { views: +(get("total_video_views") ?? 0), reach: +(get("total_video_views_unique") ?? 0), likes, comments, shares,
    avgWatchSeconds: +(get("total_video_avg_time_watched") ?? 0) / 1000, totalWatchSeconds: +(get("total_video_view_total_time") ?? 0) / 1000, retention };
}

export async function instagramStats(mediaId: string): Promise<MetaStats> {
  const page = currentPage();
  const metrics = "views,reach,likes,comments,shares,saved,ig_reels_avg_watch_time,ig_reels_video_view_total_time";
  const d = await g(`${G}/${mediaId}/insights?metric=${metrics}&access_token=${page.token}`);
  const get = (name: string) => +(d.data?.find((m: any) => m.name === name)?.values?.[0]?.value ?? 0);
  return { views: get("views"), reach: get("reach"), likes: get("likes"), comments: get("comments"), shares: get("shares"), saved: get("saved"),
    avgWatchSeconds: get("ig_reels_avg_watch_time") / 1000, totalWatchSeconds: get("ig_reels_video_view_total_time") / 1000, retention: null };
}
