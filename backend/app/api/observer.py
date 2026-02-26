"""API routes for the observer chat panel."""
import logging
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models.models import User
from ..schemas.schemas import (
    ObserverChatRequest,
    ObserverMessageResponse,
    TruncateMessagesRequest,
    TruncateMessagesResponse,
    UserInputRequest,
)
from ..services.auth_service import get_current_user
from ..services.discussion_service import get_discussion
from ..services.observer_service import (
    get_observer_history,
    clear_observer_history,
    chat_with_observer,
    update_observer_user_message,
    truncate_observer_messages_after,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/discussions/{discussion_id}/observer", tags=["observer"])


async def _ensure_owned_discussion(db: AsyncSession, discussion_id: int, user: User):
    discussion = await get_discussion(db, discussion_id)
    if not discussion or (discussion.owner_user_id != user.id and not user.is_admin):
        raise HTTPException(status_code=404, detail="Discussion not found")
    return discussion


@router.get("/history", response_model=list[ObserverMessageResponse])
async def observer_history(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Get observer chat history for a discussion."""
    await _ensure_owned_discussion(db, discussion_id, current_user)
    messages = await get_observer_history(db, discussion_id)
    return messages


@router.delete("/history", status_code=204)
async def clear_history(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Clear observer chat history for a discussion."""
    await _ensure_owned_discussion(db, discussion_id, current_user)
    await clear_observer_history(db, discussion_id)


@router.put("/messages/{message_id}", response_model=ObserverMessageResponse)
async def update_observer_message(
    discussion_id: int,
    message_id: int,
    data: UserInputRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Edit a user message in observer chat history."""
    await _ensure_owned_discussion(db, discussion_id, current_user)
    msg = await update_observer_user_message(db, discussion_id, message_id, data.content)
    if not msg:
        raise HTTPException(status_code=404, detail="Observer user message not found")
    return msg


@router.post("/messages/truncate-after", response_model=TruncateMessagesResponse)
async def truncate_observer_after_message(
    discussion_id: int,
    data: TruncateMessagesRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete observer messages after the given message id."""
    await _ensure_owned_discussion(db, discussion_id, current_user)
    if data.message_id is None:
        raise HTTPException(status_code=422, detail="message_id is required")
    deleted_count = await truncate_observer_messages_after(db, discussion_id, data.message_id)
    if deleted_count is None:
        raise HTTPException(status_code=404, detail="Observer message not found")
    return {"deleted_count": deleted_count}


@router.post("/chat")
async def observer_chat(
    discussion_id: int,
    req: ObserverChatRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Stream observer response via SSE."""
    await _ensure_owned_discussion(db, discussion_id, current_user)
    logger.info(
        "Observer chat request received: discussion_id=%s provider=%s model=%s provider_id=%s reuse_message_id=%s",
        discussion_id, req.provider, req.model, req.provider_id, req.reuse_message_id,
    )
    async def event_stream():
        try:
            async for event in chat_with_observer(db, discussion_id, req):
                yield f"data: {event.model_dump_json()}\n\n"
        except Exception as e:
            logger.warning("Observer SSE error for discussion %d: %s", discussion_id, e)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
