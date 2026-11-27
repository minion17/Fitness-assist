"""The report for a doctor, a dietitian or a coach: who, the anthropometry with its reference ranges, the energy norms
and where they come from, what was actually eaten (averages, the daily table, the itemised diary of the last two
weeks), activity, water and sleep — then how it was all measured.

A vector PDF (fpdf2): text stays selectable and sharp when printed, the tables run over pages with their headings.
"""
import re
import unicodedata
from datetime import date
from pathlib import Path

from fpdf import FPDF, FontFace

STATIC = Path(__file__).parent / "assets" / "fonts" / "static"
INK, MUTED, LINE, ACCENT, SOFT, WARN, TILE = (20, 22, 26), (107, 114, 128), (229, 231, 235), (91, 140, 26), (243, 247, 236), (180, 83, 9), (246, 247, 249)
WEEKDAYS = ("Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс")


def n(x: float | None, digits: int = 0) -> str:
    if x is None:
        return "—"
    return f"{x:,.{digits}f}".replace(",", " ").replace(".", ",")


def printable(s: str) -> str:
    """Only what the font can draw: letters, digits, spaces and simple punctuation (no emoji in Telegram names)."""
    s = "".join(c for c in s if unicodedata.category(c) not in ("So", "Sk", "Cs", "Co", "Cf") and not 0xFE00 <= ord(c) <= 0xFE0F)
    return re.sub(r"\s+", " ", s).strip()


def d(x: date) -> str:
    return x.strftime("%d.%m.%Y")


def delta(a: float | None, b: float | None, digits: int = 1) -> str:
    if a is None or b is None:
        return "—"
    v = round(b - a, digits)
    return ("+" if v > 0 else "−" if v < 0 else "") + n(abs(v), digits)


def bmi_class(v: float | None) -> str:
    """WHO categories."""
    if v is None:
        return ""
    return ("дефицит массы" if v < 18.5 else "норма" if v < 25 else "избыточная масса" if v < 30 else
            "ожирение I ст." if v < 35 else "ожирение II ст." if v < 40 else "ожирение III ст.")


