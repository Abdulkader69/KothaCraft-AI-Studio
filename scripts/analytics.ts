/**
 * Pull views / watch time / retention for every published reel and record it
 * next to the project file, plus one summary for the whole set.
 *
 *   npm run analytics                       # every reel in out/reels with a publish.json
 *   npm run analytics -- --project out/reels/<slug>/project.json   # just one
 *
 * Writes out/reels/<slug>/analytics.json and out/analytics.json.
 */
import fs from "node:fs";
import path from "node:path";
import { REELS, ROOT, loadEnv } from "../src/config";
import { facebookStats, instagramStats, metaConnected, type MetaStats } from "../src/publish/meta";
import { readPublish } from "../src/publish/store";
import { youtubeConnected, youtubeStats, type YoutubeStats } from "../src/publish/youtube";
import { log, warn } from "../src/util";

export interface ReelAnalytics {
  slug: string; title: string; fetchedAt: number; durationSeconds?: number;
  youtube?: YoutubeStats & { url: string; at: number };
  facebook?: MetaStats & { url: string; at: number };
  instagram?: MetaStats & { url: string; at: number };
}

async function main() {
  loadEnv();
  // The UI always passes --project; --all overrides it to mean "every reel".
  const flag = process.argv.includes("--all") ? -1 : process.argv.indexOf("--project");
  const dirs = flag > -1
    ? [path.dirname(path.resolve(ROOT, process.argv[flag + 1]))]
    : fs.existsSync(REELS) ? fs.readdirSync(REELS).map((d) => path.join(REELS, d)).filter((d) => fs.existsSync(path.join(d, "publish.json"))) : [];
  if (!dirs.length) { warn("analytics", "no published reels yet"); return; }

  const all: ReelAnalytics[] = [];
  for (const dir of dirs) {
    const pub = readPublish(dir);
    let title = path.basename(dir), durationSeconds: number | undefined;
    try { title = JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).title ?? title; } catch {}
    try { durationSeconds = JSON.parse(fs.readFileSync(path.join(dir, "timeline.json"), "utf8")).total; } catch {}
    const rec: ReelAnalytics = { slug: path.basename(dir), title, fetchedAt: Date.now(), durationSeconds };
    const tries: [keyof typeof pub, () => Promise<any>][] = [
      ["youtube", async () => youtubeConnected() && pub.youtube ? { ...(await youtubeStats(pub.youtube.videoId)), url: pub.youtube.url, at: pub.youtube.at } : undefined],
      ["facebook", async () => metaConnected() && pub.facebook ? { ...(await facebookStats(pub.facebook.videoId)), url: pub.facebook.url, at: pub.facebook.at } : undefined],
      ["instagram", async () => metaConnected() && pub.instagram ? { ...(await instagramStats(pub.instagram.mediaId)), url: pub.instagram.url, at: pub.instagram.at } : undefined],
    ];
    for (const [platform, fn] of tries) {
      try { const r = await fn(); if (r) (rec as any)[platform] = r; }
      catch (e: any) { warn("analytics", `${rec.slug} ${platform}: ${e.message}`); }
    }
    fs.writeFileSync(path.join(dir, "analytics.json"), JSON.stringify(rec, null, 2));
    const parts = (["youtube", "facebook", "instagram"] as const).filter((p) => rec[p]).map((p) => `${p} ${rec[p]!.views} views, ${rec[p]!.avgWatchSeconds.toFixed(1)}s avg`);
    log("analytics", `${rec.slug}: ${parts.join(" · ") || "nothing fetched"}`);
    all.push(rec);
  }
  if (flag === -1) {
    all.sort((a, b) => b.fetchedAt - a.fetchedAt);
    fs.writeFileSync(path.join(ROOT, "out", "analytics.json"), JSON.stringify({ fetchedAt: Date.now(), reels: all }, null, 2));
    log("analytics", `${all.length} reel(s) → out/analytics.json`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
