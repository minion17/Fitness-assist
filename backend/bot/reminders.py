"""Bot reminders: missed meals, water behind schedule, a streak about to break, habits at their time, Sunday summary.

`collect` decides what to send (pure DB logic, tested); `run` is the bot's background loop that sends it.
Reminder times are in each user's own timezone (the phone's).
"""
import asyncio
import logging
from datetime import date, datetime, timedelta

from sqlalchemy import func, select
from sqlalchemy.dialects.postgresql import insert

from functools import partial

from backend.api import fasting
from backend.api.daily import is_active, local_start, streak_state, water_goal
from backend.api.kitchen import usual_for
from backend.bot import cards
from backend.core import alerts, clock
from backend.api.stats import today_targets
from backend.database.db import SessionLocal
from backend.database.models import (
    BodyMeasurement, DailyCheckin, FastingPlan, FoodLog, Habit, HabitCheck, Product, Profile, ReminderSent, ReminderSettings, User, WaterIntake,
    WorkoutLog,
)

log = logging.getLogger("reminders")

MEALS = {"breakfast": "завтрак", "lunch": "обед", "dinner": "ужин"}
Render = partial  # a deferred card drawing: called in a worker thread just before sending
NO_CARD = Render(lambda: None)  # text-only message
# Extra buttons above "Открыть": (text, "cb:<callback data>") or (text, "app:<query>") — the Mini App opened with ?<query>
Buttons = list[tuple[str, str]] | None
# (time, share of the daily goal that should be drunk by then)
WATER_CHECKS = (("12:00", 0.35), ("16:00", 0.6), ("19:00", 0.85))
PROTEIN_CHECK = "16:30"  # the afternoon protein check (meal reminders on)
WINDOW = timedelta(minutes=45)  # a reminder missed by a restart is still sent within this window, not hours later


def liters(ml: float) -> str:
    return f"{ml / 1000:.2f}".rstrip("0").rstrip(".").replace(".", ",")


def due(at: str, now: datetime) -> bool:
    h, m = map(int, at.split(":"))
    start = now.replace(hour=h, minute=m, second=0, microsecond=0)
    return start <= now < start + WINDOW


async def eaten_today(session, user: User, start: datetime, until: datetime | None = None) -> tuple[set[str], dict[str, float]]:
    """Meal types logged since `start` (until `until`) and totals (kcal, protein, fat, carbs)."""
    rows = (await session.execute(
        select(FoodLog.meal_type, FoodLog.amount_g, Product.kcal, Product.protein_g, Product.fat_g, Product.carbs_g)
        .join(Product, Product.id == FoodLog.product_id)
        .where(FoodLog.user_id == user.id, FoodLog.logged_at >= start, *([FoodLog.logged_at < until] if until else []))
    )).all()
    totals = {k: sum(r[i + 2] * r[1] / 100 for r in rows) for i, k in enumerate(("kcal", "protein", "fat", "carbs"))}
    return {r[0] for r in rows}, totals


