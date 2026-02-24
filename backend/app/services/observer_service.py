"""Observer service — independent observer chat panel for discussions."""
import asyncio
import logging
from datetime import datetime, timezone
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, delete
from sqlalchemy.orm import selectinload

from ..models.models import Discussion, Message, ObserverMessage, LLMProvider, LLMModel
from ..schemas.schemas import ObserverChatRequest, ObserverEvent
from .llm_service import call_llm_stream

logger = logging.getLogger(__name__)

OBSERVER_SYSTEM_PROMPT = """你是一位独立的圆桌讨论观察员。你能看到讨论中所有参与者的发言，但你不参与讨论本身。

你的职责是：
1. 客观分析讨论中各方的观点和论据
2. 指出讨论中的亮点、盲点和逻辑漏洞
3. 回答用户关于讨论内容的任何问题
4. 提供独立的、有深度的见解

请用简洁、专业的语言回答。如果讨论还在进行中，请基于目前已有的内容进行分析。"""

OBSERVER_MAX_CONTEXT_CHARS = 60000
OBSERVER_MAX_HISTORY_TURNS = 12


async def get_observer_history(db: AsyncSession, discussion_id: int) -> list[ObserverMessage]:
    result = await db.execute(
        select(ObserverMessage)
        .where(ObserverMessage.discussion_id == discussion_id)
        .order_by(ObserverMessage.created_at)
    )
    return list(result.scalars().all())


async def clear_observer_history(db: AsyncSession, discussion_id: int) -> None:
    await db.execute(
        delete(ObserverMessage).where(ObserverMessage.discussion_id == discussion_id)
    )
    await db.commit()


def _build_discussion_context(
    discussion: Discussion,
    messages: list[Message],
    max_chars: int = OBSERVER_MAX_CONTEXT_CHARS,
) -> str:
    """Build a bounded context window for observer chat (latest-first truncation)."""
    header_lines = [f"讨论主题: {discussion.topic}", f"讨论模式: {discussion.mode.value}", ""]

    selected_lines_reversed: list[str] = []
    consumed = 0
    selected_count = 0

    for msg in reversed(messages):
        role_label = {"host": "主持人", "panelist": "专家", "critic": "批评家", "user": "用户"}.get(msg.agent_role.value, msg.agent_role.value)
        text = (msg.summary or msg.content or "").strip()
        line = f"[{role_label} - {msg.agent_name}] {text}"
        line_len = len(line) + 1

        if consumed + line_len > max_chars:
            # Keep latest contiguous window; stop once budget is exhausted.
            break
        selected_lines_reversed.append(line)
        consumed += line_len
        selected_count += 1

    selected_lines = list(reversed(selected_lines_reversed))
    omitted = max(0, len(messages) - selected_count)

    lines = header_lines
    if omitted > 0:
        lines.append(f"（上下文已裁剪，省略较早消息 {omitted} 条，仅保留最近 {selected_count} 条）")
        lines.append("")
    lines.extend(selected_lines)

    if discussion.final_summary:
        final_summary = discussion.final_summary.strip()
        if len(final_summary) > 4000:
            final_summary = final_summary[:4000] + "..."
        lines.append(f"\n最终总结: {final_summary}")
    return "\n".join(lines)


async def _resolve_llm_config(db: AsyncSession, req: ObserverChatRequest) -> dict:
    """Resolve api_key and base_url from LLMProvider table if provider_id is given."""
    config = {"provider": req.provider, "model": req.model, "api_key": None, "base_url": None}
    if req.provider_id:
        result = await db.execute(
            select(LLMProvider).where(LLMProvider.id == req.provider_id)
        )
        prov = result.scalar_one_or_none()
        if prov:
            config["api_key"] = prov.api_key
            config["base_url"] = prov.base_url
    return config


async def chat_with_observer(
    db: AsyncSession, discussion_id: int, req: ObserverChatRequest
) -> AsyncGenerator[ObserverEvent, None]:
    """Stream observer response as ObserverEvent chunks."""
    # 1. Load discussion + messages
    result = await db.execute(
        select(Discussion)
        .options(selectinload(Discussion.messages))
        .where(Discussion.id == discussion_id)
    )
    discussion = result.scalar_one_or_none()
    if not discussion:
        yield ObserverEvent(event_type="error", content="讨论不存在")
        return

    # 2. Save user message
    user_msg = ObserverMessage(
        discussion_id=discussion_id, role="user", content=req.content,
        created_at=datetime.now(timezone.utc),
    )
    db.add(user_msg)
    await db.commit()
    await db.refresh(user_msg)

    # 3. Build LLM messages
    context = _build_discussion_context(discussion, discussion.messages)
    observer_history = await get_observer_history(db, discussion_id)

    logger.info(
        "Observer context for discussion %d: %d messages, %d chars, provider=%s model=%s",
        discussion_id, len(discussion.messages), len(context), req.provider, req.model,
    )

    # Put discussion context as a separate user message instead of stuffing it
    # all into system prompt — some providers/models (especially GPT via proxies)
    # truncate or ignore long system messages.
    system_content = OBSERVER_SYSTEM_PROMPT
    context_msg = f"--- 以下是当前讨论的完整内容，请基于这些内容回答我的问题 ---\n\n{context}"
    llm_messages = [
        {"role": "system", "content": system_content},
        {"role": "user", "content": context_msg},
        {"role": "assistant", "content": "好的，我已经仔细阅读了以上讨论的全部内容。请问你想了解什么？"},
    ]
    # Add prior observer conversation (skip the just-added user message — it goes last)
    # Keep only recent turns to avoid prompt explosion.
    history_tail = observer_history[-OBSERVER_MAX_HISTORY_TURNS:]
    for om in history_tail:
        if om.id == user_msg.id:
            continue
        llm_messages.append({
            "role": "user" if om.role == "user" else "assistant",
            "content": om.content,
        })
    llm_messages.append({"role": "user", "content": req.content})

    # 4. Resolve LLM config
    config = await _resolve_llm_config(db, req)

    # 5. Stream via queue
    queue: asyncio.Queue = asyncio.Queue()
    full_text_parts: list[str] = []

    async def on_chunk(chunk_text: str, total_chars: int):
        full_text_parts.append(chunk_text)
        await queue.put(ObserverEvent(event_type="chunk", content=chunk_text))

    async def run_llm():
        try:
            await call_llm_stream(
                provider=config["provider"],
                model=config["model"],
                messages=llm_messages,
                api_key=config["api_key"],
                base_url=config["base_url"],
                on_chunk=on_chunk,
            )
            await queue.put(ObserverEvent(event_type="done"))
        except Exception as e:
            logger.error("Observer LLM error: %s", e)
            await queue.put(ObserverEvent(event_type="error", content=str(e)))

    task = asyncio.create_task(run_llm())

    try:
        while True:
            event = await queue.get()
            yield event
            if event.event_type in ("done", "error"):
                break
    finally:
        if not task.done():
            task.cancel()

    # 6. Save observer reply to DB
    full_text = "".join(full_text_parts)
    if full_text:
        observer_msg = ObserverMessage(
            discussion_id=discussion_id, role="observer", content=full_text,
            created_at=datetime.now(timezone.utc),
        )
        db.add(observer_msg)
        await db.commit()
