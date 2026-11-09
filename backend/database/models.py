from datetime import date, datetime

from sqlalchemy import ARRAY, BigInteger, Boolean, Date, DateTime, Float, ForeignKey, Index, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from backend.database.db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger, unique=True, index=True)
    username: Mapped[str | None] = mapped_column(String(64))
    first_name: Mapped[str | None] = mapped_column(String(128))
    language_code: Mapped[str | None] = mapped_column(String(8))
    xp: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    level: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    # app preferences kept on the account: the Mini App's address (and so its browser storage) changes with the tunnel
    theme: Mapped[str | None] = mapped_column(String(8))
    accent: Mapped[str | None] = mapped_column(String(7))
    program_id: Mapped[int | None] = mapped_column(ForeignKey("programs.id", ondelete="SET NULL"))
    # earned every 7 days of streak (max 2); a missed day spends one instead of breaking the streak
    streak_freezes: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    # IANA zone of the phone, sent by the Mini App on every request: the user's "today" follows it (also when travelling)
    device_tz: Mapped[str | None] = mapped_column(String(64))
    invite_code: Mapped[str | None] = mapped_column(String(16), unique=True)  # t.me/<bot>?start=f<code> makes friends
    invited_by_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))  # gets XP once we fill the profile
    boost_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # x2 XP until then (duel win)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class Profile(Base):
    """Questionnaire answers. Separate table so existing databases pick it up via create_all."""

    __tablename__ = "profiles"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    sex: Mapped[str] = mapped_column(String(8))
    birth_year: Mapped[int] = mapped_column(Integer)
    height_cm: Mapped[int] = mapped_column(Integer)
    weight_kg: Mapped[float] = mapped_column(Float)
    activity: Mapped[str] = mapped_column(String(16))
    goal: Mapped[str] = mapped_column(String(16))
    # Extended questionnaire (Logos engine). Nullable: profiles saved before it stay valid.
    experience: Mapped[str | None] = mapped_column(String(16))
    equipment: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    sessions_per_week: Mapped[int | None] = mapped_column(Integer)
    session_minutes: Mapped[int | None] = mapped_column(Integer)
    allergies: Mapped[list[str] | None] = mapped_column(ARRAY(String))
    meals_per_day: Mapped[int | None] = mapped_column(Integer)
    sleep_hours: Mapped[float | None] = mapped_column(Float)
    stress: Mapped[str | None] = mapped_column(String(16))
    injury: Mapped[str | None] = mapped_column(String(16))  # None = no injuries; knees | back | shoulders | other
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class XpEvent(Base):
    """Ledger of granted XP. Unique (user_id, event_key) blocks double awards."""

    __tablename__ = "xp_events"
    __table_args__ = (UniqueConstraint("user_id", "event_key"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    event_type: Mapped[str] = mapped_column(String(64))
    event_key: Mapped[str] = mapped_column(String(128))
    xp: Mapped[int] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


# ---- Reference data (imported from content/ by backend/seed/import_data.py) ----


class Product(Base):
    __tablename__ = "products"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), index=True)
    brand: Mapped[str | None] = mapped_column(String(100))
    barcode: Mapped[str | None] = mapped_column(String(32), unique=True)
    # nutrition per 100 g
    kcal: Mapped[float] = mapped_column(Float)
    protein_g: Mapped[float] = mapped_column(Float, default=0)
    fat_g: Mapped[float] = mapped_column(Float, default=0)
    carbs_g: Mapped[float] = mapped_column(Float, default=0)
    category: Mapped[str | None] = mapped_column(String(100))
    # a typical serving, e.g. 350 g "порция" of a restaurant dish: lets the user log "1 порция" instead of grams
    portion_g: Mapped[float | None] = mapped_column(Float)
    portion_name: Mapped[str | None] = mapped_column(String(40))
    # NULL = shared catalog; otherwise a custom product (e.g. recognised by AI) visible only to its owner.
    owner_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    # Lower-cased in Python: Postgres with the C locale can't case-fold Cyrillic in ILIKE/lower().
    search_text: Mapped[str] = mapped_column(
        Text, default=lambda ctx: _search_text(ctx.get_current_parameters()), index=True
    )
    # name+brand is unique in the shared catalog only: several users may each keep their own "Пепперони" from "Додо"
    __table_args__ = (
        Index("uq_products_shared_name_brand", "name", "brand", unique=True, postgresql_where=owner_user_id.is_(None)),
    )


def _search_text(row: dict) -> str:
    return f"{row['name']} {row.get('brand') or ''}".lower().replace("ё", "е")


