"""API routes for discussions."""
import json
import logging
from typing import List
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..schemas.schemas import DiscussionCreate, DiscussionResponse, DiscussionDetail, DiscussionEvent, AgentConfigUpdate, AgentConfigResponse, MaterialResponse, UserInputRequest

logger = logging.getLogger(__name__)
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
)

router = APIRouter(prefix="/api/discussions", tags=["discussions"])


@router.post("/", response_model=DiscussionResponse)
async def create_discussion_endpoint(data: DiscussionCreate, db: AsyncSession = Depends(get_db)):
    discussion = await create_discussion(db, data)
    return discussion


@router.get("/", response_model=list[DiscussionResponse])
async def list_discussions_endpoint(db: AsyncSession = Depends(get_db)):
    return await list_discussions(db)


@router.get("/{discussion_id}", response_model=DiscussionDetail)
async def get_discussion_endpoint(discussion_id: int, db: AsyncSession = Depends(get_db)):
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        raise HTTPException(status_code=404, detail="Discussion not found")
    return discussion


@router.delete("/{discussion_id}", status_code=204)
async def delete_discussion_endpoint(discussion_id: int, db: AsyncSession = Depends(get_db)):
    deleted = await delete_discussion(db, discussion_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Discussion not found")


@router.put("/{discussion_id}/agents/{agent_id}", response_model=AgentConfigResponse)
async def update_agent_endpoint(
    discussion_id: int, agent_id: int, data: AgentConfigUpdate, db: AsyncSession = Depends(get_db)
):
    agent = await update_agent(db, discussion_id, agent_id, data)
    if not agent:
        raise HTTPException(status_code=404, detail="Agent not found")
    return agent


@router.post("/{discussion_id}/prepare-agents", response_model=list[AgentConfigResponse])
async def prepare_agents_endpoint(discussion_id: int, db: AsyncSession = Depends(get_db)):
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        raise HTTPException(status_code=404, detail="Discussion not found")
    agents = await prepare_agents(db, discussion_id)
    return agents


@router.post("/{discussion_id}/generate-title")
async def generate_title_endpoint(discussion_id: int, db: AsyncSession = Depends(get_db)):
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        raise HTTPException(status_code=404, detail="Discussion not found")
    title = await generate_title(db, discussion_id)
    return {"title": title}


@router.post("/{discussion_id}/run")
async def run_discussion_endpoint(discussion_id: int, db: AsyncSession = Depends(get_db)):
    """Run a discussion and stream events via SSE."""
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        raise HTTPException(status_code=404, detail="Discussion not found")

    async def event_stream():
        try:
            async for event in run_discussion(db, discussion_id):
                data = event.model_dump_json()
                yield f"data: {data}\n\n"
        except Exception as e:
            logger.warning("SSE stream error for discussion %d: %s", discussion_id, e)
        finally:
            logger.info("SSE stream closed for discussion %d", discussion_id)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.post("/{discussion_id}/stop")
async def stop_discussion_endpoint(discussion_id: int, db: AsyncSession = Depends(get_db)):
    """Stop a running discussion — cancels the graph task and resets status."""
    ok = await stop_discussion(db, discussion_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Discussion not found")
    return {"status": "stopped"}


@router.post("/{discussion_id}/complete")
async def complete_discussion_endpoint(discussion_id: int, db: AsyncSession = Depends(get_db)):
    """Manually mark a discussion as completed (end the cyclic loop)."""
    ok = await complete_discussion(db, discussion_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Discussion not found")
    return {"status": "completed"}


@router.post("/{discussion_id}/user-input")
async def user_input_endpoint(discussion_id: int, data: UserInputRequest, db: AsyncSession = Depends(get_db)):
    """Submit a user message into a running discussion."""
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        raise HTTPException(status_code=404, detail="Discussion not found")
    msg = await submit_user_input(db, discussion_id, data.content)
    return {"id": msg.id, "content": msg.content}


# --- Material endpoints ---

@router.post("/{discussion_id}/materials", response_model=list[MaterialResponse])
async def upload_materials_endpoint(
    discussion_id: int,
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
):
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        raise HTTPException(status_code=404, detail="Discussion not found")
    materials = await upload_materials(db, discussion_id, files)
    return materials


@router.get("/{discussion_id}/materials", response_model=list[MaterialResponse])
async def list_materials_endpoint(discussion_id: int, db: AsyncSession = Depends(get_db)):
    return await list_materials(db, discussion_id)


@router.delete("/{discussion_id}/materials/{material_id}", status_code=204)
async def delete_material_endpoint(discussion_id: int, material_id: int, db: AsyncSession = Depends(get_db)):
    deleted = await delete_material(db, discussion_id, material_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Material not found")