class Report(FPDF):
    def __init__(self, data: dict):
        super().__init__(format="A4", unit="mm")
        self.data = data
        for style, file in (("", "Regular"), ("B", "Bold"), ("I", "SemiBold")):  # "I" is the semibold weight, not italic
            self.add_font("Manrope", style, str(STATIC / f"Manrope-{file}.ttf"))
        self.set_font("Manrope", "", 10)
        self.set_margins(16, 18, 16)
        self.set_auto_page_break(True, 18)
        self.alias_nb_pages()
        self.set_title(f"Отчёт Nextly {d(data['since'])}–{d(data['until'])}")
        self.set_creator("Nextly")

    def header(self):
        if self.page_no() == 1:
            return
        self.set_font("Manrope", "I", 8)
        self.set_text_color(*MUTED)
        self.cell(0, 5, f"Nextly · {self.who()} · {d(self.data['since'])} — {d(self.data['until'])}", new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(*LINE)
        self.line(self.l_margin, self.get_y() + 1, self.w - self.r_margin, self.get_y() + 1)
        self.ln(5)

    def footer(self):
        self.set_y(-12)
        self.set_font("Manrope", "", 7.5)
        self.set_text_color(*MUTED)
        self.cell(0, 4, "Данные внесены пользователем в приложение Nextly. Не является медицинским заключением.")
        self.cell(0, 4, f"стр. {self.page_no()} из {{nb}}", align="R")

    def who(self) -> str:
        return printable(self.data["name"]) or "пользователь"

    # --- building blocks
    def h1(self, text: str):
        self.set_font("Manrope", "B", 18)
        self.set_text_color(*INK)
        self.multi_cell(0, 8, text, new_x="LMARGIN", new_y="NEXT")

    def h2(self, text: str, need: float = 40):
        if self.get_y() + need > self.page_break_trigger:
            self.add_page()
        self.ln(4)
        self.set_font("Manrope", "B", 12.5)
        self.set_text_color(*INK)
        self.cell(0, 7, text, new_x="LMARGIN", new_y="NEXT")
        self.set_draw_color(*ACCENT)
        self.set_line_width(0.6)
        self.line(self.l_margin, self.get_y(), self.l_margin + 14, self.get_y())
        self.set_line_width(0.2)
        self.ln(3)

    def para(self, text: str, size: float = 9, color=MUTED):
        self.set_font("Manrope", "", size)
        self.set_text_color(*color)
        self.multi_cell(0, size * 0.48, text, align="L", new_x="LMARGIN", new_y="NEXT")
        self.ln(1)

    def caption(self, text: str, need: float = 45):
        """A small heading above a chart or a table: moves to the next page together with what follows."""
        if self.get_y() + need > self.page_break_trigger:
            self.add_page()
        self.ln(1)
        self.set_font("Manrope", "I", 8.5)
        self.set_text_color(*INK)
        self.cell(0, 5, text, new_x="LMARGIN", new_y="NEXT")

    def facts(self, rows: list[tuple[str, str]]):
        """Label — value pairs in two columns."""
        rows = [(k, v) for k, v in rows if v]
        half = (self.w - self.l_margin - self.r_margin) / 2
        for i in range(0, len(rows), 2):
            y = self.get_y()
            for j, (k, v) in enumerate(rows[i:i + 2]):
                self.set_xy(self.l_margin + j * half, y)
                self.set_font("Manrope", "", 8)
                self.set_text_color(*MUTED)
                self.cell(34, 5.5, k)
                self.set_font("Manrope", "I", 9)
                self.set_text_color(*INK)
                self.multi_cell(half - 36, 5.5, v, new_x="RIGHT", new_y="TOP")
            self.set_y(y + 6.2)

    def tiles(self, items: list[tuple[str, str, str]], cols: int = 4):
        """Key numbers: label, value, a small note."""
        gap = 3
        w = (self.w - self.l_margin - self.r_margin - gap * (cols - 1)) / cols
        for i in range(0, len(items), cols):
            if self.get_y() + 21 > self.page_break_trigger:
                self.add_page()
            y = self.get_y()
            for j, (label, value, note) in enumerate(items[i:i + cols]):
                x = self.l_margin + j * (w + gap)
                self.set_fill_color(*TILE)
                self.rect(x, y, w, 19, style="F", round_corners=True, corner_radius=2.5)
                self.set_xy(x + 3, y + 2.2)
                self.set_font("Manrope", "", 7.5)
                self.set_text_color(*MUTED)
                self.cell(w - 6, 4, label)
                self.set_xy(x + 3, y + 6.6)
                self.set_font("Manrope", "B", 12)
                self.set_text_color(*INK)
                self.cell(w - 6, 6, value)
                self.set_xy(x + 3, y + 13.2)
                self.set_font("Manrope", "", 7)
                self.set_text_color(*MUTED)
                self.cell(w - 6, 4, note)
            self.set_y(y + 19 + gap)

    def grid(self, head: list[str], rows: list[list[str]], widths: list[float], align: str = None, size: float = 8.5):
        """A table that runs over pages, repeating its heading. align: one letter per column (L / R / C)."""
        self.set_font("Manrope", "", size)
        self.set_text_color(*INK)
        self.set_draw_color(*LINE)
        self.set_fill_color(255, 255, 255)  # charts and tiles leave their colour behind
        style = FontFace(emphasis="ITALICS", color=MUTED, fill_color=SOFT, size_pt=size - 0.5)
        aligns = list(align or "L" * len(head))
        with self.table(col_widths=widths, text_align=aligns, borders_layout="HORIZONTAL_LINES", headings_style=style,
                        line_height=size * 0.55, padding=(1.4, 1.6), width=self.w - self.l_margin - self.r_margin) as t:
            for r in [head, *rows]:
                row = t.row()
                for v in r:
                    row.cell(v)
        self.ln(2)

    def bars(self, values: list[float], norm: float | None, height: float = 38):
        """Daily calories, the norm dashed; over +10 % in amber; empty days stay gaps."""
        if self.get_y() + height + 10 > self.page_break_trigger:
            self.add_page()
        x0, x1, top = self.l_margin + 12, self.w - self.r_margin, self.get_y() + 2
        bottom = top + height
        hi = max([*values, (norm or 0) * 1.15, 1])
        step = (x1 - x0) / max(len(values), 1)
        bar = min(step * 0.66, 6)
        for i, v in enumerate(values):
            if v <= 0:
                continue
            h = max(height * v / hi, 0.8)
            self.set_fill_color(*(WARN if norm and v > norm * 1.1 else ACCENT))
            self.rect(x0 + (i + 0.5) * step - bar / 2, bottom - h, bar, h, style="F")
        self.set_draw_color(*LINE)
        self.line(x0, bottom, x1, bottom)
        self.set_font("Manrope", "", 6.5)
        self.set_text_color(*MUTED)
        if norm:
            y = bottom - height * norm / hi
            self.set_draw_color(*MUTED)
            self.set_dash_pattern(dash=1.2, gap=1)
            self.line(x0, y, x1, y)
            self.set_dash_pattern()
            self.set_xy(self.l_margin - 1, y - 2)
            self.cell(12, 4, n(norm), align="R")
        since = self.data["since"]
        from datetime import timedelta
        for i in range(0, len(values), max(1, len(values) // 6)):  # a few dates under the axis
            self.set_xy(x0 + i * step - 6, bottom + 1)
            self.cell(14, 3.5, (since + timedelta(days=i)).strftime("%d.%m"), align="C")
        self.set_y(bottom + 7)

    def weight_chart(self, points: list[tuple[int, float]], span: int, height: float = 34):
        if self.get_y() + height + 10 > self.page_break_trigger:
            self.add_page()
        x0, x1, top = self.l_margin + 12, self.w - self.r_margin, self.get_y() + 2
        bottom = top + height
        lo, hi = min(v for _, v in points), max(v for _, v in points)
        if hi - lo < 1:
            lo, hi = lo - 0.5, hi + 0.5
        xy = [(x0 + (x1 - x0) * dx / max(span - 1, 1), bottom - height * (v - lo) / (hi - lo)) for dx, v in points]
        self.set_draw_color(*LINE)
        self.line(x0, bottom, x1, bottom)
        self.set_draw_color(*ACCENT)
        self.set_line_width(0.7)
        for a, b in zip(xy, xy[1:]):
            self.line(*a, *b)
        self.set_line_width(0.2)
        self.set_fill_color(*ACCENT)
        for x, y in xy:
            self.ellipse(x - 0.9, y - 0.9, 1.8, 1.8, style="F")
        self.set_font("Manrope", "", 6.5)
        self.set_text_color(*MUTED)
        self.set_xy(self.l_margin - 1, top - 2)
        self.cell(12, 4, n(hi, 1), align="R")
        self.set_xy(self.l_margin - 1, bottom - 2)
        self.cell(12, 4, n(lo, 1), align="R")
        self.set_y(bottom + 5)


def render(data: dict) -> bytes:
    """data: see backend.api.report.gather."""
    pdf = Report(data)
    pdf.add_page()
    person, norms, nut, body, w = data.get("person"), data.get("norms"), data["nutrition"], data["body"], data["workouts"]
    first, last = body.get("first", {}), body.get("last", {})

    # --- title
    pdf.set_font("Manrope", "B", 10)
    pdf.set_text_color(*ACCENT)
    pdf.cell(0, 5, "SETLY", new_x="LMARGIN", new_y="NEXT")
    pdf.ln(1)
    pdf.h1("Отчёт о питании, массе тела и физической активности")
    pdf.set_font("Manrope", "I", 10.5)
    pdf.set_text_color(*INK)
    pdf.cell(0, 6, pdf.who(), new_x="LMARGIN", new_y="NEXT")
    pdf.set_font("Manrope", "", 8.5)
    pdf.set_text_color(*MUTED)
    pdf.cell(0, 5, f"Период: {d(data['since'])} — {d(data['until'])} ({data['span']} дн.) · сформирован {d(date.today())}",
             new_x="LMARGIN", new_y="NEXT")
    pdf.ln(3)

    if person:
        pdf.h2("Пациент", need=30)
        tw = person.get("target_weight")
        pdf.facts([("Пол", person["sex"]), ("Возраст", f"{person['age']} лет (по году рождения)"), ("Рост", f"{person['height']} см"),
                   ("Цель", person["goal"]), ("Целевая масса", tw and f"{n(tw, 1)} кг"), ("Активность", person["activity"]),
                   ("Тренировки по плану", person.get("training_days") and f"{person['training_days']} раз в неделю"),
                   ("Аллергии", person.get("allergies")), ("Травмы, ограничения", person.get("injury")),
                   ("Интервальное голодание", person.get("fasting"))])

    # --- key numbers
    pdf.h2("Ключевые показатели", need=50)
    kcal_note = f"норма {n(norms['calories'])}" if norms else ""
    sleep = data.get("wellbeing")
    pdf.tiles([
        ("Масса тела", f"{n(last.get('weight_kg'), 1)} кг" if last.get("weight_kg") else "—",
         f"за период {delta(first.get('weight_kg'), last.get('weight_kg'))} кг" if first.get("weight_kg") else "нет взвешиваний"),
        ("ИМТ", n(last.get("bmi"), 1), bmi_class(last.get("bmi"))),
        ("Энергия, среднее", f"{n(nut['kcal'])} ккал" if nut["days"] else "—", kcal_note),
        ("Белок", f"{n(nut['protein_per_kg'], 1)} г/кг" if nut["days"] and nut.get("protein_per_kg") else "—",
         f"{n(nut['protein'])} г в день" if nut["days"] else ""),
        ("Дневник питания", f"{nut['days']} из {data['span']} дн.", f"полных (≥800 ккал): {nut['full_days']}"),
        ("Тренировки", f"{n(w['per_week'], 1)} в нед.", f"{len(w['sessions'])} трен. · {n(w['minutes'])} мин"),
        ("Вода, среднее", f"{n(data['water_ml'] / 1000, 1)} л" if data["water_ml"] else "—", f"цель {n(data['water_goal'] / 1000, 1)} л"),
        ("Сон 7+ часов", f"{sleep['good_sleep']} из {sleep['sleep_n']} ночей" if sleep and sleep["sleep_n"] else "—",
         "по утренним отметкам" if sleep else "не отмечался"),
    ])

    # --- 1. anthropometry
    pdf.h2("1. Антропометрия", need=60)
    if body["rows"]:
        male = person and person["sex"] == "мужской"
        rows = [["Масса тела, кг", "weight_kg", 1, ""], ["ИМТ, кг/м²", "bmi", 1, "18,5–24,9"],
                ["Окружность талии, см", "waist_cm", 1, ("< 94" if male else "< 80") if person else ""],
                ["Окружность бёдер, см", "hips_cm", 1, ""], ["Окружность груди, см", "chest_cm", 1, ""],
                ["Талия / рост", "whtr", 2, "< 0,5"], ["Талия / бёдра", "whr", 2, ("< 0,90" if male else "< 0,85") if person else ""],
                ["Доля жира, %", "body_fat_pct", 1, ""]]
        table = [[label, n(first.get(k), dg), n(last.get(k), dg), delta(first.get(k), last.get(k), dg), ref]
                 for label, k, dg, ref in rows if first.get(k) is not None or last.get(k) is not None]
        pdf.grid(["Показатель", "Начало периода", "Конец периода", "Изменение", "Ориентир"], table, [34, 17, 17, 15, 17], "LRRRR")
        if body.get("weekly") is not None and last.get("weight_kg"):
            pct = body["weekly"] / last["weight_kg"] * 100
            pdf.para(f"Темп изменения массы по линии тренда: {delta(0, body['weekly'], 2)} кг в неделю ({delta(0, pct, 2)} % массы тела). "
                     "Ориентиры: талия — IDF/ВОЗ (риск выше при больших значениях), талия/рост — < 0,5, ИМТ — классификация ВОЗ.")
        if len(body["points"]) > 1:
            pdf.caption("Масса тела, кг")
            pdf.weight_chart(body["points"], data["span"])
        if len(body["rows"]) > 1:
            pdf.caption("Все замеры за период", 30)
            pdf.grid(["Дата", "Масса, кг", "Талия, см", "Бёдра, см", "Грудь, см", "Жир, %"],
                     [[d(r["date"]), n(r["weight_kg"], 1), n(r["waist_cm"], 1), n(r["hips_cm"], 1), n(r["chest_cm"], 1), n(r["body_fat_pct"], 1)]
                      for r in body["rows"]], [20, 16, 16, 16, 16, 16], "LRRRRR")
    else:
        pdf.para("Взвешиваний и замеров за период нет.")

    # --- 2. energy and norms
    if norms:
        pdf.h2("2. Расход энергии и нормы", need=50)
        p_kg = lambda g: f"{n(g)} г ({n(g / last.get('weight_kg', 0), 1)} г/кг)" if last.get("weight_kg") else f"{n(g)} г"  # noqa: E731
        pdf.grid(["Показатель", "Значение", "Как получено"], [
            ["Основной обмен", f"{n(norms['bmr'])} ккал", "формула Миффлина — Сан Жеора"],
            ["Расход с учётом активности", f"{n(norms['maintenance'])} ккал", "основной обмен × коэффициент активности"],
            ["Реальный расход", f"{n(norms['measured'])} ккал" if norms["measured"] else "недостаточно данных",
             "по дневнику питания и динамике массы, последние 4 недели"],
            ["Норма калорий", f"{n(norms['calories'])} ккал", norms["source"]],
            ["Белки", p_kg(norms["protein"]), "1,6–2,2 г/кг (ISSN 2017; Morton 2018)"],
            ["Жиры", p_kg(norms["fat"]), "≈ 25 % энергии, не менее 0,8 г/кг"],
            ["Углеводы", p_kg(norms["carbs"]), "остаток энергии"],
        ], [30, 22, 48], "LRL")

    # --- 3. nutrition
    pdf.h2("3. Питание", need=60)
    if nut["days"]:
        base = "полным дням (≥ 800 ккал)" if nut["full_days"] else "дням с записями"
        pdf.para(f"Дневник вёлся {nut['days']} из {data['span']} дн., полных дней — {nut['full_days']}. Средние посчитаны по {base}; "
                 f"в пределах ±10 % от нормы калорий — {nut['in_norm']} дн.")
        norm = norms or {}
        pct = lambda fact, goal: f"{round(fact / goal * 100)} %" if goal else "—"  # noqa: E731
        e = nut["energy_pct"]
        pdf.grid(["Нутриент", "Факт, среднее в день", "Норма", "% нормы", "Доля энергии"], [
            ["Энергия", f"{n(nut['kcal'])} ккал", n(norm.get("calories")), pct(nut["kcal"], norm.get("calories")), "100 %"],
            ["Белки", f"{n(nut['protein'])} г" + (f" ({n(nut['protein_per_kg'], 1)} г/кг)" if nut.get("protein_per_kg") else ""),
             n(norm.get("protein")), pct(nut["protein"], norm.get("protein")), f"{e['protein']} %"],
            ["Жиры", f"{n(nut['fat'])} г", n(norm.get("fat")), pct(nut["fat"], norm.get("fat")), f"{e['fat']} %"],
            ["Углеводы", f"{n(nut['carbs'])} г", n(norm.get("carbs")), pct(nut["carbs"], norm.get("carbs")), f"{e['carbs']} %"],
        ], [22, 30, 16, 14, 18], "LRRRR")
        pdf.caption("Калории по дням (пунктир — норма, оранжевым — выше нормы более чем на 10 %)", 55)
        pdf.bars(nut["daily"], norm.get("calories"))
        tm = nut.get("timing")
        if tm:
            pdf.para(f"Время приёмов пищи (по записям): первый в среднем в {tm['first']}, последний — в {tm['last']}; "
                     f"окно питания около {n(tm['window_h'], 1)} ч.")
        if nut["top"]:
            pdf.caption("Основные источники энергии", 30)
            pdf.grid(["Продукт", "Дней", "В среднем за день", "Доля калорий"],
                     [[printable(f["name"]), str(f["days"]), f"{n(f['grams_per_day'])} г", f"{f['share']} %"] for f in nut["top"]],
                     [52, 10, 20, 18], "LRRR")
    else:
        pdf.para("Дневник питания за период не вёлся.")

    # --- 4. activity
    pdf.h2("4. Физическая активность", need=40)
    if w["sessions"]:
        pdf.para(f"Тренировок: {len(w['sessions'])} ({n(w['per_week'], 1)} в неделю), общее время — {n(w['minutes'])} мин, "
                 f"подходов — {w['sets']}. Тоннаж — сумма «вес × повторы» по силовым подходам.")
        pdf.grid(["Дата", "Тренировка", "Мин", "Подходов", "Тоннаж, кг", "Ощущение"],
                 [[d(s["date"]), printable(s["title"]), n(s["minutes"]), str(s["sets"]), n(s["volume"]) if s["volume"] else "—", s["effort"] or "—"]
                  for s in w["sessions"]], [17, 45, 9, 12, 14, 15], "LLRRRL")
    else:
        pdf.para("Тренировок за период не было.")

    # --- 5. water and wellbeing
    pdf.h2("5. Вода и самочувствие", need=24)
    pdf.para((f"Вода: в среднем {n(data['water_ml'] / 1000, 1)} л в день по дням с отметками, цель {n(data['water_goal'] / 1000, 1)} л "
              f"достигнута в {data['water_days']} дн." if data["water_ml"] else "Вода за период не отмечалась.")
             + (f" Сон: 7 часов и больше — {sleep['good_sleep']} из {sleep['sleep_n']} отмеченных ночей"
                + (f"; самочувствие в среднем {n(sleep['energy'], 1)} из 3." if sleep["energy"] else ".") if sleep and sleep["sleep_n"] else ""), 9, INK)

    pdf.h2("Методика и ограничения", need=30)
    pdf.para("Все данные внесены пользователем: еда — через поиск по базе продуктов, фото или текст, масса и обхваты — "
             "самостоятельными измерениями. Пищевая ценность — по базе Nextly (USDA, Open Food Facts, производители); "
             "погрешность самостоятельного учёта питания обычно 10–20 %, чаще в сторону занижения. "
             "Основной обмен — формула Миффлина — Сан Жеора; реальный расход — из энергобаланса: среднее потребление минус "
             "изменение массы по тренду × 7700 ккал/кг. Отчёт не является медицинским заключением.")

    # --- appendices
    days = data.get("days") or []
    if any(x["kcal"] or x["water_ml"] or x["workouts"] for x in days):
        pdf.add_page()
        pdf.h2("Приложение 1. Показатели по дням", need=30)
        pdf.grid(["Дата", "Ккал", "Белки, г", "Жиры, г", "Углеводы, г", "Вода, л", "Трен."],
                 [[f"{WEEKDAYS[x['date'].weekday()]}, {d(x['date'])}", n(x["kcal"]) if x["kcal"] else "—", n(x["protein"]) if x["kcal"] else "—",
                   n(x["fat"]) if x["kcal"] else "—", n(x["carbs"]) if x["kcal"] else "—",
                   n(x["water_ml"] / 1000, 1) if x["water_ml"] else "—", str(x["workouts"]) if x["workouts"] else ""] for x in days],
                 [24, 12, 12, 12, 14, 12, 9], "LRRRRRR", 8)
    if nut.get("diary"):
        pdf.add_page()
        pdf.h2(f"Приложение 2. Дневник питания за последние {nut['diary_days']} дн.", need=30)
        for day, items in nut["diary"]:
            tot = {k: sum(i[k] for i in items) for k in ("kcal", "protein", "fat", "carbs")}
            if pdf.get_y() + 22 > pdf.page_break_trigger:
                pdf.add_page()
            pdf.set_font("Manrope", "B", 9.5)
            pdf.set_text_color(*INK)
            pdf.cell(0, 6, f"{WEEKDAYS[day.weekday()]}, {d(day)} — {n(tot['kcal'])} ккал · Б {n(tot['protein'])} · Ж {n(tot['fat'])} · У {n(tot['carbs'])} г",
                     new_x="LMARGIN", new_y="NEXT")
            pdf.grid(["Время", "Приём", "Продукт", "г", "ккал", "Б", "Ж", "У"],
                     [[i["time"], i["meal"], printable(i["name"]), n(i["grams"]), n(i["kcal"]), n(i["protein"], 1), n(i["fat"], 1), n(i["carbs"], 1)]
                      for i in items], [9, 13, 44, 8, 9, 7, 7, 7], "LLLRRRRR", 7.8)

    return bytes(pdf.output())
