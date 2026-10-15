# হিকমাহ — 60 days of content

60 ready-to-render reels, 6–9 scenes each. Every scene carries a `source` that renders
at the top of frame.

```
day-01.json … day-60.json      one reel each
../60-days-all.json            all 60 in one file — Import JSON shows a picker
```

## How to run

Open the UI (`npm run ui`), click **Import JSON**, and pick either a single day or
`60-days-all.json` and choose from the list. Each renders into its own folder named from
its Bangla title.

## ⚠️ Verify the citations before publishing

**This is the one thing you must not skip.**

- **Qur'an references (surah:ayah)** — high confidence. Days 1–10 are entirely Qur'anic.
- **Hadith numbers** — treat as *drafts to check*. Numbering differs between editions and
  printings, so a number that is right in one edition can be wrong in another. Check each
  against [sunnah.com](https://sunnah.com) before the reel goes out.
- A few entries cite **আস-সীরাহ** (seerah) generally rather than a numbered report. Those
  are well-established events, but if you want a precise citation, add one.

You promised your audience that every narration is sourced. That promise is worth more
than publishing quickly — and one wrong attribution in this niche is very hard to undo.

## Imagery

Prompts span green landscapes, forests, meadows and flowers, sea and rivers, sunrise and
sunset, moonlit nights, roads through nature, food gardens, and birds and bees — matched
to what each day's narration is actually about. Desert appears in only 6 of 60 days, where
the story calls for it (Bilal on the hot sand, the road to Ta'if).

Animals are **allowed** in the negative prompt on purpose — birds and bees are Qur'anic
imagery and give the reels visual variety. Only human figures, faces and idols stay
blocked.

## Themes

| Days | Theme |
|---|---|
| 1–10 | Prophets' stories — Qur'an only |
| 11–20 | Character and akhlaq |
| 21–30 | Salah, dhikr, du'a, reliance |
| 31–40 | Seerah moments and the early community |
| 41–50 | The self, wealth, and the heart |
| 51–60 | Death, accountability, mercy, the hereafter |

Day 60 closes the cycle deliberately — start again, or write your own from
`content/islamic-template.json`.

## Cost per run

397 scenes, **19,058 characters** of narration total.

- **MMS** (`TTS_PROVIDER=mms`) — free, offline, unlimited. No commercial-licence issue.
- **ElevenLabs** — ~19,058 credits for all 60, so **roughly two months** of the free
  10,000/month tier. Better voice and free word-level timings, but the free tier carries
  no commercial licence.

Images on `cloudflare` or `pollinations` are free within their limits.

## Editing

Content lives in `scripts/content/part1.py … part6.py`. Edit there and re-run:

```bash
python3 scripts/make-content.py --check    # validate, write nothing
python3 scripts/make-content.py            # regenerate all 60
```

The generator enforces 5–10 scenes, non-empty narration, and a source on every scene.
Shared look (style, negative prompt, captions, voice, music) lives in
`scripts/make-content.py`, so changing it once updates all 60.