async def weekly_summary(session, user: User, today, look: dict) -> tuple[str, str, Render, Buttons]:
    from backend.api.ai import weekly_tip
    from backend.api.stats import daily_series, targets

    days = await daily_series(session, user, today - timedelta(days=6), today)
    goal = targets(await session.get(Profile, user.id))
    n, _ = await streak_state(session, user, today)
    weights = list(await session.scalars(
        select(BodyMeasurement.weight_kg).where(
            BodyMeasurement.user_id == user.id, BodyMeasurement.weight_kg.is_not(None),
            BodyMeasurement.measured_on >= today - timedelta(days=13),
        ).order_by(BodyMeasurement.measured_on)
    ))
    delta = round(weights[-1] - weights[0], 1) if len(weights) > 1 else None
    logged = [d for d in days if d["kcal"] > 0]
    in_norm = sum(1 for d in logged if goal and abs(d["kcal"] - goal["calories"]) <= 0.1 * goal["calories"])
    water = [d["water_ml"] for d in days if d["water_ml"] > 0]
    workouts = sum(d["workouts"] for d in days)
    text = (f"📊 Итоги недели: {in_norm} из 7 дней в норме"
            + (f", в среднем {round(sum(d['kcal'] for d in logged) / len(logged))} ккал" if logged else "")
            + f", тренировок — {workouts}.")
    ticks = await session.scalar(select(func.count()).where(HabitCheck.user_id == user.id, HabitCheck.day > today - timedelta(days=7)))
    if ticks:
        text += f" Привычки отмечены {ticks} {'раза' if ticks % 10 in (2, 3, 4) and ticks % 100 not in (12, 13, 14) else 'раз'}."
    from backend.api.energy import plateau

    buttons: list = [("📸 Неделя в историю", "app:open=story")]
    stuck = await plateau(session, user, await session.get(Profile, user.id))
    if stuck["plateau"]:  # more useful than a general tip this week
        text += "\n\n⚖️ Вес стоит две недели. " + " ".join(stuck["plateau_tips"][:2])
        if stuck["plateau_kcal"]:
            buttons.insert(0, (f"Сделать норму {stuck['plateau_kcal']} ккал", f"cb:kc:{stuck['plateau_kcal']}"))
    elif tip := await weekly_tip(session, user):
        text = f"{text}\n\n{tip}"
    text = text[:1000]  # Telegram photo captions are limited to 1024 characters
    card = Render(cards.weekly, [{"date": d["date"], "kcal": d["kcal"]} for d in days], goal and goal["calories"], n,
                  workouts, sum(water) / len(water) if water else 0, delta, **look)
    return f"{today}:weekly", text, card, buttons


async def habit_reminders(session, user: User, now: datetime) -> list[tuple[str, str, Render, Buttons]]:
    """Habits whose reminder time has come and that aren't ticked today: one message per time, a ✓ button each."""
    today = now.date()
    habits = list(await session.scalars(select(Habit).where(Habit.user_id == user.id, Habit.archived.is_(False),
                                                           Habit.remind_at.is_not(None)).order_by(Habit.id)))
    due_now = [h for h in habits if due(h.remind_at, now)]
    if not due_now:
        return []
    done = set(await session.scalars(select(HabitCheck.habit_id).where(HabitCheck.user_id == user.id, HabitCheck.day == today)))
    out = []
    for at in sorted({h.remind_at for h in due_now}):
        todo = [h for h in due_now if h.remind_at == at and h.id not in done]
        if todo:
            names = ", ".join(f"{h.emoji} {h.title}" for h in todo)
            out.append((f"{today}:habits{at}", f"⏰ Время привычки: {names}. Отметь здесь.",
                        NO_CARD, [(f"✓ {h.emoji} {h.title}"[:60], f"cb:hb:{h.id}") for h in todo]))
    return out


async def day_one(session, user: User, today) -> tuple[str, str, Render, Buttons]:
    """The evening of the first day: what got logged, and one small step for tomorrow."""
    eaten, t = await eaten_today(session, user, local_start(today))
    ml = await session.scalar(select(WaterIntake.ml).where(WaterIntake.user_id == user.id, WaterIntake.day == today)) or 0
    if eaten or ml:
        parts = [f"записано приёмов пищи: {len(eaten)}, {round(t['kcal'])} ккал" if eaten else "", f"воды {liters(ml)} л" if ml else ""]
        text = f"🌙 Первый день с Nextly: {', '.join(p for p in parts if p)}. Завтра повтори, со второго дня уже легче."
    else:
        text = ("🌙 Первый день позади, а записей нет. Завтра начни с завтрака: напиши «овсянка 60 г, банан», "
                "остальное посчитаю.")
    return "onb:day1", text, NO_CARD, None


