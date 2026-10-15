/**
 * TikTok — Content Posting API v2.
 *
 * Supports OAuth 2.0 authorization, Direct Publishing (video.publish),
 * and Inbox / Draft Publishing (video.upload).
 *
 * Needs TIKTOK_CLIENT_KEY + TIKTOK_CLIENT_SECRET in .env
 * (A TikTok for Developers app with "Content Posting API" and
 * http://localhost:<UI_PORT>/oauth/tiktok/callback added to Redirect URIs).
 */
import fs from "node:fs";
import { env } from "../config";
import { log, warn } from "../util";
import { fetchRetry, readStore, writeStore } from "./store";
import type { ReelPost } from "./meta";

const TIKTOK_API = "https://open.tiktokapis.com/v2";
const TIKTOK_AUTH = "https://www.tiktok.com/v2/auth/authorize/";
const SCOPES = ["user.info.basic", "video.publish", "video.upload"];

export interface TikTokAccount {
  open_id: string;
  union_id?: string;
  username?: string;
  display_name?: string;
  avatar_url?: string;
}

export interface TikTokCreatorInfo {
  creator_avatar_url?: string;
  creator_nickname?: string;
  creator_username?: string;
  privacy_level_options?: string[];
  comment_disabled?: boolean;
  duet_disabled?: boolean;
  stitch_disabled?: boolean;
  max_video_post_duration_sec?: number;
}

export interface TikTokStore {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  refresh_expires_at?: number;
  open_id: string;
  account?: TikTokAccount;
  creator?: TikTokCreatorInfo;
}

export const tiktokConfigured = () => Boolean(env("TIKTOK_CLIENT_KEY") && env("TIKTOK_CLIENT_SECRET"));
export const tiktokConnected = () => Boolean(readStore<TikTokStore>("tiktok")?.refresh_token);
export const tiktokAccount = () => readStore<TikTokStore>("tiktok")?.account ?? null;

export function tiktokAuthUrl(redirect: string, state: string): string {
  const q = new URLSearchParams({
    client_key: env("TIKTOK_CLIENT_KEY"),
    scope: SCOPES.join(","),
    response_type: "code",
    redirect_uri: redirect,
    state,
  });
  return `${TIKTOK_AUTH}?${q}`;
}

