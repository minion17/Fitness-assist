"""The meal plan's shopping list, sent to a chat: the family group (the bot is in it) or the user's own chat with the bot.
In the chat it's one message with a button per item; whoever buys something taps it, and the message is redrawn for
everyone with who took what — a shared list without another app."""
import html

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from backend.api.deps import get_or_create_user, telegram_user
from backend.database.db import AsyncSession, get_session
from backend.database.models import GroupChat, GroupMember, Outbox, ShoppingList

router = APIRouter(prefix="/api/shopping")
MAX_ITEMS = 90  # Telegram allows 100 buttons under a message


class Item(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    qty: str = Field(default="", max_length=20)


class ShareIn(BaseModel):
    group_id: int | None = None  # None: to the user's own chat with the bot
    title: str = Field(default="Список покупок", min_length=1, max_length=100)
    items: list[Item] = Field(min_length=1, max_length=MAX_ITEMS)


@router.get("/chats")
async def chats(tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    """Where the list can go: the user's group chats with the bot."""
    user = await get_or_create_user(tg, session)
    rows = await session.scalars(select(GroupChat).join(GroupMember, GroupMember.group_id == GroupChat.id)
                                 .where(GroupMember.user_id == user.id, GroupChat.active.is_(True)).order_by(GroupChat.title))
    return [{"id": g.id, "title": g.title} for g in rows]


@router.post("/share")
async def share(body: ShareIn, tg: dict = Depends(telegram_user), session: AsyncSession = Depends(get_session)):
    user = await get_or_create_user(tg, session)
    chat_id = user.telegram_id
    if body.group_id is not None:
        g = await session.get(GroupChat, body.group_id)
        if g is None or not g.active or not await session.get(GroupMember, (g.id, user.id)):
            raise HTTPException(404, "Этого чата нет среди твоих — добавь бота в чат и нажми там «Участвую»")
        chat_id = g.chat_id
    sl = ShoppingList(user_id=user.id, chat_id=chat_id, title=body.title.strip(),
                      items=[{"name": i.name.strip(), "qty": i.qty.strip(), "done": False, "by": None} for i in body.items])
    session.add(sl)
    await session.flush()
    session.add(Outbox(telegram_id=chat_id, kind="shoplist", text=str(sl.id), user_id=user.id))  # the bot sends and keeps the message id
    await session.commit()
    return {"ok": True, "id": sl.id}


def render(sl: ShoppingList, author: str) -> tuple[str, list[list[tuple[str, str]]]]:
    """The message: what's left and what's bought (and by whom); buttons: (label, callback data), two a row."""
    left = [i for i in sl.items if not i["done"]]
    done = [i for i in sl.items if i["done"]]
    line = lambda i: f"{html.escape(i['name'])}" + (f" — {html.escape(i['qty'])}" if i["qty"] else "")  # noqa: E731
    text = f"🛒 <b>{html.escape(sl.title)}</b> · от {html.escape(author)}\n"
    if left:
        text += f"\nОсталось купить ({len(left)}):\n" + "\n".join(f"⬜ {line(i)}" for i in left)
    else:
        text += "\n🎉 Всё куплено!"
    if done:
        text += f"\n\nКуплено ({len(done)}):\n" + "\n".join(f"✅ <s>{line(i)}</s>" + (f" · {html.escape(i['by'])}" if i.get("by") else "") for i in done)
    text += "\n\nКупил — нажми на товар внизу, список обновится у всех."
    if len(text) > 4000:  # Telegram's limit: the bought part shrinks to a count
        text = text[:text.find("\n\nКуплено")] + f"\n\nКуплено: {len(done)}"
    buttons = [(("✅ " if i["done"] else "") + i["name"][:28], f"sl:{sl.id}:{k}") for k, i in enumerate(sl.items)]
    return text, [buttons[k:k + 2] for k in range(0, len(buttons), 2)]


def toggle(sl: ShoppingList, index: int, who: str) -> bool:
    """Bought / not bought; False for a stale button."""
    if not 0 <= index < len(sl.items):
        return False
    items = [dict(i) for i in sl.items]  # a new list: the JSON column notices the change
    items[index]["done"] = not items[index]["done"]
    items[index]["by"] = who if items[index]["done"] else None
    sl.items = items
    return True
