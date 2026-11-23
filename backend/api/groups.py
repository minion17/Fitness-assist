"""Challenges in group chats: the bot added to a chat of friends, family or an office keeps a weekly rating of the
members who joined (by Setly XP — workouts, the food diary, water, habits all earn it), posts the results on Monday
morning, a "кто кого догоняет" in the middle of the week and a short cheer when someone finishes a workout.

Every post carries "Открыть Setly" (t.me/<bot>?start=g<code>): whoever in the chat isn't using Setly yet joins the
rating from there — each chat brings new people. Posts go through the outbox (kind "group").
"""
import secrets
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import func, select

from backend.api.social import bot_username, name
from backend.database.db import AsyncSession
from backend.database.models import GroupChat, GroupMember, Outbox, Profile, User, WorkoutLog, XpEvent

RESULTS_AT = (0, 10)  # Monday 10:00 in the chat's zone: last week's results
TEASE_AT = (3, 19)  # Thursday 19:00: the middle of the week
MEDALS = ("🥇", "🥈", "🥉")
HOW = "Очки — это XP Setly: за тренировку, записи еды, воду и привычки."
DEFAULT_TZ = "Europe/Moscow"


def zone(g: GroupChat) -> ZoneInfo:
    try:
        return ZoneInfo(g.tz or DEFAULT_TZ)
    except Exception:
        return ZoneInfo(DEFAULT_TZ)


def monday_of(local: datetime) -> date:
    return local.date() - timedelta(days=local.weekday())


def join_link(g: GroupChat) -> str | None:
    bot = bot_username()
    return f"https://t.me/{bot}?start=g{g.code}" if bot else None


def post(session: AsyncSession, g: GroupChat, text: str) -> None:
    session.add(Outbox(telegram_id=g.chat_id, kind="group", text=text))


async def added(session: AsyncSession, chat_id: int, title: str, adder: User | None) -> GroupChat:
    """The bot was added to a chat (again): the group, active, with the adder in it."""
    g = await session.scalar(select(GroupChat).where(GroupChat.chat_id == chat_id))
    if g is None:
        g = GroupChat(chat_id=chat_id, title=title[:128], code=secrets.token_urlsafe(8)[:10], tz=adder and adder.device_tz)
        now = datetime.now(zone(g))
        g.results_for = monday_of(now) - timedelta(days=7)  # no results for a week from before the bot was here
        if (now.weekday(), now.hour) >= TEASE_AT:
            g.teased_for = monday_of(now)
        session.add(g)
        await session.flush()
    g.active, g.title = True, title[:128] or g.title
    if adder:
        await join(session, g, adder)
    await session.commit()
    return g


async def join(session: AsyncSession, g: GroupChat, user: User) -> bool:
    """False when they're already in."""
    if await session.get(GroupMember, (g.id, user.id)):
        return False
    session.add(GroupMember(group_id=g.id, user_id=user.id))
    await session.flush()
    return True


async def week(session: AsyncSession, g: GroupChat, monday: date, until: datetime | None = None) -> list[tuple[User, int, int]]:
    """(member, XP, workouts) for the week from `monday` in the chat's zone, most XP first."""
    z = zone(g)
    start = datetime.combine(monday, datetime.min.time(), tzinfo=z)
    end = until or start + timedelta(days=7)
    users = list(await session.scalars(select(User).join(GroupMember, GroupMember.user_id == User.id)
                                       .where(GroupMember.group_id == g.id).order_by(GroupMember.joined_at)))
    ids = [u.id for u in users]
    xp = dict((await session.execute(select(XpEvent.user_id, func.sum(XpEvent.xp)).where(
        XpEvent.user_id.in_(ids), XpEvent.created_at >= start, XpEvent.created_at < end).group_by(XpEvent.user_id))).all()) if ids else {}
    wk = dict((await session.execute(select(WorkoutLog.user_id, func.count()).where(
        WorkoutLog.user_id.in_(ids), WorkoutLog.completed_at >= start, WorkoutLog.completed_at < end).group_by(WorkoutLog.user_id))).all()) if ids else {}
    return sorted(((u, int(xp.get(u.id) or 0), int(wk.get(u.id) or 0)) for u in users), key=lambda r: -r[1])


