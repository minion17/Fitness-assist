"""The bot in group chats: added → a hello with "Участвую"; /top, /join, /leave, /setly. Everything else in a group is
ignored (privacy mode leaves the bot only commands and replies anyway; the food parser is for private chats only).
The weekly posts are in backend.api.groups."""
import html
import logging

from aiogram import F, Router
from aiogram.filters import Command
from aiogram.types import CallbackQuery, ChatMemberUpdated, InlineKeyboardButton, InlineKeyboardMarkup, Message
from sqlalchemy import func, select

from backend.api import groups
from backend.api.social import name
from backend.database.db import SessionLocal
from backend.database.models import GroupChat, GroupMember, User

log = logging.getLogger("bot.groups")
router = Router()
GROUPS = {"group", "supergroup"}
router.message.filter(F.chat.type.in_(GROUPS))
router.callback_query.filter(F.message.chat.type.in_(GROUPS))

HELLO = ("Всем привет! 👋 Я Setly, считаю калории, тренировки и воду.\n\n"
         "Давайте соревноваться: я веду рейтинг этого чата за неделю. Очки — это XP Setly: за тренировки, записи еды, воду "
         "и привычки. В понедельник утром итоги и чемпион недели, в четверг сводка, кто кого догоняет.\n\n"
         "Сюда же можно прислать список покупок из рациона Setly, купленное отмечается кнопками.\n\n"
         "Жмите «Участвую». Кто ещё не в Setly, жмите «Открыть Setly».\n\n"
         "/top — рейтинг сейчас · /join — участвовать · /leave — выйти")


def keyboard(g: GroupChat) -> InlineKeyboardMarkup:
    rows = [[InlineKeyboardButton(text="✋ Участвую", callback_data="gj")]]
    if link := groups.join_link(g):
        rows.append([InlineKeyboardButton(text="Открыть Setly", url=link)])
    return InlineKeyboardMarkup(inline_keyboard=rows)


def link_keyboard(g: GroupChat) -> InlineKeyboardMarkup | None:
    link = groups.join_link(g)
    return InlineKeyboardMarkup(inline_keyboard=[[InlineKeyboardButton(text="Открыть Setly", url=link)]]) if link else None


@router.my_chat_member()
async def membership(event: ChatMemberUpdated) -> None:
    if event.chat.type not in GROUPS:
        return
    status = event.new_chat_member.status
    async with SessionLocal() as s:
        if status in ("member", "administrator"):
            if event.old_chat_member.status in ("member", "administrator"):
                return  # e.g. made an admin: already here
            adder = await s.scalar(select(User).where(User.telegram_id == event.from_user.id))
            g = await groups.added(s, event.chat.id, event.chat.title or "", adder)
            await event.bot.send_message(event.chat.id, HELLO, reply_markup=keyboard(g))
        else:  # left or kicked: no more posts
            g = await s.scalar(select(GroupChat).where(GroupChat.chat_id == event.chat.id))
            if g:
                g.active = False
                await s.commit()


async def group_of(s, chat) -> GroupChat:
    """The chat's group; a chat the bot was in before this feature (no my_chat_member seen) is registered on first use."""
    g = await s.scalar(select(GroupChat).where(GroupChat.chat_id == chat.id))
    return g or await groups.added(s, chat.id, chat.title or "", None)


@router.message(F.migrate_to_chat_id)
async def migrated(message: Message) -> None:
    """A group became a supergroup: a new chat id, the same rating."""
    async with SessionLocal() as s:
        g = await s.scalar(select(GroupChat).where(GroupChat.chat_id == message.chat.id))
        if g:
            g.chat_id = message.migrate_to_chat_id
            await s.commit()


async def enter(s, g: GroupChat, tg_user) -> tuple[User | None, bool]:
    """(user, joined now). None: not a Setly user yet."""
    user = await s.scalar(select(User).where(User.telegram_id == tg_user.id))
    if user is None:
        return None, False
    new = await groups.join(s, g, user)
    await s.commit()
    return user, new


async def count(s, g: GroupChat) -> int:
    return await s.scalar(select(func.count()).where(GroupMember.group_id == g.id))


@router.callback_query(F.data == "gj")
async def join_button(call: CallbackQuery) -> None:
    async with SessionLocal() as s:
        g = await group_of(s, call.message.chat)
        user, new = await enter(s, g, call.from_user)
        n = await count(s, g)
    if user is None:  # Telegram opens the bot with the parameter: /start there joins this chat
        await call.answer(url=groups.join_link(g)) if groups.join_link(g) else await call.answer("Сначала открой @Setly в личке", show_alert=True)
        return
    await call.answer("Ты в рейтинге! 💪" if new else "Ты уже участвуешь")
    if new:
        await call.message.answer(f"✋ {html.escape(name(user))} в игре! Участников: {n}.")


@router.message(Command("join"))
async def join_command(message: Message) -> None:
    async with SessionLocal() as s:
        g = await group_of(s, message.chat)
        user, new = await enter(s, g, message.from_user)
        n = await count(s, g)
    if user is None:
        await message.reply("Сначала открой Setly, и сразу попадёшь в рейтинг этого чата.", reply_markup=link_keyboard(g))
    else:
        await message.reply(f"✋ {html.escape(name(user))} в игре! Участников: {n}." if new else "Ты уже в рейтинге. Как дела: /top")


@router.message(Command("leave"))
async def leave_command(message: Message) -> None:
    async with SessionLocal() as s:
        g = await group_of(s, message.chat)
        user = await s.scalar(select(User).where(User.telegram_id == message.from_user.id))
        m = user and await s.get(GroupMember, (g.id, user.id))
        if m:
            await s.delete(m)
            await s.commit()
    await message.reply("Готово, тебя больше нет в рейтинге чата. Вернуться — /join" if m else "Тебя и так нет в рейтинге. Участвовать — /join")


@router.message(Command("top"))
async def top_command(message: Message) -> None:
    async with SessionLocal() as s:
        g = await group_of(s, message.chat)
        text = await groups.board_text(s, g)
    await message.answer(text, reply_markup=link_keyboard(g))


@router.message(Command("setly", "help"))  # not "start": adding by a startgroup link sends it right after the hello
async def help_command(message: Message) -> None:
    async with SessionLocal() as s:
        g = await group_of(s, message.chat)
    await message.answer(HELLO, reply_markup=keyboard(g))
