/** Title, description and hashtags for a post, from the project file. */
import type { Project } from "../types";

export interface PostText { title: string; description: string; hashtags: string[] }

const DEFAULT_TAGS = ["#islamic", "#quran", "#hadith", "#bangla", "#reels", "#shorts", "#হিকমাহ"];

export function postText(project: Project, override: Partial<PostText> = {}): PostText {
  const pub = project.publish ?? {};
  const title = (override.title ?? pub.title ?? project.title).trim().slice(0, 100);
  const hashtags = (override.hashtags ?? pub.hashtags ?? DEFAULT_TAGS).map((t) => (t.startsWith("#") ? t : `#${t}`));
  let description = (override.description ?? pub.description ?? project.description ?? "").trim();
  if (!description) {
    // First line of narration/dialogue/verse as the hook, the citations as a source list.
    const scenes = project.scenes ?? [];
    const verses = (project as any).verses ?? [];
    let hook = scenes[0]?.narration?.trim() ?? "";
    if (!hook && (scenes[0] as any)?.lines?.length) {
      const firstLine = (scenes[0] as any).lines[0];
      hook = firstLine.text?.trim() ?? "";
    }
    if (!hook && verses.length) {
      hook = verses[0]?.bangla?.trim() || verses[0]?.narration?.trim() || "";
    }
    const sources = [...new Set(scenes.map((s) => (s.source ?? "").trim()).filter(Boolean))];
    if (verses.length && (project as any).surah) {
      sources.push(`সূরা ${project.title || (project as any).surah}`);
    }
    description = [hook, "", sources.length ? `সূত্র: ${sources.join(" · ")}` : ""].filter((l, i) => i !== 1 || sources.length).join("\n");
  }
  return { title, description: `${description}\n\n${hashtags.join(" ")}`.trim(), hashtags };
}
