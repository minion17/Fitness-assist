"""Picture cards for bot messages, drawn with Pillow in the Mini App's style and in the user's theme.

Each card shows the user's own numbers (calorie ring, water bar, streak), not stock art.
Rendered at 2x and downscaled for smooth edges; ~30 ms and ~40 KB per card.
"""
import io
import math
from datetime import date
from functools import lru_cache
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

FONTS = Path(__file__).parent / "assets" / "fonts"
W, H = 1200, 750
K = 2  # supersampling

THEMES = {
    "dark": dict(bg="#0e0f12", card="#17191d", text="#f2f3f5", muted="#9aa0a8", accent="#c8f169", on_accent="#0e0f12",
                 track="#24272c", water="#7cc4ff", water_soft="#1c2a36", streak="#ffb35c", glow=True,
                 protein="#7cc4ff", fat="#ffc56b", carbs="#b79cff"),
    "light": dict(bg="#f3f4f6", card="#ffffff", text="#121316", muted="#5f6670", accent="#9fd03a", on_accent="#121316",
                  track="#e3e5e9", water="#2f8fe0", water_soft="#e3f0fc", streak="#d9761e", glow=False,
                  protein="#2f8fe0", fat="#d98a1e", carbs="#8a6bea"),
    "green": dict(bg="#0e1510", card="#172019", text="#dde6de", muted="#8fa595", accent="#c3e04a", on_accent="#0e1510",
                  track="#2c4430", water="#7fb8e0", water_soft="#1e2c34", streak="#e6a64a", glow=False,
                  protein="#7fb8e0", fat="#e6b65a", carbs="#b9a3f0"),
}


# Same as frontend/src/theme.ts LIGHT: deeper versions of the dark theme's pastel accents for a light background.
LIGHT_ACCENTS = {
    "#c8f169": ("#8fc31f", "#4a6f00"), "#5ef2b0": ("#16b881", "#08704e"),
    "#a98bff": ("#8462f5", "#5a37d6"), "#ff8a5b": ("#f2692f", "#b4431a"),
}


def palette(theme: str | None, accent: str | None = None) -> dict:
    p = dict(THEMES.get(theme or "dark", THEMES["dark"]))
    if accent and (theme or "dark") == "dark":
        p["accent"] = accent
    p["accent_text"] = p["accent"]
    if theme == "light":
        p["accent"], p["accent_text"] = LIGHT_ACCENTS.get(accent or "", LIGHT_ACCENTS["#c8f169"])
    return p


@lru_cache(maxsize=32)
def font(name: str, size: int, weight: int) -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(FONTS / f"{name}.ttf"), size * K)
    f.set_variation_by_axes([weight])
    return f


def num(n: float) -> str:
    return f"{round(n):,}".replace(",", " ")


def liters(ml: float) -> str:
    return f"{ml / 1000:.2f}".rstrip("0").rstrip(".").replace(".", ",")