async def day_close(session, user: User, today) -> tuple[str, str, Render, Buttons] | None:
    """Evening of a day with entries: where the day landed and the one thing worth fixing (protein, water, dinner)."""
    p = await session.get(Profile, user.id)
    eaten, t = await eaten_today(session, user, local_start(today))
    if not eaten:
        return None  # water or a workout only: the streak is safe, nothing to sum up
    goal = (await today_targets(session, user, p))
    kcal, norm = round(t["kcal"]), goal["calories"]
    text = f"🌙 Итог дня: {kcal:,} из {norm:,} ккал".replace(",", " ")
    if kcal > norm * 1.1:
        text += f" — выше нормы на {kcal - norm:,} ккал.".replace(",", " ") + " Завтра верни день в норму: запиши завтрак сразу, как поешь."
    elif kcal >= norm * 0.9:
        text += " — в норме 👌"
    else:
        text += "."
    short = goal["protein"] - t["protein"]
    picks: Buttons = None
    if short >= goal["protein"] * 0.15:
        line, picks = await protein_offer(session, user, short, norm - t["kcal"], "s")
        text += f" Белка не хватает {round(short)} г{line}"
    ml = await session.scalar(select(WaterIntake.ml).where(WaterIntake.user_id == user.id, WaterIntake.day == today)) or 0
    if ml < water_goal(p) * 0.7:
        text += f" Воды {liters(ml)} из {liters(water_goal(p))} л."
    buttons = [("🍽 Записать ужин", "cb:ask:d"), ("Что поесть?", "cbr:eat")] if "dinner" not in eaten else None
    return f"{today}:close", text, NO_CARD, (picks or []) + (buttons or []) or None


async def protein_offer(session, user: User, short: float, kcal_left: float, meal: str) -> tuple[str, Buttons]:
    """" — из твоего: творог 5% 200 г (+34 г)…" and a one-tap button for each; generic advice without a diary yet."""
    from backend.api.kitchen import protein_picks
    from backend.bot.chat import _b36

    picks = await protein_picks(session, user, kcal_left)
    if not picks:
        return " — творог, яйца или курица закроют.", None
    line = " — из того, что ты обычно ешь: " + ", ".join(f"{p['name'].lower()} {p['amount_g']} г (+{p['protein']} г)" for p in picks) + "."
    return line, [(f"+ {p['name']} {p['amount_g']} г · {p['protein']} г белка", f"cb:ea:{meal}:{_b36(p['product_id'])}x{p['amount_g']}")
                  for p in picks]


async def protein_check(session, user: User, now: datetime) -> tuple[str, str, Render, Buttons] | None:
    """Afternoon: they've eaten a good part of the day, but protein lags — offer it from their own diary while it's
    still easy to fit in (in the evening it's a big catch-up)."""
    today = now.date()
    p = await session.get(Profile, user.id)
    eaten, t = await eaten_today(session, user, local_start(today))
    goal = await today_targets(session, user, p)
    if not eaten or t["kcal"] < goal["calories"] * 0.35 or t["protein"] >= goal["protein"] * 0.4:
        return None
    short = goal["protein"] - t["protein"]
    line, picks = await protein_offer(session, user, short, goal["calories"] - t["kcal"], "s")
    return (f"{today}:protein", f"🥩 Белка пока {round(t['protein'])} из {goal['protein']} г, а день уже на середине. "
            f"Добрать {round(short)} г проще сейчас, чем вечером{line}", NO_CARD, picks)


GROUP_TIP_AT = "19:30"  # not on Sunday: that evening has the week's summary


async def group_tip(session, user: User, today: date) -> tuple[str, str, Render, Buttons] | None:
    """Once ever, when they've settled in (a week with Nextly, 3+ active days of the last 7) and aren't in a group
    chat yet: the bot in their friends' / family / office chat. "onb:group" keeps it to one message."""
    from backend.api.social import bot_username
    from backend.database.models import GroupMember, XpEvent

    if await session.scalar(select(GroupMember.user_id).where(GroupMember.user_id == user.id).limit(1)):
        return None
    active = await session.scalar(select(func.count(func.distinct(func.date(XpEvent.created_at)))).where(
        XpEvent.user_id == user.id, XpEvent.created_at >= local_start(today - timedelta(days=6))))
    bot = bot_username()
    if active < 3 or not bot:
        return None
    return ("onb:group", "👥 Неделя с Nextly позади. Дальше держаться проще компанией.\n\nДобавь меня в чат друзей, семьи или офиса: "
            "буду вести рейтинг недели, в понедельник объявлять чемпиона, а в четверг подначивать отстающих. "
            "Кто ещё не в Nextly, присоединится по кнопке из чата.",
            NO_CARD, [("👥 Добавить в чат", f"url:https://t.me/{bot}?startgroup=nextly")])


PLAN_END_AT = "18:30"


