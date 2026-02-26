"""API routes for discussions."""
import json
import logging
from typing import List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models.models import User
from ..schemas.schemas import (
    DiscussionCreate,
    DiscussionResponse,
    DiscussionDetail,
    DiscussionEvent,
    AgentConfigUpdate,
    AgentConfigResponse,
    MaterialResponse,
    UserInputRequest,
    AttachMaterialsRequest,
    TruncateMessagesRequest,
    TruncateMessagesResponse,
)
from ..services.auth_service import get_current_user

logger = logging.getLogger(__name__)

_active_summarize_discussions: set[int] = set()
from ..services.discussion_service import (
    create_discussion,
    get_discussion,
    list_discussions,
    delete_discussion,
    run_discussion,
    stop_discussion,
    complete_discussion,
    submit_user_input,
    update_agent,
    prepare_agents,
    generate_title,
    upload_materials,
    list_materials,
    delete_material,
    attach_library_materials,
    summarize_discussion_messages,
    delete_user_message,
    truncate_messages_after,
    update_user_message,
    update_discussion_topic,
    reset_discussion,
    get_discussion_by_chat_code,
    create_or_get_discussion_share,
    revoke_discussion_share,
    get_active_discussion_share,
)

router = APIRouter(prefix="/api/discussions", tags=["discussions"])


def _is_owner_or_admin(discussion, user: User) -> bool:
    return bool(user and discussion and (discussion.owner_user_id == user.id or user.is_admin))


async def _get_owned_discussion_or_404(db: AsyncSession, discussion_id: int, user: User):
    discussion = await get_discussion(db, discussion_id)
    if not discussion or not _is_owner_or_admin(discussion, user):
        raise HTTPException(status_code=404, detail="Discussion not found")
    return discussion


async def _get_owned_discussion_by_code_or_404(db: AsyncSession, chat_code: str, user: User):
    discussion = await get_discussion_by_chat_code(db, chat_code)
    if not discussion or not _is_owner_or_admin(discussion, user):
        raise HTTPException(status_code=404, detail="Discussion not found")
    return discussion