class Card:
    def __init__(self, theme: str | None, accent: str | None = None, glow=(920, 390, "accent"), size=(W, H)):
        self.p = palette(theme, accent)
        self.w, self.h = size
        self.img = Image.new("RGB", (self.w * K, self.h * K), self.p["bg"])
        if self.p["glow"] and glow:  # soft light behind the main element, dark theme only (as in the app)
            self.glow(glow[0], glow[1], 300, self.p[glow[2]], 70)
        self.d = ImageDraw.Draw(self.img)

    def glow(self, x: int, y: int, r: int, color: str, alpha: int) -> None:
        layer = Image.new("RGBA", self.img.size, (0, 0, 0, 0))
        ImageDraw.Draw(layer).ellipse([(x - r) * K, (y - r) * K, (x + r) * K, (y + r) * K], fill=color + f"{alpha:02x}")
        self.img.paste(layer.filter(ImageFilter.GaussianBlur(90 * K)), (0, 0), layer.filter(ImageFilter.GaussianBlur(90 * K)))

    def text(self, xy, s: str, size: int, color: str, weight: int = 600, family: str = "Manrope", anchor: str = "la") -> None:
        self.d.text((xy[0] * K, xy[1] * K), s, font=font(family, size, weight), fill=self.p.get(color, color), anchor=anchor)

    def width(self, s: str, size: int, weight: int = 600, family: str = "Manrope") -> float:
        return self.d.textlength(s, font=font(family, size, weight)) / K

    def rect(self, box, r: int, fill: str) -> None:
        self.d.rounded_rectangle([v * K for v in box], radius=r * K, fill=self.p.get(fill, fill))

    def ring(self, cx: int, cy: int, r: int, w: int, frac: float, color: str = "accent") -> None:
        box = [(cx - r) * K, (cy - r) * K, (cx + r) * K, (cy + r) * K]
        self.d.ellipse(box, outline=self.p["track"], width=w * K)
        frac = max(0.0, min(1.0, frac))
        if frac <= 0:
            return
        c = self.p.get(color, color)
        self.d.arc(box, -90, -90 + 360 * frac, fill=c, width=w * K)
        for a in (-90, -90 + 360 * frac):  # round caps
            x = cx + (r - w / 2) * math.cos(math.radians(a))
            y = cy + (r - w / 2) * math.sin(math.radians(a))
            self.d.ellipse([(x - w / 2) * K, (y - w / 2) * K, (x + w / 2) * K, (y + w / 2) * K], fill=c)

    def bar(self, box, frac: float, color: str, track: str = "track") -> None:
        x0, y0, x1, y1 = box
        r = (y1 - y0) // 2
        self.rect(box, r, track)
        if frac > 0:
            self.rect((x0, y0, x0 + max(y1 - y0, (x1 - x0) * min(1, frac)), y1), r, color)

    def brand(self, right: str = "") -> None:
        self.d.ellipse([64 * K, 62 * K, 84 * K, 82 * K], fill=self.p["accent"])
        self.text((98, 56), "Nextly", 26, "text", 700)
        if right:
            self.text((self.w - 64, 56), right, 24, "muted", 500, anchor="ra")

    def png(self) -> bytes:
        out = io.BytesIO()
        self.img.resize((self.w, self.h), Image.LANCZOS).save(out, "PNG", optimize=True)
        return out.getvalue()


@lru_cache(maxsize=8)
def welcome(theme: str | None = None, accent: str | None = None) -> bytes:
    """New user: how the bot is used, shown as a tiny dialog — a message and the bot's answer."""
    c = Card(theme, accent, glow=(870, 360, "accent"))
    c.brand()
    c.text((64, 170), "Напиши,", 64, "text", 700, "Unbounded")
    c.text((64, 250), "что ешь, —", 64, "text", 700, "Unbounded")
    c.text((64, 330), "остальное", 64, "accent_text", 700, "Unbounded")
    c.text((64, 410), "посчитаю я", 64, "accent_text", 700, "Unbounded")
    c.text((64, 560), "Калории, тренировки и вода —", 28, "muted", 500)
    c.text((64, 600), "прямо в Telegram", 28, "muted", 500)
    msg = "гречка 150 г, курица 120 г"
    w = c.width(msg, 26, 600) + 52
    c.rect((W - 64 - w, 150, W - 64, 214), 32, "accent")
    c.text((W - 64 - w + 26, 168), msg, 26, "on_accent", 600)
    x0, x1 = 640, W - 64
    c.rect((x0, 250, x1, 610), 36, "card")
    check(c, x0 + 52, 306, 22)
    c.text((x0 + 90, 290), "Записал в обед", 28, "text", 700)
    c.text((x0 + 36, 352), "365", 76, "text", 700, "Unbounded")
    c.text((x0 + 36 + c.width("365", 76, 700, "Unbounded") + 14, 392), "ккал", 26, "muted", 600)
    for j, (label, color, frac, g) in enumerate((("Белки", "protein", .62, "41 г"), ("Жиры", "fat", .3, "9 г"), ("Углеводы", "carbs", .5, "33 г"))):
        y = 474 + j * 42
        c.text((x0 + 36, y), label, 22, "muted", 600)
        c.text((x1 - 36, y), g, 22, "text", 700, anchor="ra")
        c.bar((x0 + 180, y + 8, x1 - 100, y + 20), frac, color)
    return c.png()


