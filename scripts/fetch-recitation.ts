/**
 * Pull the per-ayat recitation clips a verse set needs.
 *
 *   npm run fetch:recitation -- --project content/verses/demo.json
 *   npm run fetch:recitation -- --project content/verses/demo.json --reciter Alafasy_64kbps
 *   npm run fetch:recitation -- --list
 *
 * Clips are cached in assets/recitation/<reciter>/<surah><ayah>.mp3 and shared
 * by every set, so the same ayat is only ever fetched once. Already-cached files
 * are left alone unless --force.
 *
 * The host is RECITATION_BASE (default everyayah.com), overridable per set with
 * `recitation.baseUrl`. The recordings belong to the reciters and their
 * publishers — this only retrieves them for local use.
 */
import fs from "node:fs";
import path from "node:path";
import { env, hasFlag, loadEnv, loadVerseSet } from "../src/config";
import { DEFAULT_RECITER, NO_BASMALA_SURAH, RECITATION_DIR, RECITERS, ayahFile, reciterById } from "../src/reciters";
import { ensureDir, log, warn } from "../src/util";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const argValue = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};

function listReciters(): void {
  const width = Math.max(...RECITERS.map((r) => r.name.length));
  for (const style of ["mujawwad", "murattal"] as const) {
    console.log(`\n  ${style === "mujawwad" ? "mujawwad — melodic, emotive" : "murattal — measured, fits more ayat"}`);
    for (const r of RECITERS.filter((x) => x.style === style)) {
      console.log(`    ${r.name.padEnd(width)}  ${r.id}`);
      console.log(`    ${" ".repeat(width)}  ${r.note}`);
    }
  }
  console.log(`\n  default: ${DEFAULT_RECITER}\n`);
}

async function main() {
  loadEnv();
  if (hasFlag("list")) return listReciters();

  const set = loadVerseSet();
  const force = hasFlag("force");
  const reciter = argValue("reciter", set.recitation?.reciter ?? DEFAULT_RECITER);
  const known = reciterById(reciter);
  if (!known) warn("recitation", `"${reciter}" is not in the registry — trying it as a folder name anyway`);

  const surah = Number(argValue("surah", String(set.surah ?? 0)));
  if (!surah) throw new Error('no surah — set "surah" in the verse set, or pass --surah');

  const base = (set.recitation?.baseUrl ?? env("RECITATION_BASE", "https://everyayah.com/data")).replace(/\/+$/, "");
  const dir = ensureDir(path.join(RECITATION_DIR, reciter));
  log("recitation", `${known?.name ?? reciter} — surah ${surah}`);

  // ayah 0 is this surah's own basmala, in this reciter's voice — not borrowed
  // from al-Fatiha. Surah 9 has none.
  const wants = new Set<number>();
  const opening = set.opening ?? "none";
  if ((opening === "basmala" || opening === "both") && surah !== NO_BASMALA_SURAH) wants.add(0);
  for (const v of set.verses) if (v.ayah != null) wants.add(v.ayah);
  const ayat = [...wants].sort((a, b) => a - b);
  if (!ayat.length) throw new Error('no ayat numbers — give each verse an "ayah"');
  if (opening === "taawwudh" || opening === "both") {
    log("recitation", "ta'awwudh has no per-ayat file — drop a clip at assets/recitation/taawwudh.mp3, or it shows silently");
  }

  let fetched = 0, cached = 0, missing = 0;
  for (const ayah of ayat) {
    const label = ayah === 0 ? `${surah}:basmala` : `${surah}:${ayah}`;
    const dest = path.join(dir, ayahFile(surah, ayah));
    if (fs.existsSync(dest) && fs.statSync(dest).size > 1024 && !force) { cached++; continue; }

    const url = `${base}/${reciter}/${ayahFile(surah, ayah)}`;
    const res = await fetch(url);
    if (!res.ok) { warn("recitation", `${label} — ${res.status} from ${url}`); missing++; continue; }
    const body = Buffer.from(await res.arrayBuffer());
    // A 200 carrying an error page would otherwise land as a corrupt "clip".
    if (body.length < 1024) { warn("recitation", `${label} — ${body.length} bytes, not audio`); missing++; continue; }
    fs.writeFileSync(dest, body);
    log("recitation", `${label}  ${(body.length / 1024).toFixed(0)} KB`);
    fetched++;
    await sleep(150);                        // one host, one request at a time
  }

  log("recitation", `${fetched} fetched, ${cached} already cached${missing ? `, ${missing} missing` : ""} → ${dir}`);
  if (missing) warn("recitation", `${missing} ayat have no audio — those will render silent`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