async def plan_ending(session, user: User, today: date) -> tuple[str, str, Render, Buttons] | None:
    """The evening before a saved meal plan's last day: time to make the next one and do the shopping."""
    from backend.api.saved_meal_plan import plan_end_day
    from backend.database.models import SavedMealPlan

    row = await session.get(SavedMealPlan, user.id)
    end = plan_end_day(row.payload) if row else None
    if end != today + timedelta(days=1) or row.payload.get("queued"):  # the next one is already waiting
        return None
    return (f"plan_end:{end}", "🥗 Завтра последний день рациона. Составлю следующий с теми же настройками и новыми блюдами, "
            "а список покупок отправишь себе или в чат семьи и купишь всё заранее.",
            NO_CARD, [("Составить следующий рацион", "app:open=renew")])


PLAN_MORNING_AT = "08:30"
PLAN_COOK_AT = "20:30"
SLOTS = {"breakfast": "Завтрак", "lunch": "Обед", "snack": "Перекус", "dinner": "Ужин"}


async def plan_reminders(session, user: User, now: datetime) -> list[tuple[str, str, Render, Buttons]]:
    """The saved meal plan in the chat: the morning's menu, and in the evening what to cook tomorrow."""
    from backend.api.saved_meal_plan import day_on
    from backend.database.models import SavedMealPlan

    row = await session.get(SavedMealPlan, user.id)
    if not row:
        return []
    today = now.date()
    out = []
    if due(PLAN_MORNING_AT, now):
        day, _ = day_on(row.payload, today)
        if day and day.get("meals"):
            lines = [f"{SLOTS.get(m.get('meal'), '')}: {m.get('name')}" + (" (вчерашний ужин)" if m.get("repeat") and m.get("meal") == "lunch" else "")
                     for m in day["meals"]]
            kcal = round(sum(float(m.get("nutrition", {}).get("kcal", 0)) for m in day["meals"]))
            out.append((f"{today}:plan", "🥗 Сегодня по рациону:\n" + "\n".join(lines) + f"\n≈ {kcal} ккал. Съеденное отмечай галочкой в дневнике.",
                        NO_CARD, [("Открыть рацион", "app:open=plan")]))
    if due(PLAN_COOK_AT, now):
        tomorrow, today_day = day_on(row.payload, today + timedelta(days=1))
        cook = [m for m in (tomorrow or {}).get("meals", []) if m.get("meal") in ("lunch", "dinner") and not m.get("repeat")]
        if cook:
            batch = row.payload.get("input", {}).get("cookingMode") == "batch"
            daily = row.payload.get("input", {}).get("cookingMode") == "daily"
            names = " и ".join(f"«{m.get('name')}»" for m in cook)
            if batch:
                n = row.payload.get("input", {}).get("batchDays") or 2
                text = f"🍳 Завтра готовим на {n} {'дня' if n < 5 else 'дней'} вперёд: {names}. Проверь, что продукты дома, а мясо или рыбу переложи из морозилки в холодильник."
            elif daily and any(m.get("meal") == "dinner" for m in cook):
                text = f"🍳 Завтра на ужин {names}. Готовь сразу 2 порции: вторая — обед на следующий день."
            else:
                text = f"🍳 Завтра по рациону готовим {names}. Проверь, что продукты дома."
            out.append((f"{today}:plancook", text, NO_CARD, [("Рецепт и продукты", "app:open=plan")]))
    return out


async def day_three_tip(session, user: User) -> tuple[str, str, Render, Buttons]:
    """Day 3: one feature they haven't tried yet."""
    from backend.database.models import AiRequest, Friendship

    if not await session.scalar(select(AiRequest.id).where(AiRequest.user_id == user.id, AiRequest.kind == "meal_photo").limit(1)):
        text = "📸 Совет: еду можно не писать, а сфотографировать. Пришли фото тарелки, я разберу блюда и посчитаю калории."
    elif not await session.scalar(select(FoodLog.id).join(Product, Product.id == FoodLog.product_id)
                                  .where(FoodLog.user_id == user.id, Product.barcode.is_not(None)).limit(1)):
        text = "🏷 Совет: продукты из магазина быстрее записывать по штрихкоду: Питание → сканер."
    elif not await session.scalar(select(Friendship.user_id).where(Friendship.user_id == user.id).limit(1)):
        text = "🤝 Совет: с другом держаться проще. Пригласи его: Прогресс → Друзья. Там же рейтинг недели и дуэли."
    else:
        text = "💡 /today покажет, сколько съедено и сколько осталось на сегодня."
    return "onb:tip3", text, NO_CARD, None


