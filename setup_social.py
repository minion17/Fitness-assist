"""
LOGOS ASSIST — интеграция социальной механики (друзья + дуэли 1-на-1).

КАК ЗАПУСКАТЬ:
  1. Файл положить в КОРЕНЬ репозитория (рядом с docker-compose.yml)
  2. Убедиться, что PostgreSQL запущен: docker compose up -d db
  3. python setup_social.py

ЧТО ДЕЛАЕТ:
  - создаёт content/duels/duel_templates.json (шаблоны дуэлей)
  - добавляет модели Friendship, ReferralCode, Duel, DuelScore
  - добавляет API-эндпоинты /api/friends/*, /api/duels/*
  - создаёт backend/core/social_tasks.py (фоновые задачи)
  - импортирует шаблоны дуэлей в БД

ПОВТОРНЫЙ ЗАПУСК БЕЗОПАСЕН: дубликаты не создаются.
"""

from pathlib import Path
import asyncio
import json
import sys

ROOT = Path(__file__).resolve().parent
MARK = "# === LOGOS SOCIAL ==="

# ======================================================================
# 1. ДАННЫЕ: шаблоны дуэлей
# ======================================================================
DUEL_TEMPLATES = [
    {
        "key": "sprint",
        "name": "Спринт",
        "description": "Кто наберёт больше XP за 3 дня",
        "duration_days": 3,
        "win_condition": "xp",
        "default_stake": 10,
        "min_stake": 5,
        "max_stake": 50,
        "icon": "⚡",
    },
    {
        "key": "week_discipline",
        "name": "Неделя дисциплины",
        "description": "Кто наберёт больше XP за 7 дней",
        "duration_days": 7,
        "win_condition": "xp",
        "default_stake": 20,
        "min_stake": 10,
        "max_stake": 100,
        "icon": "📅",
    },
    {
        "key": "iron_arg",
        "name": "Железный аргумент",
        "description": "Кто завершит больше тренировок за 7 дней",
        "duration_days": 7,
        "win_condition": "workouts",
        "default_stake": 30,
        "min_stake": 10,
        "max_stake": 100,
        "icon": "🏋️",
    },
    {
        "key": "marathon",
        "name": "Марафонец",
        "description": "У кого длиннее стрик за 30 дней",
        "duration_days": 30,
        "win_condition": "streak",
        "default_stake": 50,
        "min_stake": 20,
        "max_stake": 200,
        "icon": "🏆",
    },
]

# ======================================================================
# 2. МОДЕЛИ (добавляются в конец models.py)
# ======================================================================
MODELS = r'''
from sqlalchemy import ARRAY, Boolean, Text, Date
from sqlalchemy.orm import relationship as _rel

class Friendship(Base):
    __tablename__ = "friendships"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    friend_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (UniqueConstraint("user_id", "friend_id"),)

class ReferralCode(Base):
    __tablename__ = "referral_codes"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), unique=True)
    code: Mapped[str] = mapped_column(String(20), unique=True, index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

class DuelTemplate(Base):
    __tablename__ = "duel_templates"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(50), unique=True)
    name: Mapped[str] = mapped_column(String(100))
    description: Mapped[str | None] = mapped_column(Text)
    duration_days: Mapped[int] = mapped_column(Integer)
    win_condition: Mapped[str] = mapped_column(String(20))
    default_stake: Mapped[int] = mapped_column(Integer, default=20)
    min_stake: Mapped[int] = mapped_column(Integer, default=5)
    max_stake: Mapped[int] = mapped_column(Integer, default=200)
    icon: Mapped[str] = mapped_column(String(10), default="⚔️")

class Duel(Base):
    __tablename__ = "duels"
    id: Mapped[int] = mapped_column(primary_key=True)
    challenger_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    opponent_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    template_key: Mapped[str] = mapped_column(String(50))
    stake_xp: Mapped[int] = mapped_column(Integer, default=20)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ends_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    winner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="pending")
    scores: Mapped[list] = _rel("DuelScore", cascade="all, delete-orphan")

class DuelScore(Base):
    __tablename__ = "duel_scores"
    id: Mapped[int] = mapped_column(primary_key=True)
    duel_id: Mapped[int] = mapped_column(ForeignKey("duels.id", ondelete="CASCADE"))
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id"))
    xp_at_start: Mapped[int] = mapped_column(Integer, default=0)
    xp_at_end: Mapped[int] = mapped_column(Integer, default=0)
    workouts_at_start: Mapped[int] = mapped_column(Integer, default=0)
    workouts_at_end: Mapped[int] = mapped_column(Integer, default=0)
    streak_at_start: Mapped[int] = mapped_column(Integer, default=0)
    streak_at_end: Mapped[int] = mapped_column(Integer, default=0)
    __table_args__ = (UniqueConstraint("duel_id", "user_id"),)
'''

