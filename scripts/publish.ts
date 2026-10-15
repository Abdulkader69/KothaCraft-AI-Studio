/**
 * Publish a rendered reel.
 *
 *   npm run publish -- --project out/reels/<slug>/project.json --to youtube,facebook,instagram
 *   npm run publish -- … --privacy unlisted          # youtube only; default from project.publish.privacy or "public"
 *   npm run publish -- … --title "…" --description "…" --hashtags "#a,#b"
 *
 * Reads <OUT_DIR>/final.mp4, writes what was posted to <OUT_DIR>/publish.json.
 * A platform that was already published is skipped unless --again is given.
 */
import fs from "node:fs";
import path from "node:path";
import { FINAL, OUT, POSTER, ROOT, loadEnv, loadProject } from "../src/config";
import { PLATFORM_CODE } from "../src/safe";
import { facebookReel, instagramReel } from "../src/publish/meta";
import { readPublish, writePublish } from "../src/publish/store";
import { postText } from "../src/publish/text";
import { tiktokPublish } from "../src/publish/tiktok";
import { youtubeUpload } from "../src/publish/youtube";
import { log, probeDuration, warn } from "../src/util";

const arg = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; };

async function main() {
  loadEnv();
  const project = loadProject();
  if (!fs.existsSync(FINAL)) throw new Error(`no video to publish — ${FINAL} not found; render first`);
  const to = (arg("to") ?? "youtube,facebook,instagram").split(",").map((s) => s.trim()).filter(Boolean);
  const again = process.argv.includes("--again");
  const text = postText(project, {
    title: arg("title"), description: arg("description"),
    hashtags: arg("hashtags")?.split(",").map((s) => s.trim()).filter(Boolean),
  });
  const privacy = (arg("privacy") ?? project.publish?.privacy ?? "public") as "public" | "unlisted" | "private";
  const dur = probeDuration(FINAL);

  /**
   * The cut made for that app, when the project rendered one — its captions sit
   * above that app's own UI. Falls back to the main cut.
   */
  // Covers. YouTube takes an image (the 16:9 poster); Instagram and Facebook
  // take a moment of the video instead, because their cover_url needs a public
  // image host and this runs on a laptop.
  const pub = project.publish ?? {};
  const scheduleIso = arg("schedule") ?? arg("publish-at") ?? (pub as any).publishAt;
  const thumbnail = pub.thumbnail === "" ? "" : pub.thumbnail ? path.resolve(ROOT, pub.thumbnail) : POSTER("16x9");
  const coverMs = Math.max(0, Math.round((pub.coverAt ?? 1) * 1000));

  const cutFor = (platform: keyof typeof PLATFORM_CODE): string => {
    const variant = FINAL.replace(/\.mp4$/, `-${PLATFORM_CODE[platform]}.mp4`);
    if (!fs.existsSync(variant)) return FINAL;
    log("publish", `${platform}: using ${path.basename(variant)}`);
    return variant;
  };
  if (dur > 90) warn("publish", `${dur.toFixed(0)}s is over Facebook Reels' 90 s limit — that upload may be rejected`);
  log("publish", `"${text.title}" → ${to.join(", ")}${scheduleIso ? ` (scheduled for ${scheduleIso})` : ""}`);

  const rec = readPublish(OUT);
  let failed = 0;
  for (const platform of to) {
    if ((rec as any)[platform] && !again) { log("publish", `${platform}: already published (${(rec as any)[platform].url}) — --again to repost`); continue; }
    try {
      const pData = (pub as any)?.[platform] ?? {};
      const pText = postText(project, {
        title: pData.title ?? arg("title") ?? text.title,
        description: pData.description ?? pData.caption ?? arg("description") ?? text.description,
        hashtags: pData.hashtags ?? (arg("hashtags") ? arg("hashtags")!.split(",").map((s) => s.trim()).filter(Boolean) : text.hashtags),
      });
      const pPrivacy = (arg("privacy") ?? pData.privacy ?? privacy) as "public" | "unlisted" | "private";
      const pCoverMs = Math.max(0, Math.round(((pData.coverAt ?? pub.coverAt ?? 1)) * 1000));

      if (platform === "youtube") {
        const r = await youtubeUpload({
          ...(thumbnail ? { thumbnail } : {}),
          file: cutFor("youtube"),
          title: pText.title,
          description: pText.description,
          tags: pText.hashtags,
          privacy: pPrivacy,
          ...(scheduleIso ? { publishAt: scheduleIso } : {}),
        });
        rec.youtube = { ...r, privacy: pPrivacy, at: Date.now(), ...(scheduleIso ? { scheduledAt: scheduleIso } : {}) };
      } else if (platform === "facebook") {
        const schedSec = scheduleIso ? Math.round(new Date(scheduleIso).getTime() / 1000) : undefined;
        rec.facebook = {
          ...(await facebookReel({
            coverMs: pCoverMs,
            file: cutFor("facebook"),
            title: pText.title,
            description: pText.description,
            ...(schedSec ? { scheduledPublishTime: schedSec } : {}),
          })),
          at: Date.now(),
          ...(scheduleIso ? { scheduledAt: scheduleIso } : {}),
        };
      } else if (platform === "instagram") {
        rec.instagram = {
          ...(await instagramReel({ coverMs: pCoverMs, file: cutFor("instagram"), title: pText.title, description: pText.description })),
          at: Date.now(),
          ...(scheduleIso ? { scheduledAt: scheduleIso } : {}),
        };
      } else if (platform === "tiktok") {
        const asDraft = pData.asDraft === true;
        const privacy = pData.privacy || (pPrivacy === "private" ? "SELF_ONLY" : "PUBLIC_TO_EVERYONE");
        const r = await tiktokPublish(
          {
            coverMs: pCoverMs,
            file: cutFor("tiktok"),
            title: pText.title,
            description: pText.description,
          },
          {
            asDraft,
            privacy,
          }
        );
        rec.tiktok = {
          publishId: r.publishId,
          url: r.url,
          status: r.status,
          at: Date.now(),
        };
      } else { warn("publish", `unknown platform ${platform}`); continue; }
      writePublish(OUT, rec);
      log("publish", `${platform}: ${(rec as any)[platform].url}`);
    } catch (e: any) {
      failed++;
      warn("publish", `${platform} failed: ${e.message}`);
    }
  }
  if (failed) process.exit(1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