async function requestToken(params: Record<string, string>): Promise<any> {
  const res = await fetchRetry(`${TIKTOK_API}/oauth/token/`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
    body: new URLSearchParams({
      client_key: env("TIKTOK_CLIENT_KEY"),
      client_secret: env("TIKTOK_CLIENT_SECRET"),
      ...params,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || (data.data && data.data.error_code)) {
    const err = data.error_description || data.error || data.message || data.data?.error_message || "token request failed";
    throw new Error(`tiktok oauth: ${err}`);
  }
  return data.data ?? data;
}

export async function tiktokExchangeCode(code: string, redirect: string): Promise<void> {
  const t = await requestToken({
    code,
    grant_type: "authorization_code",
    redirect_uri: redirect,
  });

  const tokens: TikTokStore = {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    expires_at: Date.now() + (t.expires_in ?? 86400) * 1000,
    refresh_expires_at: Date.now() + (t.refresh_expires_in ?? 31536000) * 1000,
    open_id: t.open_id,
  };
  writeStore("tiktok", tokens);

  // Fetch user account info
  let account: TikTokAccount | undefined;
  try {
    const meRes = await api(`${TIKTOK_API}/user/info/?fields=open_id,union_id,avatar_url,display_name,username`, tokens.access_token);
    account = meRes.data?.user;
  } catch (err: any) {
    warn("publish", `tiktok: could not fetch profile info (${err.message})`);
  }

  // Fetch creator publishing options
  let creator: TikTokCreatorInfo | undefined;
  try {
    const cRes = await api(`${TIKTOK_API}/post/publish/creator_info/query/`, tokens.access_token, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify({}),
    });
    creator = cRes.data;
  } catch (err: any) {
    warn("publish", `tiktok: could not fetch creator publishing info (${err.message})`);
  }

  writeStore("tiktok", {
    ...tokens,
    account: account || (creator?.creator_username ? { open_id: tokens.open_id, username: creator.creator_username, display_name: creator.creator_nickname } : undefined),
    creator,
  });
}

async function tiktokAccessToken(): Promise<string> {
  const s = readStore<TikTokStore>("tiktok");
  if (!s?.refresh_token) throw new Error("TikTok not connected — click Connect in the Publish section");
  if (Date.now() < s.expires_at - 60_000) return s.access_token;

  log("publish", "tiktok: refreshing access token");
  const r = await requestToken({
    grant_type: "refresh_token",
    refresh_token: s.refresh_token,
  });

  const updated: TikTokStore = {
    ...s,
    access_token: r.access_token,
    refresh_token: r.refresh_token || s.refresh_token,
    expires_at: Date.now() + (r.expires_in ?? 86400) * 1000,
  };
  writeStore("tiktok", updated);
  return r.access_token;
}

async function api(url: string, token?: string, init: RequestInit = {}): Promise<any> {
  const t = token || (await tiktokAccessToken());
  const res = await fetchRetry(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${t}`,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.error && data.error.code !== "ok" && data.error.code !== 0)) {
    const msg = data.error?.message || data.message || JSON.stringify(data).slice(0, 200);
    throw new Error(`tiktok api ${res.status}: ${msg}`);
  }
  return data;
}

export interface TikTokPublishOptions {
  privacy?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "FOLLOWER_OF_CREATOR" | "SELF_ONLY";
  asDraft?: boolean;
  disableComments?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
}

/**
 * Publish video to TikTok via Direct Post or Draft upload.
 */
export async function tiktokPublish(
  r: ReelPost,
  opts: TikTokPublishOptions = {}
): Promise<{ publishId: string; url?: string; status: string }> {
  if (!fs.existsSync(r.file)) throw new Error(`tiktok: video file not found at ${r.file}`);
  const size = fs.statSync(r.file).size;
  if (size < 1024) throw new Error(`tiktok: video file is empty (${size} bytes)`);

  const s = readStore<TikTokStore>("tiktok");
  const allowedPrivacy = s?.creator?.privacy_level_options ?? ["PUBLIC_TO_EVERYONE", "SELF_ONLY"];
  
  // Pick preferred privacy or default to most permissive permitted by account
  let privacy = opts.privacy || (allowedPrivacy.includes("PUBLIC_TO_EVERYONE") ? "PUBLIC_TO_EVERYONE" : allowedPrivacy[0] || "SELF_ONLY");
  if (!allowedPrivacy.includes(privacy)) {
    privacy = (allowedPrivacy[0] as any) || "SELF_ONLY";
  }

  const caption = `${r.title}\n\n${r.description}`.slice(0, 2200).trim();
  const initEndpoint = opts.asDraft
    ? `${TIKTOK_API}/post/publish/inbox/video/init/`
    : `${TIKTOK_API}/post/publish/video/init/`;

  const payload: Record<string, any> = {
    source_info: {
      source: "FILE_UPLOAD",
      video_size: size,
      chunk_size: size,
      total_chunk_count: 1,
    },
  };

  if (!opts.asDraft) {
    payload.post_info = {
      title: caption,
      privacy_level: privacy,
      disable_comment: opts.disableComments ?? false,
      disable_duet: opts.disableDuet ?? false,
      disable_stitch: opts.disableStitch ?? false,
      video_cover_timestamp_ms: r.coverMs ?? 1000,
    };
  }

  log("publish", `tiktok: initializing ${opts.asDraft ? "inbox draft" : `direct post (${privacy})`} for ${(size / 1024 / 1024).toFixed(1)} MB`);
  const initRes = await api(initEndpoint, undefined, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=UTF-8" },
    body: JSON.stringify(payload),
  });

  const publishId = initRes.data?.publish_id;
  const uploadUrl = initRes.data?.upload_url;
  if (!uploadUrl || !publishId) {
    throw new Error(`tiktok init failed: no upload_url returned (${JSON.stringify(initRes)})`);
  }

  // Upload video chunk via PUT
  log("publish", "tiktok: uploading video bytes to TikTok ingest server");
  const up = await fetchRetry(uploadUrl, {
    method: "PUT",
    headers: {
      "Content-Type": "video/mp4",
      "Content-Range": `bytes 0-${size - 1}/${size}`,
      "Content-Length": String(size),
    },
    body: fs.readFileSync(r.file),
  });

  if (!up.ok) {
    const upErr = await up.text().catch(() => "");
    throw new Error(`tiktok upload chunk failed (${up.status}): ${upErr.slice(0, 200)}`);
  }

  // Poll status until PUBLISH_COMPLETE or FAILED
  log("publish", `tiktok: processing video (publish_id: ${publishId})`);
  let status = "PROCESSING_UPLOAD";
  let postUrl: string | undefined;

  for (let i = 0; i < 30; i++) {
    await new Promise((res) => setTimeout(res, 5000));
    try {
      const st = await api(`${TIKTOK_API}/post/publish/status/fetch/`, undefined, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=UTF-8" },
        body: JSON.stringify({ publish_id: publishId }),
      });

      status = st.data?.status || status;
      if (status === "PUBLISH_COMPLETE") {
        const postIds = st.data?.publicaly_available_post_id;
        if (postIds && postIds.length) {
          const user = s?.account?.username || s?.creator?.creator_username;
          postUrl = user ? `https://www.tiktok.com/@${user}/video/${postIds[0]}` : undefined;
        }
        log("publish", `tiktok: publish completed! ${postUrl || ""}`);
        break;
      }
      if (status === "FAILED") {
        throw new Error(`tiktok publish failed: ${st.data?.fail_reason || "unknown error"}`);
      }
    } catch (err: any) {
      if (err.message.includes("failed")) throw err;
    }
  }

  return {
    publishId,
    url: postUrl || (s?.account?.username ? `https://www.tiktok.com/@${s.account.username}` : undefined),
    status,
  };
}