def today(title: str, accent_line: str, eaten: float, goal: float, chips: list[str], date: str,
          theme: str | None = None, accent: str | None = None) -> bytes:
    """Returning user: their real day — calories ring and what else matters today (water, streak, workout)."""
    over = goal and eaten > goal * 1.1
    c = Card(theme, accent, glow=(925, 360, "fat" if over else "accent"))
    c.brand(date)
    c.text((64, 200), title, 60, "text", 700, "Unbounded")
    c.text((64, 280), accent_line, 60, "accent_text", 700, "Unbounded")
    y, x = 470, 64
    for label in chips[:3]:
        w = c.width(label, 24, 700) + 44
        if x + w > 640:
            y, x = y + 66, 64
        c.rect((x, y, x + w, y + 54), 27, "card")
        c.text((x + 22, y + 14), label, 24, "text", 700)
        x += w + 12
    c.ring(925, 360, 190, 34, eaten / goal if goal else 0, "fat" if over else "accent")
    c.text((925, 330), num(eaten), 64, "text", 700, "Unbounded", anchor="mm")
    c.text((925, 400), f"из {num(goal)} ккал", 24, "muted", 600, anchor="mm")
    return c.png()


def meal(meal_name: str, eaten: float, goal: float, macros: dict[str, tuple[float, float]], theme=None, accent=None) -> bytes:
    """Reminder that a meal isn't logged, with today's calorie ring. macros: label -> (eaten, goal)."""
    c = Card(theme, accent)
    c.brand("Напоминание")
    c.text((64, 190), meal_name, 72, "text", 700, "Unbounded")
    c.text((64, 290), "ещё не записан", 40, "muted", 600)
    left = goal - eaten
    c.text((64, 410), "Осталось на сегодня" if left >= 0 else "Сверх нормы", 26, "muted", 600)
    c.text((64, 448), f"{num(abs(left))} ккал", 58, "accent" if left >= 0 else "fat", 700, "Unbounded")
    for i, ((label, (v, g)), color) in enumerate(zip(macros.items(), ("protein", "fat", "carbs"))):
        bx = 64 + i * 190
        c.text((bx, 580), label, 22, "muted", 600)
        c.text((bx, 610), f"{num(v)} / {num(g)} г", 24, "text", 700)
        c.bar((bx, 652, bx + 165, 664), v / g if g else 0, color)
    c.ring(920, 390, 200, 36, eaten / goal if goal else 0, "accent" if left >= 0 else "fat")
    c.text((920, 360), num(eaten), 70, "text", 700, "Unbounded", anchor="mm")
    c.text((920, 432), f"из {num(goal)} ккал", 26, "muted", 600, anchor="mm")
    return c.png()


def water(ml: int, goal: int, at: str, theme=None, accent=None) -> bytes:
    c = Card(theme, accent, glow=(220, 280, "water"))
    c.brand(f"Вода к {at}")
    c.text((64, 200), liters(ml), 120, "water", 700, "Unbounded")
    c.text((64 + c.width(liters(ml), 120, 700, "Unbounded") + 24, 268), f"из {liters(goal)} л", 44, "muted", 600)
    glasses = max(1, min(16, round(goal / 250)))
    filled = ml / 250
    gw, gap, x0, y0 = 50, 12, 64, 420
    for i in range(glasses):  # glasses, the last one filled partially
        x = x0 + i * (gw + gap)
        c.rect((x, y0, x + gw, y0 + 120), 14, "water_soft")
        part = max(0.0, min(1.0, filled - i))
        if part > 0:
            c.rect((x, y0 + 120 * (1 - part), x + gw, y0 + 120), 14, "water")
    left = max(0, goal - ml)
    c.text((64, 600), f"Осталось {liters(left)} л — примерно {math.ceil(left / 250)} стак." if left else "Норма на сегодня выполнена!",
           34, "text", 700)
    return c.png()