async def nudges(session, now: datetime) -> list[tuple[User, str, str]]:
    """Started the bot but no questionnaire yet: a reminder after 3 hours and a last one the next day. Then silence."""
    rows = await session.scalars(select(User).outerjoin(Profile, Profile.user_id == User.id)
                                 .where(Profile.user_id.is_(None), User.created_at > now - timedelta(hours=48)))
    out = []
    for user in rows:
        clock.use_tz(user.device_tz)
        local, age = clock.local(now), now - user.created_at
        if timedelta(hours=3) <= age < timedelta(hours=20) and 9 <= local.hour < 21:
            out.append((user, "onb:n1", "Осталась пара вопросов, и план готов: норма КБЖУ, вода, тренировки. Две минуты."))
        elif age >= timedelta(hours=20) and 12 <= local.hour < 20:
            out.append((user, "onb:n2", "Последнее напоминание, обещаю: анкета займёт 2 минуты, а дальше я сам буду считать "
                                        "калории по фото и тексту. Неинтересно? Просто не отвечай, больше не напишу."))
    clock.use_tz(None)
    return out


async def fasting_reminders(session, user: User, plan: FastingPlan, now: datetime) -> list[tuple[str, str, Render, Buttons]]:
    """The window opens: how long the fast was; 30 minutes before it closes: protein still to eat."""
    today, out = now.date(), []
    if due(plan.eat_from, now):
        st = fasting.state(plan, await fasting.last_meal(session, user.id), now)
        out.append((f"{today}:fast_open", f"🍽 Окно питания открылось (до {fasting.eat_to(plan)}). "
                    + (f"Голод {st['fasted_h']:g} ч позади. " if st["fasted_h"] >= 10 else "") + "Начни с белка."
                    + (f"\n{s}" if (s := fasting.series_text(await fasting.series(session, plan, user.id))) else ""),
                    NO_CARD, [("🍽 Что поесть?", "cb:eat")]))
    close = (datetime.strptime(fasting.eat_to(plan), "%H:%M") - timedelta(minutes=30)).strftime("%H:%M")
    if due(close, now):
        _, t = await eaten_today(session, user, local_start(today))
        p = await session.get(Profile, user.id)
        left = (await today_targets(session, user, p))["protein"] - t["protein"]
        out.append((f"{today}:fast_close", f"⏳ Через 30 минут, в {fasting.eat_to(plan)}, окно питания закрывается. "
                    + (f"Белка осталось ~{round(left / 5) * 5} г , успей добрать." if left >= 20 else "Норма белка на сегодня почти добрана 👍"),
                    NO_CARD, None))
    return out


