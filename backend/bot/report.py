"""A PDF report for a coach or a doctor: nutrition, weight and measurements, workouts over a period.

Drawn with Pillow (already used for the bot's cards) and saved as a PDF: no extra dependency. White A4 pages at 150 dpi.
"""
import re
import unicodedata
from datetime import date
from functools import lru_cache
from io import BytesIO

from PIL import Image, ImageDraw, ImageFont

from backend.bot.cards import FONTS

W, H = 1240, 1754  # A4 at 150 dpi
M = 90  # margin
INK, MUTED, LINE, ACCENT, SOFT, WARN = "#14161a", "#6b7280", "#e5e7eb", "#5b8c1a", "#eef6e3", "#d97706"


@lru_cache(maxsize=32)
def font(size: int, weight: int = 500, name: str = "Manrope") -> ImageFont.FreeTypeFont:
    f = ImageFont.truetype(str(FONTS / f"{name}.ttf"), size)
    f.set_variation_by_axes([weight])
    return f


def n(x: float, digits: int = 0) -> str:
    s = f"{x:,.{digits}f}".replace(",", " ").replace(".", ",")
    return s


def printable(s: str) -> str:
    """Only what the font can draw: letters, digits, spaces and simple punctuation (no emoji in Telegram names)."""
    s = "".join(c for c in s if unicodedata.category(c) not in ("So", "Sk", "Cs", "Co", "Cf") and not 0xFE00 <= ord(c) <= 0xFE0F)
    return re.sub(r"\s+", " ", s).strip()


def cut(s: str, size: int, width: int) -> str:
    """Shorten to fit `width` px, ending with "…" at a word boundary when possible."""
    f = font(size)
    if f.getlength(s) <= width:
        return s
    while s and f.getlength(s + "…") > width:
        s = s[:-1]
    return (s.rsplit(" ", 1)[0] if " " in s[-12:] else s).rstrip(" ·,") + "…"


def d(x: date) -> str:
    return x.strftime("%d.%m.%Y")


