"""Thin wrapper over the Claude API. Everything AI-specific lives here so it's easy to swap or fake in tests."""
import anthropic

from backend.core.config import settings


class AIUnavailable(RuntimeError):
    pass


_client: anthropic.AsyncAnthropic | None = None


def _get_client() -> anthropic.AsyncAnthropic:
    global _client
    if not settings.anthropic_api_key:
        raise AIUnavailable("ANTHROPIC_API_KEY не задан")
    if _client is None:
        _client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key, timeout=60, max_retries=2)
    return _client


async def call_tool(system: str, content: list[dict], tool: dict, max_tokens: int = 2000) -> dict:
    """Force the model to answer by calling `tool`; returns the tool input (validated JSON object)."""
    try:
        msg = await _get_client().messages.create(
            model=settings.ai_model, max_tokens=max_tokens, system=system,
            tools=[tool], tool_choice={"type": "tool", "name": tool["name"]},
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.APIError as e:
        raise AIUnavailable(f"AI-сервис ответил ошибкой: {type(e).__name__}") from e
    for block in msg.content:
        if block.type == "tool_use":
            return block.input
    raise AIUnavailable("AI не вернул результат")


async def call_text(system: str, content: list[dict], max_tokens: int = 700) -> str:
    try:
        msg = await _get_client().messages.create(
            model=settings.ai_model, max_tokens=max_tokens, system=system,
            messages=[{"role": "user", "content": content}],
        )
    except anthropic.APIError as e:
        raise AIUnavailable(f"AI-сервис ответил ошибкой: {type(e).__name__}") from e
    return "".join(b.text for b in msg.content if b.type == "text").strip()