@router.post("/", response_model=DiscussionResponse)
async def create_discussion_endpoint(
    data: DiscussionCreate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    discussion = await create_discussion(db, data, owner_user_id=current_user.id)
    return discussion


@router.get("/", response_model=list[DiscussionResponse])
async def list_discussions_endpoint(
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    owner_id = None if current_user.is_admin else current_user.id
    return await list_discussions(db, owner_user_id=owner_id)


@router.get("/{discussion_id}", response_model=DiscussionDetail)
async def get_discussion_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await _get_owned_discussion_or_404(db, discussion_id, current_user)


@router.get("/by-code/{chat_code}", response_model=DiscussionDetail)
async def get_discussion_by_code_endpoint(
    chat_code: str,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    return await _get_owned_discussion_by_code_or_404(db, chat_code, current_user)


@router.delete("/{discussion_id}", status_code=204)
async def delete_discussion_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    deleted = await delete_discussion(db, discussion_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Discussion not found")


@router.put("/{discussion_id}/agents/{agent_id}", response_model=AgentConfigResponse)
async def update_agent_endpoint(
    discussion_id: int,
    agent_id: int,
    data: AgentConfigUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    agent = await update_agent(db, discussion_id, agent_id, data)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.post("/{discussion_id}/prepare-agents", response_model=list[AgentConfigResponse])
async def prepare_agents_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    agents = await prepare_agents(db, discussion_id)
    return agents


@router.post("/{discussion_id}/generate-title")
async def generate_title_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    title = await generate_title(db, discussion_id)
    return {"title": title}


@router.post("/{discussion_id}/run")
async def run_discussion_endpoint(
    discussion_id: int,
    single_round: bool | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Run a discussion and stream events via SSE."""
    await _get_owned_discussion_or_404(db, discussion_id, current_user)

    async def event_stream():
        try:
            async for event in run_discussion(db, discussion_id, force_single_round=single_round):
                data = event.model_dump_json()
                yield f"data: {data}\n\n"
        except Exception as e:
            logger.warning("SSE stream error for discussion %d: %s", discussion_id, e)
        finally:
            logger.info("SSE stream closed for discussion %d", discussion_id)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/{discussion_id}/stop")
async def stop_discussion_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Pause a discussion so it can be resumed later."""
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    ok = await stop_discussion(db, discussion_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Discussion not found")
    return {"status": "paused"}


@router.post("/{discussion_id}/reset")
async def reset_discussion_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete all messages, reset status/round/summary, then restart."""
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    # Stop first if running
    await stop_discussion(db, discussion_id)
    discussion = await reset_discussion(db, discussion_id)
    if not discussion:
        raise HTTPException(status_code=404, detail="Discussion not found")
    return {"status": "reset"}


@router.post("/{discussion_id}/complete")
async def complete_discussion_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Manually mark a discussion as completed (end the cyclic loop)."""
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    ok = await complete_discussion(db, discussion_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Discussion not found")
    return {"status": "completed"}


@router.post("/{discussion_id}/summarize")
async def summarize_discussion_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Batch-summarize unsummarized messages, streaming progress via SSE."""
    await _get_owned_discussion_or_404(db, discussion_id, current_user)

    if discussion_id in _active_summarize_discussions:
        async def busy_stream():
            yield f"data: {DiscussionEvent(event_type='summary_complete', content='总结任务进行中，已忽略重复触发').model_dump_json()}\n\n"
        return StreamingResponse(busy_stream(), media_type="text/event-stream")

    _active_summarize_discussions.add(discussion_id)

    async def event_stream():
        try:
            async for event in summarize_discussion_messages(db, discussion_id):
                yield f"data: {event.model_dump_json()}\n\n"
        except Exception as e:
            logger.warning("Summarize stream error for discussion %d: %s", discussion_id, e)
            yield f"data: {DiscussionEvent(event_type='error', content=str(e)).model_dump_json()}\n\n"
        finally:
            _active_summarize_discussions.discard(discussion_id)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/{discussion_id}/user-input")
async def user_input_endpoint(
    discussion_id: int,
    data: UserInputRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Submit a user message into a running discussion."""
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    msg = await submit_user_input(db, discussion_id, data.content)
    return {"id": msg.id, "content": msg.content}


@router.delete("/{discussion_id}/messages/{message_id}", status_code=204)
async def delete_message_endpoint(
    discussion_id: int,
    message_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete a user message."""
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    deleted = await delete_user_message(db, discussion_id, message_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Message not found")


@router.post("/{discussion_id}/messages/truncate-after", response_model=TruncateMessagesResponse)
async def truncate_after_message_endpoint(
    discussion_id: int,
    data: TruncateMessagesRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Delete all messages after a message id (or all if message_id is null)."""
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    deleted_count = await truncate_messages_after(db, discussion_id, data.message_id)
    if deleted_count is None:
        raise HTTPException(status_code=404, detail="Discussion or message not found")
    return {"deleted_count": deleted_count}


@router.put("/{discussion_id}/messages/{message_id}")
async def update_message_endpoint(
    discussion_id: int,
    message_id: int,
    data: UserInputRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Update a user message."""
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    msg = await update_user_message(db, discussion_id, message_id, data.content)
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    return {"id": msg.id, "content": msg.content}


@router.put("/{discussion_id}/topic")
async def update_topic_endpoint(
    discussion_id: int,
    data: UserInputRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    disc = await update_discussion_topic(db, discussion_id, data.content)
    if not disc:
        raise HTTPException(status_code=404, detail="Discussion not found")
    return {"id": disc.id, "topic": disc.topic}


# --- Material endpoints ---

@router.post("/{discussion_id}/materials", response_model=list[MaterialResponse])
async def upload_materials_endpoint(
    discussion_id: int,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    materials = await upload_materials(db, discussion_id, files)
    return materials


@router.get("/{discussion_id}/materials", response_model=list[MaterialResponse])
async def list_materials_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    return await list_materials(db, discussion_id)


@router.delete("/{discussion_id}/materials/{material_id}", status_code=204)
async def delete_material_endpoint(
    discussion_id: int,
    material_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    deleted = await delete_material(db, discussion_id, material_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Material not found")


@router.post("/{discussion_id}/attach-materials", response_model=list[MaterialResponse])
async def attach_materials_endpoint(
    discussion_id: int,
    data: AttachMaterialsRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    materials = await attach_library_materials(db, discussion_id, data.material_ids)
    return materials


@router.get("/{discussion_id}/share")
async def get_share_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    share = await get_active_discussion_share(db, discussion_id)
    if not share:
        return {"active": False, "share_code": None}
    return {"active": True, "share_code": share.share_code}


@router.post("/{discussion_id}/share")
async def create_share_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    share = await create_or_get_discussion_share(db, discussion_id, current_user.id)
    return {"active": True, "share_code": share.share_code}


@router.delete("/{discussion_id}/share")
async def revoke_share_endpoint(
    discussion_id: int,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    await _get_owned_discussion_or_404(db, discussion_id, current_user)
    ok = await revoke_discussion_share(db, discussion_id)
    return {"ok": ok}