# ======================================================================
# 3. API-код (добавляется в main.py)
# ======================================================================
API_CODE = r'''
import secrets
from datetime import timedelta
from sqlalchemy.orm import selectinload

@app.get("/api/friends")
async def list_friends(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    result = await session.execute(
        select(Friendship).where(
            ((Friendship.user_id == user.id) | (Friendship.friend_id == user.id)),
            Friendship.status == "accepted"
        )
    )
    friendships = result.scalars().all()
    friends = []
    for f in friendships:
        friend_id = f.friend_id if f.user_id == user.id else f.user_id
        friend = await session.get(User, friend_id)
        if friend:
            friends.append({
                "id": friend.id, "username": friend.username,
                "first_name": friend.first_name, "level": friend.level,
                "xp": friend.xp, "last_active": friend.updated_at.isoformat() if friend.updated_at else None,
            })
    return friends

@app.get("/api/friends/pending")
async def pending_requests(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    result = await session.execute(
        select(Friendship).where(Friendship.friend_id == user.id, Friendship.status == "pending")
    )
    pending = result.scalars().all()
    requests = []
    for p in pending:
        requester = await session.get(User, p.user_id)
        if requester:
            requests.append({
                "friendship_id": p.id, "username": requester.username, "first_name": requester.first_name,
            })
    return requests

class FriendInviteIn(BaseModel):
    friend_telegram_id: int | None = None
    referral_code: str | None = None

@app.post("/api/friends/invite")
async def invite_friend(body: FriendInviteIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    if body.referral_code:
        ref = await session.scalar(select(ReferralCode).where(ReferralCode.code == body.referral_code))
        if not ref:
            raise HTTPException(404, "Неверный код приглашения")
        if ref.user_id == user.id:
            raise HTTPException(400, "Нельзя пригласить самого себя")
        friend = await session.get(User, ref.user_id)
    elif body.friend_telegram_id:
        friend = await session.scalar(select(User).where(User.telegram_id == body.friend_telegram_id))
    else:
        raise HTTPException(400, "Укажи friend_telegram_id или referral_code")
    if not friend:
        raise HTTPException(404, "Пользователь не найден")
    existing = await session.scalar(
        select(Friendship).where(
            ((Friendship.user_id == user.id) & (Friendship.friend_id == friend.id)) |
            ((Friendship.user_id == friend.id) & (Friendship.friend_id == user.id))
        )
    )
    if existing:
        return {"message": "Запрос уже существует", "friendship_id": existing.id}
    friendship = Friendship(user_id=user.id, friend_id=friend.id, status="pending")
    session.add(friendship)
    await session.commit()
    await session.refresh(friendship)
    return {"message": "Запрос отправлен", "friendship_id": friendship.id}

@app.post("/api/friends/accept/{friendship_id}")
async def accept_friend(friendship_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    friendship = await session.get(Friendship, friendship_id)
    if not friendship or friendship.friend_id != user.id:
        raise HTTPException(404, "Запрос не найден")
    if friendship.status != "pending":
        raise HTTPException(400, "Запрос уже обработан")
    friendship.status = "accepted"
    await session.commit()
    return {"message": "Друг добавлен"}

@app.post("/api/friends/reject/{friendship_id}")
async def reject_friend(friendship_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    friendship = await session.get(Friendship, friendship_id)
    if not friendship or friendship.friend_id != user.id:
        raise HTTPException(404, "Запрос не найден")
    await session.delete(friendship)
    await session.commit()
    return {"message": "Запрос отклонён"}

@app.delete("/api/friends/{friend_id}")
async def remove_friend(friend_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    friendship = await session.scalar(
        select(Friendship).where(
            ((Friendship.user_id == user.id) & (Friendship.friend_id == friend_id)) |
            ((Friendship.user_id == friend_id) & (Friendship.friend_id == user.id)),
            Friendship.status == "accepted"
        )
    )
    if not friendship:
        raise HTTPException(404, "Дружба не найдена")
    await session.delete(friendship)
    await session.commit()
    return {"message": "Друг удалён"}

@app.post("/api/referral/generate")
async def generate_referral(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    existing = await session.scalar(select(ReferralCode).where(ReferralCode.user_id == user.id))
    if existing:
        return {"code": existing.code}
    code = secrets.token_urlsafe(8)
    ref = ReferralCode(user_id=user.id, code=code)
    session.add(ref)
    await session.commit()
    return {"code": code}

@app.get("/api/duels/templates")
async def duel_templates(session: AsyncSession = Depends(get_session)):
    result = await session.execute(select(DuelTemplate).order_by(DuelTemplate.id))
    templates = result.scalars().all()
    return [
        {"key": t.key, "name": t.name, "description": t.description,
         "duration_days": t.duration_days, "win_condition": t.win_condition,
         "default_stake": t.default_stake, "min_stake": t.min_stake,
         "max_stake": t.max_stake, "icon": t.icon}
        for t in templates
    ]

class DuelChallengeIn(BaseModel):
    opponent_id: int
    template_key: str
    stake_xp: int | None = None

@app.post("/api/duels/challenge")
async def challenge_friend(body: DuelChallengeIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    friendship = await session.scalar(
        select(Friendship).where(
            ((Friendship.user_id == user.id) & (Friendship.friend_id == body.opponent_id)) |
            ((Friendship.user_id == body.opponent_id) & (Friendship.friend_id == user.id)),
            Friendship.status == "accepted"
        )
    )
    if not friendship:
        raise HTTPException(400, "Вы не друзья")
    template = await session.scalar(select(DuelTemplate).where(DuelTemplate.key == body.template_key))
    if not template:
        raise HTTPException(404, "Шаблон дуэли не найден")
    stake = body.stake_xp or template.default_stake
    if not (template.min_stake <= stake <= template.max_stake):
        raise HTTPException(400, f"Ставка должна быть от {template.min_stake} до {template.max_stake} XP")
    if user.xp < stake:
        raise HTTPException(400, f"Недостаточно XP для ставки (нужно {stake}, у тебя {user.xp})")
    active = await session.scalar(
        select(Duel).where(
            ((Duel.challenger_id == user.id) & (Duel.opponent_id == body.opponent_id)) |
            ((Duel.challenger_id == body.opponent_id) & (Duel.opponent_id == user.id)),
            Duel.status.in_(["pending", "active"])
        )
    )
    if active:
        raise HTTPException(400, "У вас уже есть активная дуэль")
    ends_at = datetime.now(timezone.utc) + timedelta(days=template.duration_days)
    duel = Duel(
        challenger_id=user.id, opponent_id=body.opponent_id,
        template_key=template.key, stake_xp=stake, ends_at=ends_at, status="pending"
    )
    session.add(duel)
    await session.commit()
    await session.refresh(duel)
    return {"duel_id": duel.id, "ends_at": ends_at.isoformat()}

@app.post("/api/duels/{duel_id}/accept")
async def accept_duel(duel_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    duel = await session.get(Duel, duel_id)
    if not duel or duel.opponent_id != user.id:
        raise HTTPException(404, "Дуэль не найдена")
    if duel.status != "pending":
        raise HTTPException(400, "Дуэль уже начата или завершена")
    if user.xp < duel.stake_xp:
        raise HTTPException(400, "Недостаточно XP для ставки")
    duel.status = "active"
    challenger = await session.get(User, duel.challenger_id)
    s1 = DuelScore(duel_id=duel.id, user_id=duel.challenger_id, xp_at_start=challenger.xp)
    s2 = DuelScore(duel_id=duel.id, user_id=duel.opponent_id, xp_at_start=user.xp)
    session.add(s1)
    session.add(s2)
    await session.commit()
    return {"message": "Дуэль начата!"}

@app.post("/api/duels/{duel_id}/decline")
async def decline_duel(duel_id: int, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    duel = await session.get(Duel, duel_id)
    if not duel or duel.opponent_id != user.id:
        raise HTTPException(404, "Дуэль не найдена")
    if duel.status != "pending":
        raise HTTPException(400, "Дуэль уже начата")
    duel.status = "cancelled"
    await session.commit()
    return {"message": "Вызов отклонён"}

@app.get("/api/duels/active")
async def active_duels(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    result = await session.execute(
        select(Duel).options(selectinload(Duel.scores)).where(
            ((Duel.challenger_id == user.id) | (Duel.opponent_id == user.id)),
            Duel.status.in_(["pending", "active"])
        ).order_by(Duel.started_at.desc())
    )
    duels = result.scalars().all()
    out = []
    for d in duels:
        opponent_id = d.opponent_id if d.challenger_id == user.id else d.challenger_id
        opponent = await session.get(User, opponent_id)
        template = await session.scalar(select(DuelTemplate).where(DuelTemplate.key == d.template_key))
        my_score = next((s for s in d.scores if s.user_id == user.id), None)
        opp_score = next((s for s in d.scores if s.user_id != user.id), None)
        out.append({
            "duel_id": d.id, "status": d.status,
            "template": {"key": d.template_key, "name": template.name if template else d.template_key,
                        "icon": template.icon if template else "⚔️",
                        "win_condition": template.win_condition if template else "xp"},
            "opponent": {"id": opponent.id, "username": opponent.username,
                        "first_name": opponent.first_name, "level": opponent.level},
            "stake_xp": d.stake_xp, "ends_at": d.ends_at.isoformat(),
            "days_left": max(0, (d.ends_at - datetime.now(timezone.utc)).days),
        })
    return out

@app.get("/api/duels/history")
async def duel_history(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    result = await session.execute(
        select(Duel).options(selectinload(Duel.scores)).where(
            ((Duel.challenger_id == user.id) | (Duel.opponent_id == user.id)),
            Duel.status == "finished"
        ).order_by(Duel.ends_at.desc()).limit(20)
    )
    duels = result.scalars().all()
    out = []
    for d in duels:
        opponent_id = d.opponent_id if d.challenger_id == user.id else d.challenger_id
        opponent = await session.get(User, opponent_id)
        template = await session.scalar(select(DuelTemplate).where(DuelTemplate.key == d.template_key))
        out.append({
            "duel_id": d.id,
            "template": {"name": template.name if template else d.template_key,
                        "icon": template.icon if template else "⚔️"},
            "opponent": {"username": opponent.username, "first_name": opponent.first_name},
            "stake_xp": d.stake_xp, "winner_id": d.winner_id,
            "i_won": d.winner_id == user.id, "ended_at": d.ends_at.isoformat(),
        })
    return out
'''