def streak(days: int, week: list[bool], theme=None, accent=None) -> bytes:
    """week: last 7 days oldest first, True if active; the last one is today."""
    c = Card(theme, accent, glow=(220, 330, "streak"))
    c.brand("Серия")
    n = str(days)
    c.text((64, 150), n, 230, "streak", 800, "Unbounded")
    c.text((64 + c.width(n, 230, 800, "Unbounded") + 28, 300), plural_days(days), 56, "text", 700, "Unbounded")
    c.text((64 + c.width(n, 230, 800, "Unbounded") + 28, 370), "подряд", 56, "text", 700, "Unbounded")
    c.text((64, 470), "Сегодня ничего не записано. Запиши еду,", 30, "muted", 600)
    c.text((64, 512), "воду или тренировку, иначе серия сгорит.", 30, "muted", 600)
    names = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    today = date.today().weekday()
    week = week[-7:]
    for i, on in enumerate(week):
        x, last = 64 + i * 96, i == len(week) - 1
        box = [x * K, 590 * K, (x + 60) * K, 650 * K]
        if on:
            c.d.ellipse(box, fill=c.p["streak"])
        else:
            c.d.ellipse(box, outline=c.p["streak"] if last else c.p["track"], width=(5 if last else 4) * K)
        c.text((x + 30, 668), names[(today - (len(week) - 1 - i)) % 7], 20, "text" if last else "muted", 700 if last else 600, anchor="ma")
    return c.png()


def weekly(days: list[dict], goal: float | None, streak_days: int, workouts: int, water_avg_ml: float,
           weight_delta: float | None, theme=None, accent=None) -> bytes:
    """Sunday summary. days: last 7 {date, kcal} oldest first."""
    c = Card(theme, accent, glow=(870, 360, "accent"))
    c.brand("Итоги недели")
    logged = [d for d in days if d["kcal"] > 0]
    in_norm = sum(1 for d in logged if goal and abs(d["kcal"] - goal) <= 0.1 * goal)
    avg = sum(d["kcal"] for d in logged) / len(logged) if logged else 0
    c.text((64, 150), f"{in_norm} из 7", 92, "accent", 700, "Unbounded")
    c.text((64, 262), "дней в норме калорий", 30, "muted", 600)
    tiles = [("В среднем", f"{num(avg)} ккал"), ("Вода", f"{liters(water_avg_ml)} л/день"),
             ("Тренировок", str(workouts)), ("Серия", f"{streak_days} дн.")]
    if weight_delta is not None:
        tiles[3] = ("Вес", f"{'+' if weight_delta > 0 else '−' if weight_delta < 0 else ''}{abs(weight_delta):.1f} кг".replace(".", ","))
    for i, (label, value) in enumerate(tiles):
        x, y = 64 + (i % 2) * 260, 340 + (i // 2) * 150
        c.rect((x, y, x + 240, y + 128), 22, "card")
        c.text((x + 22, y + 22), label, 22, "muted", 600)
        c.text((x + 22, y + 60), value, 34, "text", 700)
    # 7 bars with the goal line
    x0, y0, bw, gap, hmax = 640, 200, 54, 16, 360
    top = max([goal or 0] + [d["kcal"] for d in days]) * 1.1 or 1
    names = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"]
    for i, d in enumerate(days[-7:]):
        x = x0 + i * (bw + gap)
        h = hmax * d["kcal"] / top
        c.rect((x, y0, x + bw, y0 + hmax), 14, "track")
        if h > 0:
            ok = goal and abs(d["kcal"] - goal) <= 0.1 * goal
            c.rect((x, y0 + hmax - max(h, 28), x + bw, y0 + hmax), 14, "accent" if ok else "muted")
        wd = names[date.fromisoformat(d["date"]).weekday()]
        c.text((x + bw / 2, y0 + hmax + 22), wd, 22, "muted", 600, anchor="ma")
    if goal:
        gy = y0 + hmax - hmax * goal / top
        for x in range(x0 - 8, x0 + 7 * (bw + gap) - gap + 8, 18):  # dashed goal line
            c.d.line([x * K, gy * K, (x + 9) * K, gy * K], fill=c.p["text"], width=2 * K)
        c.text((x0 + 7 * (bw + gap) - gap + 8, gy - 34), "норма", 20, "text", 600, anchor="ra")
    return c.png()




def share(name: str, streak: int, week_xp: int, workouts: int, level: int, theme=None, accent=None) -> bytes:
    """"Моя неделя" card a user forwards to friends (with their invite link in the caption)."""
    c = Card(theme, accent, glow=(930, 380, "streak"))
    c.brand(right="неделя в Nextly")
    c.text((64, 170), name[:22], 34, "muted", 600)
    c.text((64, 220), "Моя неделя", 76, "text", 700, "Unbounded")
    c.text((64, 330), f"Уровень {level}", 30, "accent_text", 700)
    stats = ((num(week_xp), "XP за неделю", "accent"), (str(workouts), "тренировок", "text"))
    for i, (value, label, color) in enumerate(stats):
        x = 64 + i * 320
        c.rect((x, 430, x + 300, 610), 34, "card")
        c.text((x + 28, 455), value, 64, color, 700, "Unbounded")
        c.text((x + 28, 555), label, 24, "muted", 600)
    cx, cy = 930, 380
    c.ring(cx, cy, 175, 30, min(1, streak / 30), "streak")
    c.text((cx, cy - 25), str(streak), 96, "streak", 700, "Unbounded", anchor="mm")
    word = "день" if streak % 10 == 1 and streak % 100 != 11 else "дня" if streak % 10 in (2, 3, 4) and streak % 100 not in (12, 13, 14) else "дней"
    c.text((cx, cy + 55), f"{word} подряд", 26, "muted", 600, anchor="mm")
    return c.png()


# ---- Telegram Stories: 1080x1920; Telegram draws its own UI over the top and bottom ~250 px, so content sits between ----
SW, SH = 1080, 1920


def _story_base(theme, accent, glow) -> Card:
    c = Card(theme, accent, glow=None, size=(SW, SH))
    if c.p["glow"]:
        c.glow(glow[0], glow[1], 420, c.p[glow[2]], 80)
    c.d.ellipse([90 * K, 288 * K, 118 * K, 316 * K], fill=c.p["accent"])
    c.text((136, 280), "Nextly", 38, "text", 700)
    return c


def _footer(c: Card, bot: str) -> None:
    c.text((SW / 2, 1590), "Дневник, тренировки и дуэли с друзьями", 34, "muted", 600, anchor="ma")
    if bot:
        c.text((SW / 2, 1640), f"@{bot}", 38, "accent_text", 700, anchor="ma")


def plural_days(n: int) -> str:
    return "день" if n % 10 == 1 and n % 100 != 11 else "дня" if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14) else "дней"


