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
    def __init__(self, theme: str | None, accent: str | None = None, glow=(920, 390, "accent")):
        self.p = palette(theme, accent)
        self.img = Image.new("RGB", (W * K, H * K), self.p["bg"])
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
        self.text((98, 56), "Setly", 26, "text", 700)
        if right:
            self.text((W - 64, 56), right, 24, "muted", 500, anchor="ra")

    def png(self) -> bytes:
        out = io.BytesIO()
        self.img.resize((W, H), Image.LANCZOS).save(out, "PNG", optimize=True)
        return out.getvalue()


@lru_cache(maxsize=8)
def welcome(theme: str | None = None, accent: str | None = None) -> bytes:
    c = Card(theme, accent, glow=(925, 330, "accent"))
    c.brand()
    c.text((64, 170), "Питание,", 66, "text", 700, "Unbounded")
    c.text((64, 252), "тренировки", 66, "text", 700, "Unbounded")
    c.text((64, 334), "и вода —", 66, "text", 700, "Unbounded")
    c.text((64, 416), "в одном месте", 66, "accent_text", 700, "Unbounded")
    y = 548
    x = 64
    for label in ("Сканер штрихкодов", "Еда по фото с AI", "Напоминания"):
        w = c.width(label, 24, 700) + 44
        c.rect((x, y, x + w, y + 54), 27, "card")
        c.text((x + 22, y + 14), label, 24, "text", 700)
        x += w + 12
    c.text((64, 640), "Норма КБЖУ под вашу цель за 2 минуты", 26, "muted", 500)
    c.ring(925, 330, 190, 34, 0.72)
    c.text((925, 300), "1 712", 64, "text", 700, "Unbounded", anchor="mm")
    c.text((925, 370), "из 2 375 ккал", 24, "muted", 600, anchor="mm")
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
    c.text((64 + c.width(n, 230, 800, "Unbounded") + 28, 300), "дней", 56, "text", 700, "Unbounded")
    c.text((64 + c.width(n, 230, 800, "Unbounded") + 28, 370), "подряд", 56, "text", 700, "Unbounded")
    c.text((64, 470), "Сегодня ещё ничего не записано — запишите еду,", 30, "muted", 600)
    c.text((64, 512), "воду или тренировку, и серия продолжится.", 30, "muted", 600)
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


# Returning users get one of several welcomes (text in bot/main.py BACK); each has its own picture.
BACK_KINDS = ("ring", "streak", "water", "workout", "food", "comeback")


@lru_cache(maxsize=32)
def welcome_back(kind: str, theme: str | None = None, accent: str | None = None) -> bytes:
    title, accent_line, art = {
        "ring": ("Снова здесь —", "продолжаем", "ring"),
        "streak": ("Серия", "ждёт тебя", "streak"),
        "water": ("Стакан воды —", "лучший старт", "water"),
        "workout": ("Тренировка", "уже в плане", "workout"),
        "food": ("Сфоткай —", "посчитаю сам", "food"),
        "comeback": ("Вернулся —", "уже молодец", "comeback"),
    }[kind]
    c = Card(theme, accent, glow=(925, 390, "water" if art == "water" else "streak" if art == "streak" else "accent"))
    c.brand()
    c.text((64, 300), title, 58, "text", 700, "Unbounded")
    c.text((64, 378), accent_line, 58, "accent_text", 700, "Unbounded")
    c.text((64, 640), "Дневник, тренировки и вода — всё на месте", 26, "muted", 500)
    cx, cy = 925, 390
    if art == "ring":
        c.ring(cx, cy, 170, 32, 0.62)
        c.text((cx, cy - 18), "сегодня", 44, "text", 700, "Unbounded", anchor="mm")
        c.text((cx, cy + 38), "новый день", 24, "muted", 600, anchor="mm")
    elif art == "streak":
        for i, on in enumerate((1, 1, 1, 1, 1, 0, 0)):
            x = 760 + i * 56
            c.rect((x, cy + 70, x + 44, cy + 114), 22, "streak" if on else "track")
        c.text((cx, cy - 60), "+1", 130, "streak", 700, "Unbounded", anchor="mm")
        c.text((cx, cy + 30), "день к серии", 26, "muted", 600, anchor="mm")
    elif art == "water":
        c.rect((cx - 95, cy - 190, cx + 95, cy + 190), 46, "water_soft")
        c.rect((cx - 95, cy + 10, cx + 95, cy + 190), 46, "water")
        c.rect((cx - 95, cy + 10, cx + 95, cy + 60), 0, "water")
        c.text((cx, cy - 90), "+250", 48, "water", 700, "Unbounded", anchor="mm")
        c.text((cx, cy - 40), "мл", 24, "muted", 600, anchor="mm")
    elif art == "workout":
        for i, h in enumerate((120, 165, 150, 210, 255)):
            x = 770 + i * 64
            c.rect((x, cy + 150 - h, x + 44, cy + 150), 14, "accent" if i == 4 else "track")
        c.text((cx, cy - 190), "+2,5 кг", 38, "text", 700, "Unbounded", anchor="mm")
    elif art == "food":
        c.rect((cx - 190, cy - 170, cx + 190, cy + 170), 40, "card")
        for i, (label, color, frac) in enumerate((("Белки", "protein", .7), ("Жиры", "fat", .45), ("Углеводы", "carbs", .6))):
            y = cy - 110 + i * 85
            c.text((cx - 150, y), label, 24, "muted", 600)
            c.bar((cx - 150, y + 38, cx + 150, y + 54), frac, color)
    else:  # comeback: a big check mark in a ring
        c.ring(cx, cy, 160, 30, 1)
        c.d.line([((cx - 70) * K, (cy + 5) * K), ((cx - 15) * K, (cy + 60) * K), ((cx + 80) * K, (cy - 55) * K)],
                 fill=c.p["accent"], width=30 * K, joint="curve")
    return c.png()