# ======================================================================
# 4. ФОНОВЫЕ ЗАДАЧИ
# ======================================================================
SOCIAL_TASKS = r'''
"""Фоновые задачи для социальной механики."""
import asyncio
from datetime import datetime, timezone
from sqlalchemy import select, update
from backend.database.db import SessionLocal
from backend.database.models import Duel, DuelScore, User, XpEvent

async def finalize_finished_duels():
    async with SessionLocal() as s:
        now = datetime.now(timezone.utc)
        result = await s.execute(
            select(Duel).where(Duel.status == "active", Duel.ends_at <= now)
        )
        duels = result.scalars().all()
        for duel in duels:
            scores = await s.execute(select(DuelScore).where(DuelScore.duel_id == duel.id))
            scores = scores.scalars().all()
            if len(scores) != 2:
                continue
            for score in scores:
                user = await s.get(User, score.user_id)
                score.xp_at_end = user.xp
            s1, s2 = scores
            v1 = s1.xp_at_end - s1.xp_at_start
            v2 = s2.xp_at_end - s2.xp_at_start
            if v1 > v2:
                winner_id = s1.user_id
            elif v2 > v1:
                winner_id = s2.user_id
            else:
                winner_id = None
            duel.winner_id = winner_id
            duel.status = "finished"
        await s.commit()
        if duels:
            print(f"✅ Завершено дуэлей: {len(duels)}")

async def run_periodic_tasks():
    while True:
        try:
            await finalize_finished_duels()
        except Exception as e:
            print(f"⚠️  Ошибка в фоновых задачах: {e}")
        await asyncio.sleep(300)
'''