class Exercise(Base):
    __tablename__ = "exercises"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    owner_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    muscle_groups: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    equipment: Mapped[list[str]] = mapped_column(ARRAY(String), default=list)
    difficulty: Mapped[str] = mapped_column(String(20), default="beginner")
    description: Mapped[str | None] = mapped_column(Text)
    is_bodyweight: Mapped[bool] = mapped_column(Boolean, default=False)


class Program(Base):
    __tablename__ = "programs"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    owner_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    goal: Mapped[str] = mapped_column(String(50))
    level: Mapped[str] = mapped_column(String(20))
    days_per_week: Mapped[int] = mapped_column(Integer)
    description: Mapped[str | None] = mapped_column(Text)
    days: Mapped[list["ProgramDay"]] = relationship(cascade="all, delete-orphan", order_by="ProgramDay.day_order")


class ProgramDay(Base):
    __tablename__ = "program_days"

    id: Mapped[int] = mapped_column(primary_key=True)
    program_id: Mapped[int] = mapped_column(ForeignKey("programs.id", ondelete="CASCADE"), index=True)
    day_name: Mapped[str] = mapped_column(String(100))
    day_order: Mapped[int] = mapped_column(Integer)
    items: Mapped[list["ProgramExercise"]] = relationship(
        cascade="all, delete-orphan", order_by="ProgramExercise.position"
    )


class ProgramExercise(Base):
    __tablename__ = "program_exercises"

    id: Mapped[int] = mapped_column(primary_key=True)
    program_day_id: Mapped[int] = mapped_column(ForeignKey("program_days.id", ondelete="CASCADE"), index=True)
    exercise_id: Mapped[int] = mapped_column(ForeignKey("exercises.id"))
    sets: Mapped[int] = mapped_column(Integer)
    reps: Mapped[str] = mapped_column(String(30))  # "8-10", "Max", "45-60 сек"
    unit: Mapped[str] = mapped_column(String(10), default="reps", server_default="reps")
    superset: Mapped[int | None] = mapped_column(Integer)
    rest_seconds: Mapped[int] = mapped_column(Integer)
    planned_weights: Mapped[list[float | None] | None] = mapped_column(ARRAY(Float), nullable=True)
    notes: Mapped[str | None] = mapped_column(Text)
    position: Mapped[int] = mapped_column(Integer)
    exercise: Mapped[Exercise] = relationship()


# ---- User journals ----


class FoodLog(Base):
    __tablename__ = "food_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id"))
    amount_g: Mapped[float] = mapped_column(Float)
    meal_type: Mapped[str] = mapped_column(String(20))  # breakfast | lunch | dinner | snack
    # snacks can happen several times a day: each one is a separate group, labelled by its start time ("11:30")
    snack_slot: Mapped[str | None] = mapped_column(String(5))
    logged_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)
    product: Mapped[Product] = relationship()


class FavoriteProduct(Base):
    __tablename__ = "favorite_products"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    product: Mapped[Product] = relationship()


class UserBarcode(Base):
    """A barcode the user linked to their own product (not in the shared catalog or Open Food Facts)."""
    __tablename__ = "user_barcodes"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    barcode: Mapped[str] = mapped_column(String(32), primary_key=True)
    product_id: Mapped[int] = mapped_column(ForeignKey("products.id", ondelete="CASCADE"))


class ReminderSettings(Base):
    """What the bot may remind the user about, and when ("HH:MM" in the user's timezone)."""
    __tablename__ = "reminder_settings"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    meals: Mapped[bool] = mapped_column(Boolean, default=True)
    water: Mapped[bool] = mapped_column(Boolean, default=True)
    streak: Mapped[bool] = mapped_column(Boolean, default=True)
    breakfast_at: Mapped[str] = mapped_column(String(5), default="10:00")
    lunch_at: Mapped[str] = mapped_column(String(5), default="14:00")
    dinner_at: Mapped[str] = mapped_column(String(5), default="20:00")
    streak_at: Mapped[str] = mapped_column(String(5), default="21:00")
    weekly: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")  # Sunday summary
    weekly_at: Mapped[str] = mapped_column(String(5), default="19:00", server_default="19:00")


class FrozenDay(Base):
    """A missed day covered by a streak freeze."""
    __tablename__ = "frozen_days"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)


class UserAchievement(Base):
    __tablename__ = "user_achievements"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    code: Mapped[str] = mapped_column(String(32), primary_key=True)
    unlocked_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    seen: Mapped[bool] = mapped_column(Boolean, default=False)  # the unlock celebration was shown