def story_week(name: str, streak: int, week_xp: int, workouts: int, level: int, bot: str = "", theme=None, accent=None) -> bytes:
    c = _story_base(theme, accent, (540, 860, "streak"))
    c.text((90, 380), name[:24], 44, "muted", 600)
    c.text((90, 440), "Моя неделя", 92, "text", 700, "Unbounded")
    cx, cy = SW // 2, 860
    c.ring(cx, cy, 250, 44, min(1, streak / 30), "streak")
    c.text((cx, cy - 30), str(streak), 170, "streak", 700, "Unbounded", anchor="mm")
    c.text((cx, cy + 90), f"{plural_days(streak)} подряд", 40, "muted", 600, anchor="mm")
    for i, (value, label, color) in enumerate(((num(week_xp), "XP за неделю", "accent_text"), (str(workouts), "тренировок", "text"))):
        x = 90 + i * 460
        c.rect((x, 1190, x + 440, 1420), 44, "card")
        c.text((x + 40, 1222), value, 84, color, 700, "Unbounded")
        c.text((x + 40, 1350), label, 34, "muted", 600)
    c.text((SW / 2, 1470), f"Уровень {level}", 40, "accent_text", 700, anchor="ma")
    _footer(c, bot)
    return c.png()


def story_duel(name: str, rival: str, me: int, them: int, metric: str, days: int, rewarded: bool, bot: str = "",
               theme=None, accent=None) -> bytes:
    """A won duel. metric: "xp" or "workouts"."""
    c = _story_base(theme, accent, (540, 900, "accent"))
    c.text((90, 400), "Победа", 112, "text", 700, "Unbounded")
    c.text((90, 530), "в дуэли", 112, "accent_text", 700, "Unbounded")
    cx, cy = SW // 2, 930
    c.rect((90, 730, SW - 90, 1130), 56, "card")
    score = f"{num(me)} : {num(them)}"
    size = 150 if len(score) <= 9 else 110
    c.text((cx, cy - 40), score, size, "accent_text", 700, "Unbounded", anchor="mm")
    what = "XP" if metric == "xp" else "тренировок"
    c.text((cx, cy + 100), f"{what} за {days} {plural_days(days)}", 36, "muted", 600, anchor="mm")
    c.text((cx, 1210), f"{name[:18]}  vs  {rival[:18]}", 44, "text", 700, anchor="ma")
    if rewarded:
        label = "+40 XP и бустер ×1,5"
        w = c.width(label, 36, 700) + 72
        c.rect((cx - w / 2, 1300, cx + w / 2, 1384), 42, "accent")
        c.text((cx, 1342), label, 36, "on_accent", 700, anchor="mm")
    _footer(c, bot)
    return c.png()


