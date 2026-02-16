"""API routes for the observer chat panel."""
import logging
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..schemas.schemas import ObserverChatRequest, ObserverMessageResponse
from ..services.observer_service import get_observer_history, clear_observer_history, chat_with_observer

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/discussions/{discussion_id}/observer", tags=["observer"])


@router.get("/history", response_model=list[ObserverMessageResponse])
async def observer_history(discussion_id: int, db: AsyncSession = Depends(get_db)):
    """Get observer chat history for a discussion."""
    messages = await get_observer_history(db, discussion_id)
    return messages


@router.delete("/history", status_code=204)
async def clear_history(discussion_id: int, db: AsyncSession = Depends(get_db)):
    """Clear observer chat history for a discussion."""
    await clear_observer_history(db, discussion_id)


@router.post("/chat")
async def observer_chat(discussion_id: int, req: ObserverChatRequest, db: AsyncSession = Depends(get_db)):
    """Stream observer response via SSE."""
    async def event_stream():
        try:
            async for event in chat_with_observer(db, discussion_id, req):
                yield f"data: {event.model_dump_json()}\n\n"
        except Exception as e:
            logger.warning("Observer SSE error for discussion %d: %s", discussion_id, e)

    return StreamingResponse(event_stream(), media_type="text/event-stream")