async def candidates(session, user: User, cfg: ReminderSettings, now: datetime) -> list[tuple[str, str, Render, Buttons]]:
    """(key, caption, card, buttons) of reminders that are due for this user right now and still make sense."""
    today = now.date()
    look = {"theme": user.theme if user.theme in cards.THEMES else None, "accent": user.accent}
    out = []
    fast = await session.get(FastingPlan, user.id)
    if fast and fast.remind:
        out += await fasting_reminders(session, user, fast, now)
    if cfg.meals and due(PROTEIN_CHECK, now) and (not fast or fasting.in_window(fast, now)):
        offer = await protein_check(session, user, now)
        if offer:
            out.append(offer)
    if cfg.meals:
        todo = [m for m in MEALS if due(getattr(cfg, f"{m}_at"), now)]
        if fast:  # no "запиши завтрак" at 10:00 when the window opens at 12:00
            todo = [m for m in todo if fasting.in_window(fast, now)]
        if todo:
            eaten, t = await eaten_today(session, user, local_start(today))
            p = await session.get(Profile, user.id)
            goal = (await today_targets(session, user, p))
            macros = {"Белки": (t["protein"], goal["protein"]), "Жиры": (t["fat"], goal["fat"]), "Углеводы": (t["carbs"], goal["carbs"])}
            yesterday, _ = await eaten_today(session, user, local_start(today - timedelta(days=1)), local_start(today))
            for m in todo:
                if m in eaten:
                    continue
                usual = await usual_for(session, user, m)  # "Как обычно" beats "Как вчера": it's what they really eat
                buttons = [(f"↻ Как обычно · {round(usual['kcal'])} ккал", f"cb:us:{m[0]}")] if usual else \
                    [("↻ Как вчера", f"cb:rep:{m[0]}")] if m in yesterday else None
                out.append((f"{today}:{m}", f"🍽 Не забудь записать {MEALS[m]} — напиши его сюда, например «омлет из 2 яиц, кофе».",
                            Render(cards.meal, MEALS[m].capitalize(), t["kcal"], goal["calories"], macros, **look), buttons))
    if cfg.water:
        for at, share in WATER_CHECKS:
            if due(at, now):
                goal = water_goal(await session.get(Profile, user.id))
                ml = await session.scalar(
                    select(WaterIntake.ml).where(WaterIntake.user_id == user.id, WaterIntake.day == today)
                ) or 0
                if ml < goal * share:
                    out.append((f"{today}:water{at}", f"💧 Выпито {liters(ml)} л из {liters(goal)} л. Выпей стакан сейчас.",
                                Render(cards.water, ml, goal, at, **look), None))
    if due(cfg.weekly_at or "19:00", now):  # the norm from their own data, once a week (energy.recalc keeps the pace)
        # shortcut: users without enough data are re-measured each minute of the window; cache the miss if users grow to thousands
        from backend.api.energy import recalc, recalc_text

        p = await session.get(Profile, user.id)
        had = p.kcal_override
        changed = await recalc(session, user, p)
        if changed:
            out.append((f"{today}:norm", recalc_text(changed), NO_CARD, [(f"Вернуть {changed['old']} ккал", f"cb:ka:{had or 0}")]))
    if getattr(cfg, "weekly", True) and now.weekday() == 6 and due(cfg.weekly_at or "19:00", now):
        out.append(await weekly_summary(session, user, today, look))
    first_day = clock.local(user.created_at).date() == today
    if due(cfg.streak_at, now) and first_day:
        out.append(await day_one(session, user, today))
    elif cfg.streak and due(cfg.streak_at, now):
        n, days = await streak_state(session, user, today)
        if today in days and is_active(days[today]):
            close = await day_close(session, user, today)
            if close:
                out.append(close)
        elif n > 0:
            week = [today - timedelta(days=i) in days and is_active(days[today - timedelta(days=i)]) for i in range(6, -1, -1)]
            out.append((f"{today}:streak", f"🔥 {n} {cards.plural_days(n)} подряд с Nextly. Не обрывай серию: хватит одной записи еды, воды или тренировки."
                        f" До конца дня {24 - now.hour} ч.",
                        Render(cards.streak, n, week, **look), None))
    if getattr(cfg, "workout", True) and due(cfg.workout_at or "09:00", now):
        p = await session.get(Profile, user.id)
        if p and p.training_days and now.weekday() in p.training_days:
            trained = await session.scalar(select(WorkoutLog.id).where(
                WorkoutLog.user_id == user.id, WorkoutLog.started_at >= local_start(today)).limit(1))
            if not trained:
                out.append((f"{today}:workout", "🏋️ Сегодня день тренировки. Веса подставлены с прошлого раза.",
                            NO_CARD, None))
    if getattr(cfg, "checkin", False) and due(cfg.checkin_at or "09:00", now) and \
            not await session.get(DailyCheckin, (user.id, today)):
        out.append((f"{today}:checkin", "☀️ Доброе утро! Как спалось?", NO_CARD,
                    [("<6 ч", "cb:sl:1"), ("6–7", "cbr:sl:2"), ("7–8", "cbr:sl:3"), ("8+", "cbr:sl:4")]))
    if clock.local(user.created_at).date() == today - timedelta(days=2) and due("13:00", now):
        out.append(await day_three_tip(session, user))
    if now.weekday() != 6 and due(GROUP_TIP_AT, now) and clock.local(user.created_at).date() <= today - timedelta(days=7):
        tip = await group_tip(session, user, today)
        if tip:
            out.append(tip)
    if cfg.meals:
        out += await plan_reminders(session, user, now)
    if due(PLAN_END_AT, now):
        ending = await plan_ending(session, user, today)
        if ending:
            out.append(ending)
    out += await habit_reminders(session, user, now)
    return out


