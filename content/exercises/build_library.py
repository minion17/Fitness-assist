"""Builds translated_exercises.json (the exercise library) from free-exercise-db (Unlicense) and our Russian texts.

Run after changing sources/names-ru.json or the glossary below:  python content/exercises/build_library.py
- names: hand-made translations (sources/names-ru.json), the machine ones were often wrong ("3/4 Sit-Up" -> "приседания")
- technique: the machine translation with fixes for terms it got wrong systematically (glossary)
- muscles: the source's primaryMuscles / secondaryMuscles as keys (chest, lats ...) for the muscle map
- exercises we already have in exercises.json (they carry source_id) are left out here, and get muscles and photos there
"""
import json
import re
from pathlib import Path

HERE = Path(__file__).parent
SRC = HERE / "sources"

# machine-translation terms that were wrong everywhere: (pattern, replacement)
GLOSSARY = [
    (r"проповедника", "Скотта"),  # "скамья проповедника" (preacher bench)
    (r"\bшкив(ом|ами|ах|ов|ы|а|у|е)?\b", lambda m: "блок" + {"ом": "ом", "ами": "ами", "ах": "ах", "ов": "ов", "ы": "и", "а": "а", "у": "у", "е": "е"}.get(m.group(1) or "", "")),
    (r"\bлент(ами|ах|ой|ою|ы|у|е|а)?\b", lambda m: {"ами": "петлями", "ах": "петлях", "ой": "петлёй", "ою": "петлёй", "ы": "петли", "у": "петлю", "е": "петле", "а": "петля"}.get(m.group(1) or "", "петель")),
    (r"пенопластов(ый|ого|ом|ому|ым)", r"массажн\1"),
    (r"\bкоробк(ой|ами|ах|а|и|у|е)\b", lambda m: "тумб" + {"ой": "ой", "ами": "ами", "ах": "ах", "а": "а", "и": "ы", "у": "у", "е": "е"}[m.group(1)]),
]


# our exercises that are library ones under another name
SAME_AS = {
    "Жим штанги лежа": "Barbell_Bench_Press_-_Medium_Grip", "Становая тяга": "Barbell_Deadlift", "Армейский жим": "Standing_Military_Press",
    "Отжимания от пола": "Pushups", "Жим ногами в тренажёре": "Leg_Press", "Разгибание ног в тренажёре": "Leg_Extensions",
    "Сгибание ног в тренажёре": "Lying_Leg_Curls", "Подъём штанги на бицепс": "Barbell_Curl", "Французский жим": "Lying_Triceps_Press",
    "Разгибание рук на блоке": "Triceps_Pushdown", "Тяга гантели в наклоне": "One-Arm_Dumbbell_Row",
    "Тяга верхнего блока к груди": "Wide-Grip_Lat_Pulldown", "Молотки с гантелями": "Hammer_Curls", "Ягодичный мост": "Butt_Lift_Bridge",
    "Скручивания на полу": "Crunches", "Скакалка": "Rope_Jumping",
}
# our muscle names -> the map's keys, for exercises of ours without a library twin
RU_MUSCLE = {
    "Грудь": "chest", "Трицепс": "triceps", "Бицепс бедра": "hamstrings", "Плечи": "shoulders", "Дельты": "shoulders",
    "Передняя дельта": "shoulders", "Средняя дельта": "shoulders", "Задняя дельта": "shoulders", "Квадрицепс": "quadriceps",
    "Ягодицы": "glutes", "Разгибатели спины": "lower back", "Бицепс": "biceps", "Брахиалис": "biceps", "Икроножные": "calves",
    "Икры": "calves", "Пресс": "abdominals", "Кор": "abdominals", "Прямая мышца живота": "abdominals", "Нижняя часть пресса": "abdominals",
    "Подвздошно-поясничная": "abdominals", "Мышцы середины спины": "middle back", "Ромбовидные": "middle back",
    "Широчайшие мышцы спины": "lats", "Широчайшие": "lats", "Трапеции": "traps", "Предплечья": "forearms",
    "Приводящие мышцы бедра": "adductors",
}


