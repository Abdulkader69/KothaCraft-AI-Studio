"""
Emit one project JSON per day from a compact table, using the shared
islamic-template defaults so every reel starts from the same look.

  python3 scripts/make-content.py            # writes content/60-days/day-NN.json
  python3 scripts/make-content.py --check    # validate only, write nothing

Content lives in content_data.py so this file stays mechanical.
"""
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "content" / "60-days"

STYLE = (
    "cinematic 35mm film still, natural light, rich colour, atmospheric depth, "
    "shallow depth of field, no visible faces"
)
# Animals are allowed on purpose — birds and bees are Qur'anic imagery and give
# the reels visual variety. Faces and idols stay blocked; distant figures,
# silhouettes and calligraphy are allowed so scenes can carry a human trace.
NEGATIVE = (
    "people, person, man, woman, child, face, portrait, statue, idol, "
    "watermark, logo, low quality, blurry, deformed"
)
MOTIONS = ["in", "left", "out", "right", "in", "right", "out", "left", "in", "right"]


def build(day: int, title: str, scenes: list[tuple[str, str, str]]) -> dict:
    return {
        "title": title,
        "aspect": "9:16",
        "fps": 30,
        "gap": 0.4,
        "image": {"style": STYLE, "negative": NEGATIVE},
        "voice": {
            "piperSpeaker": 0,          # bn_BD speaker chosen by ear; 0-15
            "mmsLang": "ben",
            "voiceId": "cgSgspJ2msm6clMCkdW9",
            "stability": 0.65,
            "similarity": 0.8,
            "speed": 0.95,
        },
        "captions": {
            "style": "highlight",
            "wordsPerCue": 3,
            "fontName": "Kohinoor Bangla",
            "primary": "#FFFFFF",
            "highlight": "#EBCB80",
            "outline": "#000000",
        },
        "intro": {"seconds": 2},                       # the title
        "outro": {"seconds": 4, "text": "প্রতিদিন একটি গল্প\nফলো করুন\nfacebook//হিকমাহ-Wisdom"},
        "music": {"gainDb": -26},
        "texture": {"grain": 6, "vignette": 4.5, "contrast": 1.05, "saturation": 1.02},
        "scenes": [
            {
                "id": f"{i + 1:02d}",
                "prompt": prompt,
                "narration": narration,
                "motion": MOTIONS[i % len(MOTIONS)],
                "source": source,
            }
            for i, (prompt, narration, source) in enumerate(scenes)
        ],
    }


def main() -> int:
    sys.path.insert(0, str(ROOT / "scripts"))
    from content_data import DAYS  # noqa: E402

    if len(DAYS) != 60:
        print(f'  warning: {len(DAYS)} days defined, expected 60')

    check_only = "--check" in sys.argv
    problems: list[str] = []
    seen_titles: set[str] = set()

    for day, title, scenes in DAYS:
        if not 5 <= len(scenes) <= 10:
            problems.append(f"day {day}: {len(scenes)} scenes (must be 5-10)")
        if title in seen_titles:
            problems.append(f"day {day}: duplicate title {title!r}")
        seen_titles.add(title)
        for i, (prompt, narration, source) in enumerate(scenes, 1):
            if not narration.strip():
                problems.append(f"day {day} scene {i}: empty narration")
            if not source.strip():
                problems.append(f"day {day} scene {i}: missing source")
            if not prompt.strip():
                problems.append(f"day {day} scene {i}: empty prompt")

    if problems:
        print("\n".join(f"  {p}" for p in problems))
        return 1

    if not check_only:
        OUT.mkdir(parents=True, exist_ok=True)
        bundle = []
        for day, title, scenes in DAYS:
            project = build(day, title, scenes)
            (OUT / f"day-{day:02d}.json").write_text(
                json.dumps(project, indent=2, ensure_ascii=False) + "\n", encoding="utf8"
            )
            bundle.append(project)
        # The UI accepts an array of projects and shows a picker.
        (ROOT / "content" / "60-days-all.json").write_text(
            json.dumps(bundle, indent=2, ensure_ascii=False) + "\n", encoding="utf8"
        )
        # One photo card per day, from the same topics — content/cards/60-days.json.
        from content.cards60 import CARDS  # noqa: E402
        cards = []
        for i, entry in enumerate(CARDS):
            heading, text, source, prompt, *rest = entry
            card = {"id": f"{i + 1:02d}", "heading": heading, "text": text, "source": source, "prompt": prompt}
            if rest:
                card["layout"] = rest[0]
            cards.append(card)
        card_set = {
            "title": "৬০ দিনের কার্ড",
            "aspect": "1:1",
            "layout": "center",
            "image": {"style": STYLE + ", calm composition with open space in the centre for text", "negative": NEGATIVE},
            "captions": {"fontName": "Kohinoor Bangla", "primary": "#FFFFFF", "highlight": "#EBCB80", "outline": "#000000"},
            "cards": cards,
        }
        (ROOT / "content" / "cards").mkdir(parents=True, exist_ok=True)
        (ROOT / "content" / "cards" / "60-days.json").write_text(
            json.dumps(card_set, indent=2, ensure_ascii=False) + "\n", encoding="utf8"
        )
        print(f"  {len(cards)} cards → content/cards/60-days.json")

    total_scenes = sum(len(s) for _, _, s in DAYS)
    chars = sum(len(n) for _, _, s in DAYS for _, n, _ in s)
    print(f"  {len(DAYS)} days, {total_scenes} scenes, {chars} chars of narration")
    print(f"  ~{chars} ElevenLabs credits if every reel is voiced once")
    if not check_only:
        print(f"  written to {OUT.relative_to(ROOT)}/ and content/60-days-all.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