async def collect(session, now: datetime) -> list[tuple[int, str, Render, Buttons]]:
    """(telegram_id, caption, card, buttons) to send now. Each reminder is recorded first, so it is sent at most once."""
    rows = await session.execute(
        select(User, ReminderSettings).join(Profile, Profile.user_id == User.id)  # registered users only
        .outerjoin(ReminderSettings, ReminderSettings.user_id == User.id)
    )
    messages = []
    for user, cfg in rows.all():
        clock.use_tz(user.device_tz)
        cfg = cfg or ReminderSettings(meals=True, water=True, streak=True, weekly=True, workout=True, breakfast_at="10:00",
                                      lunch_at="14:00", dinner_at="20:00", streak_at="21:00", weekly_at="19:00", workout_at="09:00")
        for key, text, card, buttons in await candidates(session, user, cfg, clock.local(now)):
            fresh = await session.scalar(
                insert(ReminderSent).values(user_id=user.id, key=key).on_conflict_do_nothing().returning(ReminderSent.key)
            )
            if fresh:
                messages.append((user.telegram_id, text, card, buttons))
    clock.use_tz(None)
    for user, key, text in await nudges(session, now):
        fresh = await session.scalar(
            insert(ReminderSent).values(user_id=user.id, key=key).on_conflict_do_nothing().returning(ReminderSent.key))
        if fresh:
            messages.append((user.telegram_id, text, NO_CARD, None))
    await session.commit()
    return messages


def markup(buttons: Buttons, keyboard, app_url: str):
    """Extra buttons (one per row; "cbr:" joins the previous row) above the usual "Открыть" keyboard."""
    from aiogram.types import InlineKeyboardButton, InlineKeyboardMarkup, WebAppInfo

    rows = []
    for text, action in buttons or []:
        kind, _, value = action.partition(":")
        if kind == "cbr" and rows:
            rows[-1].append(InlineKeyboardButton(text=text, callback_data=value))
        elif kind in ("cb", "cbr"):
            rows.append([InlineKeyboardButton(text=text, callback_data=value)])
        elif kind == "url":
            rows.append([InlineKeyboardButton(text=text, url=value)])
        elif app_url.startswith("https://"):
            rows.append([InlineKeyboardButton(text=text, web_app=WebAppInfo(url=f"{app_url}{'&' if '?' in app_url else '?'}{value}"))])
    base = keyboard()
    rows += base.inline_keyboard if base else []
    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


async def run(bot, keyboard, app_url=lambda: "") -> None:
    """Check once a minute; never let one failure stop the loop."""
    from aiogram.exceptions import TelegramForbiddenError
    from aiogram.types import BufferedInputFile

    while True:
        try:
            async with SessionLocal() as session:
                batch = await collect(session, datetime.now().astimezone())
            for chat_id, text, card, buttons in batch:
                try:
                    try:
                        png = await asyncio.to_thread(card)  # ~0.3 s of drawing: keep it off the event loop
                    except Exception:
                        log.warning("card for %s failed, sending text only", chat_id, exc_info=True)
                        png = None
                    kb = markup(buttons, keyboard, app_url())
                    if png:
                        await bot.send_photo(chat_id, BufferedInputFile(png, "card.png"), caption=text, reply_markup=kb)
                    else:
                        await bot.send_message(chat_id, text, reply_markup=kb)
                except TelegramForbiddenError:
                    log.info("user %s blocked the bot", chat_id)  # nothing to do; they can /start again
                except Exception:
                    log.warning("reminder to %s failed", chat_id, exc_info=True)
                await asyncio.sleep(0.05)  # stay far below Telegram's 30 msg/s limit
        except Exception as e:
            log.exception("reminder loop failed")
            await alerts.report("бот: напоминания", alerts.describe(e))
        await asyncio.sleep(60)