def lines(rows: list[tuple[User, int, int]], limit: int = 10) -> str:
    out = []
    for i, (u, xp, w) in enumerate(rows[:limit]):
        place = MEDALS[i] if i < 3 and xp else f"{i + 1}."
        out.append(f"{place} {name(u)} — {xp} XP" + (f" · трен.: {w}" if w else ""))
    if len(rows) > limit:
        out.append(f"…и ещё {len(rows) - limit}")
    return "\n".join(out)


async def board_text(session: AsyncSession, g: GroupChat) -> str:
    """/top in the chat: this week so far."""
    now = datetime.now(zone(g))
    rows = await week(session, g, monday_of(now), now)
    if not rows:
        return "В рейтинге пока никого. Жмите «Участвую» под приветствием или пишите /join — и начнём неделю."
    return f"🏆 Рейтинг чата за эту неделю\n\n{lines(rows)}\n\n{HOW} Итоги — в понедельник утром."


def results_text(g: GroupChat, rows: list[tuple[User, int, int]]) -> str | None:
    active = [r for r in rows if r[1] > 0]
    if not active:
        return None  # a quiet week: no post (it would only nag an empty rating)
    champ = active[0]
    text = f"📣 Итоги недели в чате «{g.title}»\n\n{lines(rows)}\n\n🎉 Чемпион недели — {name(champ[0])}: {champ[1]} XP"
    text += f" и {champ[2]} трен.!" if champ[2] else "!"
    quiet = [name(u) for u, xp, _ in rows if xp == 0]
    if quiet:
        text += f"\n\n😴 {', '.join(quiet[:5])} — на прошлой неделе тишина. Новая неделя — новый шанс обойти всех."
    return text + "\n\nНовая неделя уже идёт. Рейтинг сейчас — /top"


def tease_text(rows: list[tuple[User, int, int]]) -> str | None:
    if len(rows) < 2:
        return ("⚡️ Середина недели, а в рейтинге только " + name(rows[0][0]) + ". Остальные — жмите /join, вдвоём веселее."
                if rows and rows[0][1] else None)
    (lead, lxp, _), (second, sxp, _) = rows[0], rows[1]
    if not lxp:
        return "⚡️ Середина недели, а очков пока ни у кого. Кто первым запишет тренировку — тот и лидер 😉"
    gap = lxp - sxp
    text = f"⚡️ Середина недели: впереди {name(lead)} — {lxp} XP."
    text += (f" {name(second)} отстаёт всего на {gap} XP — одна тренировка, и лидерство сменится!" if gap <= 60
             else f" {name(second)}, до лидера {gap} XP — ещё есть время до воскресенья.")
    return text + "\n\nРейтинг — /top"


async def group_posts(session: AsyncSession) -> int:
    """Monday results and the Thursday post, once per week per chat. Run by the bot every minute."""
    posted = 0
    for g in await session.scalars(select(GroupChat).where(GroupChat.active.is_(True))):
        now = datetime.now(zone(g))
        monday = monday_of(now)
        if (now.weekday(), now.hour) >= RESULTS_AT and g.results_for != monday - timedelta(days=7):
            g.results_for = monday - timedelta(days=7)
            text = results_text(g, await week(session, g, monday - timedelta(days=7)))
            if text:
                post(session, g, text)
                posted += 1
        if (now.weekday(), now.hour) >= TEASE_AT and g.teased_for != monday:
            g.teased_for = monday
            text = tease_text(await week(session, g, monday, now))
            if text:
                post(session, g, text)
                posted += 1
    await session.commit()
    return posted


async def on_workout(session: AsyncSession, user: User, w: WorkoutLog) -> None:
    """"💪 Аня закончила тренировку" in each of their chats, once a day per chat."""
    members = list(await session.execute(select(GroupMember, GroupChat).join(GroupChat, GroupChat.id == GroupMember.group_id)
                                         .where(GroupMember.user_id == user.id, GroupChat.active.is_(True))))
    p = await session.get(Profile, user.id)
    done = {"male": "закончил", "female": "закончила"}.get(p.sex if p else "", "закончил(а)")
    for m, g in members:
        now = datetime.now(zone(g))
        if m.cheered_on == now.date():
            continue
        m.cheered_on = now.date()
        n = await session.scalar(select(func.count()).where(
            WorkoutLog.user_id == user.id, WorkoutLog.completed_at >= datetime.combine(monday_of(now), datetime.min.time(), tzinfo=zone(g))))
        title = f" «{w.title}»" if w.title else ""
        post(session, g, f"💪 {name(user)} {done} тренировку{title} — {n}-я за неделю. Кто следующий?")
    if members:
        await session.commit()