def story_month(name: str, m: dict, bot: str = "", theme=None, accent=None) -> bytes:
    """The challenge of the month: days counted against the goal, the place among everyone. m: monthly.story_numbers."""
    c = _story_base(theme, accent, (540, 880, "accent"))
    c.text((90, 380), name[:24], 44, "muted", 600)
    c.text((90, 440), "Челлендж" if not m["final"] else "Итог месяца", 92, "text", 700, "Unbounded")
    c.text((90, 560), m["title"][:26], 46, "accent_text", 700)
    cx, cy = SW // 2, 900
    c.ring(cx, cy, 250, 44, min(1, m["score"] / m["goal"]), "accent")
    c.text((cx, cy - 30), str(m["score"]), 170, "accent_text", 700, "Unbounded", anchor="mm")
    c.text((cx, cy + 90), f"цель — {m['goal']} {plural_days(m['goal'])}", 40, "muted", 600, anchor="mm")
    place = f"{m['rank']}-е место"
    top = max(1, round(m["rank"] / m["total"] * 100)) if m["total"] else 100
    for i, (value, label) in enumerate(((place, f"из {m['total']} участников"), (f"топ-{top} %" if m["total"] >= 10 else "✓" if m["score"] >= m["goal"] else "в пути",
                                         "среди всех" if m["total"] >= 10 else "цель взята" if m["score"] >= m["goal"] else "до цели"))):
        x = 90 + i * 460
        c.rect((x, 1230, x + 440, 1450), 44, "card")
        c.text((x + 40, 1262), value, 60 if len(value) > 4 else 84, "text", 700, "Unbounded")
        c.text((x + 40, 1380), label, 34, "muted", 600)
    _footer(c, bot)
    return c.png()


# ---- Tour: the slides a new user flips with ← → on "Сначала покажи, что умеешь" (one message, 4:5) ----

TOUR = (
    ("Еда —", "за 5 секунд", "Напиши «гречка 150 г» или пришли фото тарелки"),
    ("Тренировки", "под тебя", "Программа по уровню и инвентарю, таймер отдыха и веса с прошлого раза"),
    ("Вода", "и привычки", "Мягкие напоминания и отметка в одно касание прямо из чата"),
    ("Соревнуйтесь", "всем чатом", "Добавь меня в чат друзей, семьи или офиса: рейтинг недели и чемпион"),
    ("Прогресс", "виден сразу", "Серии дней, вес, итоги недели и соревнования с друзьями"),
)
TW, TH = 1080, 1350


def wrap(c: Card, s: str, size: int, width: int, weight: int = 500) -> list[str]:
    lines, cur = [], ""
    for word in s.split():
        if cur and c.width(f"{cur} {word}", size, weight) > width:
            lines.append(cur)
            cur = word
        else:
            cur = f"{cur} {word}".strip()
    return lines + [cur] if cur else lines