class Page:
    def __init__(self):
        self.img = Image.new("RGB", (W, H), "white")
        self.dr = ImageDraw.Draw(self.img)
        self.y = M

    def text(self, xy, s, size=26, color=INK, weight=500, anchor="la", name="Manrope"):
        self.dr.text(xy, s, font=font(size, weight, name), fill=color, anchor=anchor)

    def h2(self, s: str):
        self.y += 24
        self.text((M, self.y), s, 34, INK, 700, name="Unbounded")
        self.y += 58

    def kv(self, rows: list[tuple[str, str]], cols: int = 2):
        """Label / value tiles in a grid."""
        cw = (W - 2 * M - (cols - 1) * 20) // cols
        for i, (k, v) in enumerate(rows):
            x, y = M + (i % cols) * (cw + 20), self.y + (i // cols) * 118
            self.dr.rounded_rectangle([x, y, x + cw, y + 100], 18, fill="#f6f7f9")
            self.text((x + 24, y + 18), k, 22, MUTED, 600)
            self.text((x + 24, y + 50), v, 34, INK, 700)
        self.y += ((len(rows) + cols - 1) // cols) * 118 + 4

    def bars(self, values: list[float], norm: float | None, height: int = 220, label: str = ""):
        """Daily bars with the norm as a dashed line; empty days are gaps."""
        x0, x1, top, bottom = M + 70, W - M, self.y, self.y + height
        hi = max([*values, (norm or 0) * 1.15, 1])
        step = (x1 - x0) / max(len(values), 1)
        bar = min(step * 0.64, 44)  # a week of data: slim bars, not blobs
        for i, v in enumerate(values):
            if v <= 0:
                continue
            h = max((bottom - top) * v / hi, 6)
            over = norm and v > norm * 1.1
            cx = x0 + (i + 0.5) * step
            self.dr.rounded_rectangle([cx - bar / 2, bottom - h, cx + bar / 2, bottom], int(min(bar / 2, 8)), fill=WARN if over else ACCENT)
        if norm:
            y = bottom - (bottom - top) * norm / hi
            for x in range(x0, x1, 18):
                self.dr.line([x, y, min(x + 9, x1), y], fill=MUTED, width=2)
            self.text((M, y), n(norm), 20, MUTED, 600, anchor="lm")
        self.dr.line([x0, bottom, x1, bottom], fill=LINE, width=2)
        if label:
            self.text((x1, bottom + 12), label, 20, MUTED, 500, anchor="ra")
        self.y = bottom + 50

    def line_chart(self, points: list[tuple[int, float]], span: int, height: int = 200):
        """Weight over the period: x is the day number."""
        x0, x1, top, bottom = M + 70, W - M, self.y, self.y + height
        lo, hi = min(v for _, v in points), max(v for _, v in points)
        if hi - lo < 1:
            lo, hi = lo - 0.5, hi + 0.5
        xy = [(x0 + (x1 - x0) * dx / max(span - 1, 1), bottom - (bottom - top) * (v - lo) / (hi - lo)) for dx, v in points]
        if len(xy) > 1:
            self.dr.line(xy, fill=ACCENT, width=5, joint="curve")
        for x, y in xy:
            self.dr.ellipse([x - 7, y - 7, x + 7, y + 7], fill=ACCENT)
        self.text((M, top), n(hi, 1), 20, MUTED, 600, anchor="lt")
        self.text((M, bottom), n(lo, 1), 20, MUTED, 600, anchor="lb")
        self.dr.line([x0, bottom, x1, bottom], fill=LINE, width=2)
        self.y = bottom + 40

    def table(self, head: list[str], rows: list[list[str]], widths: list[float]):
        xs = [M]
        for w in widths[:-1]:
            xs.append(xs[-1] + int((W - 2 * M) * w))
        for x, h in zip(xs, head):
            self.text((x, self.y), h, 22, MUTED, 600)
        self.y += 40
        for r in rows:
            self.dr.line([M, self.y - 8, W - M, self.y - 8], fill=LINE, width=1)
            for x, v in zip(xs, r):
                self.text((x, self.y), v, 24, INK, 500)
            self.y += 44


def render(data: dict) -> bytes:
    """data: see backend.api.report.gather."""
    since, until = data["since"], data["until"]
    p = Page()
    p.text((M, p.y), "Setly", 30, ACCENT, 700, name="Unbounded")
    p.text((W - M, p.y + 4), f"{d(since)} — {d(until)}", 24, MUTED, 600, anchor="ra")
    p.y += 70
    who = printable(data["name"])
    p.text((M, p.y), f"Отчёт: {who}" if who else "Отчёт о прогрессе", 46, INK, 700, name="Unbounded")
    p.y += 76
    prof = data.get("profile")
    if prof:
        p.text((M, p.y), f"Цель: {prof['goal']} · рост {prof['height']} см · норма {n(prof['kcal'])} ккал, "
                         f"Б {prof['protein']} · Ж {prof['fat']} · У {prof['carbs']} г", 24, MUTED, 500)
        p.y += 50

    nut = data["nutrition"]
    p.h2("Питание")
    if nut["days"]:
        p.kv([("Дней с дневником", f"{nut['days']} из {data['span']}"), ("В норме (±10%)", f"{nut['in_norm']} дн."),
              ("Калории в среднем", f"{n(nut['kcal'])} ккал"), ("Белки · жиры · углеводы", f"{n(nut['protein'])} · {n(nut['fat'])} · {n(nut['carbs'])} г")])
        p.bars(nut["daily"], prof["kcal"] if prof else None, label="калории по дням")
    else:
        p.text((M, p.y), "Дневник за период не вёлся.", 26, MUTED)
        p.y += 50

    body = data["body"]
    p.h2("Вес и замеры")
    if body["points"]:
        first, last = body["first"], body["last"]
        rows = [("Вес", f"{n(first['weight_kg'], 1)} → {n(last['weight_kg'], 1)} кг" if first.get("weight_kg") and last.get("weight_kg") else "—")]
        for key, label in (("waist_cm", "Талия"), ("hips_cm", "Бёдра"), ("chest_cm", "Грудь"), ("body_fat_pct", "Жир, %")):
            if first.get(key) and last.get(key):
                rows.append((label, f"{n(first[key], 1)} → {n(last[key], 1)}"))
        p.kv(rows[:4])
        if len(body["points"]) > 1:
            p.line_chart(body["points"], data["span"])
    else:
        p.text((M, p.y), "Взвешиваний за период нет.", 26, MUTED)
        p.y += 50

    pages = [p]
    w = data["workouts"]
    need = 200 + (118 + 40 + 44 * min(len(w["sessions"]), 14) if w["sessions"] else 0)  # height of the section
    q = Page() if p.y + need > H - 110 else p
    if q is not p:
        pages.append(q)
    q.h2("Тренировки")
    if w["sessions"]:
        q.kv([("Тренировок", str(len(w["sessions"]))), ("Подходов всего", str(w["sets"]))])
        q.table(["Дата", "Тренировка", "Подходов"], [[d(s["date"]), cut(printable(s["title"]), 24, int((W - 2 * M) * 0.6)), str(s["sets"])] for s in w["sessions"][:14]], [0.2, 0.62, 0.18])
    else:
        q.text((M, q.y), "Тренировок за период не было.", 26, MUTED)
        q.y += 50
    q.y += 20
    q.text((M, q.y), f"Вода в среднем: {n(data['water_ml'] / 1000, 1)} л в день" if data["water_ml"] else "", 24, MUTED)
    for pg in pages:
        pg.text((M, H - 60), "Сформировано в Setly по данным пользователя. Не является медицинским заключением.", 20, MUTED)
    out = BytesIO()
    imgs = [pg.img for pg in pages]
    imgs[0].save(out, "PDF", resolution=150, save_all=True, append_images=imgs[1:])
    return out.getvalue()