# equipment the source doesn't list ("body only" for pull-ups): read from the English name
EXTRA_GEAR = [
    (r"\bPull-?Ups?\b|\bPullups?\b|(?<!To )\bChin(?:-?Ups?|s)?\b(?! To)|\bHanging\b(?! Bar Good)|\bMuscle Up\b|\bToes? to Bar\b", "Турник"),
    (r"\bDips?\b(?! Squat)|Parallel Bar", "Брусья"),
    (r"Bench Press|Incline .*Press|Decline .*Press|Bench Dip|on Bench|on Incline|Dumbbell Flyes|Incline .*Fly|Decline .*Fly|Flat Bench|Pullover|Preacher|Step.?Ups?", "Скамья"),
    (r"Exercise Ball|Stability Ball|Physioball|Swiss Ball|Bosu", "Фитбол"),
    (r"Medicine Ball", "Медбол"),
    (r"Band", "Эспандер"),
    (r"Kettlebell", "Гиря"),
    (r"Smith", "Тренажёр"),
    (r"Cable|Pulley|Pulldown|Pushdown", "Блок"),
    (r"Sled|Prowler", "Сани"),
    (r"Suspended|Straps|TRX", "Петли TRX"),
    (r"\bBox\b", "Тумба"),
    (r"SMR|Foam", "Ролик"),
    (r"Rope Jump|Jump Rope|Rope Jumping", "Скакалка"),
]


def gear(name_en: str, base: list[str]) -> list[str]:
    extra = [label for pattern, label in EXTRA_GEAR if re.search(pattern, name_en, re.I)]
    return list(dict.fromkeys([*[g for g in base if g != "Оборудование не указано" or not extra], *extra]))


def fix(text: str | None) -> str | None:
    if not text:
        return text
    for pattern, repl in GLOSSARY:
        text = re.sub(pattern, repl, text)
    return text


def main():
    source = {e["id"]: e for e in json.loads((SRC / "free-exercise-db.json").read_text(encoding="utf-8"))}
    ru = {e["source_id"]: e for e in json.loads((SRC / "free-exercise-db-ru.json").read_text(encoding="utf-8"))}
    names = json.loads((SRC / "names-ru.json").read_text(encoding="utf-8"))
    old = {e["source_id"]: e for e in json.loads((HERE / "translated_exercises.json").read_text(encoding="utf-8"))}
    ours = json.loads((HERE / "exercises.json").read_text(encoding="utf-8"))
    # an exercise of ours with the same name as a library one is that exercise: link it, keep one copy
    by_name = {e["name"]: e for e in ours}
    for name, sid in SAME_AS.items():
        if name in by_name and not by_name[name].get("source_id"):
            by_name[name]["source_id"] = sid
    for sid in old:
        twin = by_name.get(names[sid])
        if twin is not None and not twin.get("source_id"):
            twin["source_id"] = sid
    curated = {e["source_id"] for e in ours if e.get("source_id")}

    def extra(sid: str) -> dict:
        s = source[sid]
        return {"primary_muscles": s.get("primaryMuscles") or [], "secondary_muscles": s.get("secondaryMuscles") or [],
                "images": s.get("images") or [], "category": s.get("category"), "mechanic": s.get("mechanic")}

    library = []
    for sid, e in old.items():  # keeps equipment / level / bodyweight as already mapped to our labels
        if sid in curated:
            continue
        library.append({**e, "name": names[sid], "description": fix(ru[sid]["instructions_ru"]) or e.get("description"),
                        "equipment": gear(source[sid]["name"], e.get("equipment") or []), **extra(sid)})
    (HERE / "translated_exercises.json").write_text(json.dumps(library, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    for e in ours:  # our own exercises: muscles and photos from the same source when we know it, else from our muscle names
        if e.get("source_id") in source:
            e.update(extra(e["source_id"]))
        else:
            keys = list(dict.fromkeys(RU_MUSCLE[m] for m in e.get("muscle_groups", []) if m in RU_MUSCLE))
            e.update(primary_muscles=keys[:1], secondary_muscles=keys[1:], images=[])
    (HERE / "exercises.json").write_text(json.dumps(ours, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"library: {len(library)}, ours with source: {len(curated)}")


if __name__ == "__main__":
    main()