# ======================================================================
# 5. ИМПОРТЁР
# ======================================================================
IMPORTER = r'''
import asyncio, json
from pathlib import Path
from sqlalchemy import select
from backend.database.db import SessionLocal, init_db
from backend.database.models import DuelTemplate

ROOT = Path(__file__).resolve().parents[2]

async def run():
    await init_db()
    async with SessionLocal() as s:
        templates_file = ROOT / "content/duels/duel_templates.json"
        if not templates_file.exists():
            print(f"❌ Файл {templates_file} не найден")
            return
        templates = json.loads(templates_file.read_text(encoding="utf-8"))
        added = 0
        for t in templates:
            if await s.scalar(select(DuelTemplate).where(DuelTemplate.key == t["key"])):
                continue
            s.add(DuelTemplate(**t))
            added += 1
        await s.commit()
        print(f"✅ Шаблонов дуэлей добавлено: {added}")

if __name__ == "__main__":
    asyncio.run(run())
'''

# ======================================================================
# 6. УСТАНОВЩИК
# ======================================================================
def write(rel: str, text: str, overwrite=False):
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not overwrite:
        print(f"⏭  уже существует: {rel}")
        return
    path.write_text(text, encoding="utf-8")
    print(f"✅ создан: {rel}")


def main():
    if not (ROOT / "backend").is_dir():
        sys.exit("❌ Запускай файл из КОРНЯ репозитория (где папка backend).")

    write("content/duels/duel_templates.json",
          json.dumps(DUEL_TEMPLATES, ensure_ascii=False, indent=2), overwrite=True)

    mp = ROOT / "backend/database/models.py"
    txt = mp.read_text(encoding="utf-8")
    if MARK in txt:
        print("⏭  модели уже добавлены")
    else:
        mp.write_text(txt + "\n\n" + MARK + "\n" + MODELS, encoding="utf-8")
        print("✅ модели добавлены в models.py")

    ap = ROOT / "backend/api/main.py"
    txt = ap.read_text(encoding="utf-8")
    if MARK in txt:
        print("⏭  API уже добавлено")
    else:
        needle = '_dist = Path(__file__)'
        if needle not in txt:
            sys.exit("❌ Не найден маркер _dist в main.py")
        inject = ("\n" + MARK + "\n" + API_CODE + "\n")
        txt = txt.replace(needle, inject + needle, 1)
        ap.write_text(txt, encoding="utf-8")
        print("✅ API добавлено в main.py")

    write("backend/core/social_tasks.py", SOCIAL_TASKS, overwrite=True)
    write("backend/seed/import_social.py", IMPORTER, overwrite=True)

    print("\n🚀 Загрузка шаблонов дуэлей в PostgreSQL...")
    try:
        from backend.seed.import_social import run
        asyncio.run(run())
    except Exception as e:
        print(f"\n⚠️  Импорт не выполнен: {type(e).__name__}: {e}")
        print("Проверь: docker compose up -d db и DATABASE_URL в .env")
        print("Затем запусти вручную: python -m backend.seed.import_social")
        return

    print("\n" + "=" * 60)
    print("ГОТОВО.")
    print(f"Шаблонов дуэлей: {len(DUEL_TEMPLATES)}")
    print("\nПроверка API после перезапуска uvicorn:")
    print("  GET  /api/friends")
    print("  GET  /api/duels/templates")
    print("  POST /api/duels/challenge")
    print("=" * 60)


if __name__ == "__main__":
    main()