class ReminderSent(Base):
    """One row per sent reminder, so a restart or a slow loop never sends the same one twice."""
    __tablename__ = "reminders_sent"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    key: Mapped[str] = mapped_column(String(40), primary_key=True)  # "2026-11-01:lunch"
    sent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WorkoutLog(Base):
    __tablename__ = "workout_logs"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    program_day_id: Mapped[int | None] = mapped_column(ForeignKey("program_days.id", ondelete="SET NULL"))
    title: Mapped[str] = mapped_column(String(200))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    sets: Mapped[list["WorkoutSet"]] = relationship(cascade="all, delete-orphan", order_by="WorkoutSet.id")


class WorkoutSet(Base):
    __tablename__ = "workout_sets"

    id: Mapped[int] = mapped_column(primary_key=True)
    workout_log_id: Mapped[int] = mapped_column(ForeignKey("workout_logs.id", ondelete="CASCADE"), index=True)
    exercise_id: Mapped[int] = mapped_column(ForeignKey("exercises.id"))
    set_number: Mapped[int] = mapped_column(Integer)
    reps: Mapped[int | None] = mapped_column(Integer)
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    weight_kg: Mapped[float] = mapped_column(Float, default=0)


class BodyMeasurement(Base):
    """One row per user per day; saving the same day again overwrites it."""

    __tablename__ = "body_measurements"
    __table_args__ = (UniqueConstraint("user_id", "measured_on"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    measured_on: Mapped[date] = mapped_column(Date)
    weight_kg: Mapped[float | None] = mapped_column(Float)
    waist_cm: Mapped[float | None] = mapped_column(Float)
    chest_cm: Mapped[float | None] = mapped_column(Float)
    hips_cm: Mapped[float | None] = mapped_column(Float)
    body_fat_pct: Mapped[float | None] = mapped_column(Float)


class AiRequest(Base):
    """One row per AI call — used for the per-user daily limit."""

    __tablename__ = "ai_requests"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), index=True)


class AiSummary(Base):
    """Cached AI summary so reopening the screen doesn't cost another request."""

    __tablename__ = "ai_summaries"
    __table_args__ = (UniqueConstraint("user_id", "period", "day"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    period: Mapped[str] = mapped_column(String(10))  # day | week
    day: Mapped[date] = mapped_column(Date)
    text: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class WaterIntake(Base):
    """Water drunk per user per day (one row per day)."""

    __tablename__ = "water_intake"
    __table_args__ = (UniqueConstraint("user_id", "day"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    day: Mapped[date] = mapped_column(Date)
    ml: Mapped[int] = mapped_column(Integer, default=0)


class WeeklyQuest(Base):
    """This week's tasks, picked once per user per week (so they don't change mid-week)."""

    __tablename__ = "weekly_quests"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    week: Mapped[date] = mapped_column(Date, primary_key=True)  # the Monday, in the user's timezone
    code: Mapped[str] = mapped_column(String(20), primary_key=True)
    target: Mapped[int] = mapped_column(Integer)
    slot: Mapped[int] = mapped_column(Integer)  # display order


class Visit(Base):
    """A day the user opened the Mini App (UTC day): for the owner's /stats (active users, retention)."""

    __tablename__ = "visits"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    day: Mapped[date] = mapped_column(Date, primary_key=True)


# ---- Social: friends, duels, and messages the bot should send ----

class Friendship(Base):
    """Stored both ways (a->b and b->a), so "my friends" is one simple query."""

    __tablename__ = "friendships"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    friend_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Duel(Base):
    """A friendly challenge: who gets more XP / workouts in `days` days. No stakes: the winner gets a bonus."""

    __tablename__ = "duels"

    id: Mapped[int] = mapped_column(primary_key=True)
    challenger_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    opponent_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    metric: Mapped[str] = mapped_column(String(10))  # xp | workouts
    days: Mapped[int] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(10), default="pending")  # pending | active | declined | done
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    starts_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    winner_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))  # null + done = a draw
    rewarded: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")  # the win passed the anti-abuse rules


class Outbox(Base):
    """Messages for the bot to send (the API has no bot connection). kind: text | share."""

    __tablename__ = "outbox"

    id: Mapped[int] = mapped_column(primary_key=True)
    telegram_id: Mapped[int] = mapped_column(BigInteger)
    kind: Mapped[str] = mapped_column(String(10), default="text")
    text: Mapped[str] = mapped_column(Text)
    user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))  # whose card to draw
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    sent_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), index=True)