def check(c: Card, cx: int, cy: int, r: int, color: str = "accent") -> None:
    """A filled circle with a check mark."""
    c.d.ellipse([(cx - r) * K, (cy - r) * K, (cx + r) * K, (cy + r) * K], fill=c.p.get(color, color))
    c.d.line([((cx - r * .45) * K, cy * K), ((cx - r * .1) * K, (cy + r * .35) * K), ((cx + r * .5) * K, (cy - r * .35) * K)],
             fill=c.p["on_accent"], width=max(3, r // 4) * K, joint="curve")


@lru_cache(maxsize=16)
def tour(i: int, theme: str | None = None, accent: str | None = None, dots: bool = True, text: bool = True) -> bytes:
    title, accent_line, sub = TOUR[i]
    c = Card(theme, accent, glow=(540, 470, ("accent", "accent", "water", "accent", "streak")[i]), size=(TW, TH))
    c.brand()
    cx, cy = 540, 480
    if i == 0:  # a message and the bot's answer
        msg = "гречка 150 г, курица 120 г"
        w = c.width(msg, 30, 600) + 64
        c.rect((TW - 90 - w, 190, TW - 90, 270), 40, "accent")
        c.text((TW - 90 - w + 32, 212), msg, 30, "on_accent", 600)
        c.rect((90, 310, TW - 190, 770), 44, "card")
        check(c, 150, 380, 26)
        c.text((196, 362), "Записал в обед", 32, "text", 700)
        c.text((130, 440), "365", 92, "text", 700, "Unbounded")
        c.text((130 + c.width("365", 92, 700, "Unbounded") + 18, 486), "ккал", 30, "muted", 600)
        for j, (label, color, frac, g) in enumerate((("Белки", "protein", .62, "41 г"), ("Жиры", "fat", .3, "9 г"), ("Углеводы", "carbs", .5, "33 г"))):
            y = 580 + j * 60
            c.text((130, y), label, 26, "muted", 600)
            c.text((TW - 230, y), g, 26, "text", 700, anchor="ra")
            c.bar((330, y + 10, TW - 340, y + 26), frac, color)
    elif i == 1:  # today's workout and the rest timer
        c.ring(cx, 380, 165, 26, .7)
        c.text((cx, 360), "01:30", 66, "text", 700, "Unbounded", anchor="mm")
        c.text((cx, 425), "отдых", 26, "muted", 600, anchor="mm")
        for j, (name, sets, done) in enumerate((("Жим ногами", "3 × 10", 3), ("Тяга в наклоне", "3 × 12", 1), ("Планка", "3 × 45 с", 0))):
            y = 590 + j * 78
            c.rect((110, y, TW - 110, y + 64), 32, "card")
            c.text((150, y + 17), name, 28, "text", 600)
            c.text((TW - 290, y + 17), sets, 28, "muted", 600, anchor="ra")
            for k in range(3):
                x = TW - 250 + k * 40
                c.d.ellipse([x * K, (y + 20) * K, (x + 24) * K, (y + 44) * K], fill=c.p["accent" if k < done else "track"])
    elif i == 2:  # a glass of water and two habits ticked from the chat
        gx = 330
        c.rect((gx - 120, 200, gx + 120, 700), 56, "water_soft")
        c.rect((gx - 120, 430, gx + 120, 700), 56, "water")
        c.rect((gx - 120, 430, gx + 120, 490), 0, "water")
        c.text((gx, 300), "+250", 54, "water", 700, "Unbounded", anchor="mm")
        c.text((gx, 360), "мл", 26, "muted", 600, anchor="mm")
        for j, (name, done) in enumerate((("Сон 8 часов", True), ("10 000 шагов", True), ("Без сладкого", False))):
            y = 260 + j * 150
            c.rect((520, y, TW - 90, y + 110), 55, "card")
            if done:
                check(c, 580, y + 55, 28)
            else:
                c.d.ellipse([552 * K, (y + 27) * K, 608 * K, (y + 83) * K], outline=c.p["track"], width=5 * K)
            c.text((630, y + 38), name, 28, "text", 600)
    elif i == 3:  # a group chat: the bot's weekly rating and a cheer
        c.rect((110, 190, TW - 110, 620), 44, "card")
        c.text((150, 222), "Семья · рейтинг недели", 30, "text", 700)
        for j, (who, xp, color) in enumerate((("Аня", "320 XP", "accent"), ("Борис", "290 XP", "water"), ("Вера", "180 XP", "streak"))):
            y = 300 + j * 100
            c.d.ellipse([150 * K, y * K, 214 * K, (y + 64) * K], fill=c.p[color])
            c.text((182, y + 32), str(j + 1), 30, "on_accent", 700, "Unbounded", anchor="mm")
            c.text((240, y + 14), who, 32, "text", 600)
            c.text((TW - 150, y + 14), xp, 32, "accent_text" if j == 0 else "muted", 700, anchor="ra")
        msg = "Аня закончила тренировку — 3-я за неделю. Кто следующий?"
        c.rect((110, 660, TW - 110, 800), 40, "accent")
        for j, line in enumerate(wrap(c, msg, 30, TW - 300)):
            c.text((150, 686 + j * 42), line, 30, "on_accent", 600)
    else:  # a streak and a weight line going down
        c.text((cx, 250), "12", 150, "streak", 700, "Unbounded", anchor="mm")
        c.text((cx, 350), "дней подряд", 30, "muted", 600, anchor="mm")
        for k in range(7):
            x = cx - 7 * 32 + k * 64 + 10
            c.rect((x, 400, x + 44, 444), 22, "streak" if k < 6 else "track")
        c.rect((110, 500, TW - 110, 780), 40, "card")
        c.text((150, 530), "Вес", 26, "muted", 600)
        c.text((TW - 150, 530), "−2,4 кг", 28, "accent_text", 700, anchor="ra")
        pts = [(160 + k * 108, 600 + v) for k, v in enumerate((20, 34, 28, 52, 70, 64, 92, 110))]
        c.d.line([(x * K, y * K) for x, y in pts], fill=c.p["accent"], width=7 * K, joint="curve")
        x, y = pts[-1]
        c.d.ellipse([(x - 12) * K, (y - 12) * K, (x + 12) * K, (y + 12) * K], fill=c.p["accent"])
    if not text:
        return c.png()
    c.text((90, 940), title, 72, "text", 700, "Unbounded")
    c.text((90, 1028), accent_line, 72, "accent_text", 700, "Unbounded")
    for j, line in enumerate(wrap(c, sub, 34, TW - 180)):
        c.text((90, 1166 + j * 48), line, 34, "muted", 500)
    for k in range(len(TOUR) if dots else 0):  # page dots, as in a carousel: the current one is a wide pill
        w = 44 if k == i else 14
        x = TW / 2 - (len(TOUR) * 14 + 30 + (len(TOUR) - 1) * 12) / 2 + sum((44 if j == i else 14) + 12 for j in range(k))
        c.rect((x, 1296, x + w, 1310), 7, "accent" if k == i else "track")
    return c.png()


@lru_cache(maxsize=16)
def tour_square(i: int, theme: str | None = None, accent: str | None = None) -> bytes:
    """1:1 version for the channel carousel (Telegram shows a carousel about square and crops taller pictures):
    the tall slide's picture, scaled down, above the same title and text."""
    title, accent_line, sub = TOUR[i]
    tall = Image.open(io.BytesIO(_tour_art(i, theme, accent)))
    band = tall.crop((0, 150, TW, 850)).resize((round(TW * .8), round(700 * .8)), Image.LANCZOS)
    c = Card(theme, accent, glow=None, size=(TW, TW))
    mask = Image.new("L", band.size, 255)  # fade the band's top and bottom edges into the background
    fade = 24
    for y in range(fade):
        ImageDraw.Draw(mask).line([(0, y), (band.width, y)], fill=round(255 * y / fade))
        ImageDraw.Draw(mask).line([(0, band.height - 1 - y), (band.width, band.height - 1 - y)], fill=round(255 * y / fade))
    c.img.paste(band.resize((band.width * K, band.height * K), Image.LANCZOS), (round(TW * .1) * K, 100 * K),
                mask.resize((band.width * K, band.height * K)))
    c.d = ImageDraw.Draw(c.img)
    c.brand()
    c.text((90, 700), title, 64, "text", 700, "Unbounded")
    c.text((90, 778), accent_line, 64, "accent_text", 700, "Unbounded")
    for j, line in enumerate(wrap(c, sub, 32, TW - 180)):
        c.text((90, 900 + j * 44), line, 32, "muted", 500)
    return c.png()


def _tour_art(i: int, theme, accent) -> bytes:
    return tour(i, theme, accent, dots=False, text=False)
