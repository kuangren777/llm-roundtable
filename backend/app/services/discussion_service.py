"""Discussion service — orchestrates DB operations and the LangGraph engine."""
import asyncio
import json
import os
import shutil
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from fastapi import UploadFile

from ..models.models import Discussion, AgentConfig, Message, LLMProvider, LLMModel, DiscussionMaterial, DiscussionStatus, DiscussionMode, AgentRole
from ..schemas.schemas import DiscussionCreate, AgentConfigUpdate, DiscussionEvent
from .discussion_engine import build_discussion_graph, AgentInfo, DiscussionState, progress_queue_var
from .mode_templates import get_mode_template, assign_llms_to_agents
from .planner import plan_agents
from .llm_service import call_llm

GRAPH_EVENT = "graph_event"
PROGRESS_EVENT = "progress_event"
GRAPH_DONE = "graph_done"

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "uploads")
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
ALLOWED_FILE_EXTS = {".txt", ".md", ".pdf", ".docx"}
ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}


async def create_discussion(db: AsyncSession, data: DiscussionCreate) -> Discussion:
    # Snapshot global LLM providers + models into discussion.llm_configs
    result = await db.execute(
        select(LLMProvider)
        .options(selectinload(LLMProvider.models))
        .order_by(LLMProvider.created_at)
    )
    providers = list(result.scalars().all())

    # Build model ID → config lookup
    all_models = {}
    for p in providers:
        for m in p.models:
            all_models[m.id] = {
                "provider": p.provider,
                "model": m.model,
                "api_key": p.api_key,
                "base_url": p.base_url,
            }

    # Filter to selected models if specified, otherwise use all
    if data.selected_model_ids:
        llm_configs_raw = [all_models[mid] for mid in data.selected_model_ids if mid in all_models]
    else:
        llm_configs_raw = list(all_models.values())

    # Put host model first so round-robin assigns it to the host agent
    if data.host_model_id and data.host_model_id in all_models:
        host_cfg = all_models[data.host_model_id]
        llm_configs_raw = [host_cfg] + [c for c in llm_configs_raw if c is not host_cfg]

    discussion = Discussion(
        topic=data.topic,
        mode=data.mode,
        max_rounds=data.max_rounds,
        llm_configs=llm_configs_raw,
        status=DiscussionStatus.CREATED,
    )
    db.add(discussion)
    await db.flush()

    # Custom mode: create agents from explicit agent list
    if data.mode == DiscussionMode.CUSTOM and data.agents:
        for agent_data in data.agents:
            agent = AgentConfig(
                discussion_id=discussion.id,
                name=agent_data.name,
                role=agent_data.role,
                persona=agent_data.persona,
                provider=agent_data.provider,
                model=agent_data.model,
                api_key=agent_data.api_key,
                base_url=agent_data.base_url,
            )
            db.add(agent)
    # Non-custom modes: agents are generated at run time by templates/planner

    await db.commit()
    await db.refresh(discussion, ["agents"])
    return discussion


async def get_discussion(db: AsyncSession, discussion_id: int) -> Discussion | None:
    result = await db.execute(
        select(Discussion)
        .options(
            selectinload(Discussion.agents),
            selectinload(Discussion.messages),
            selectinload(Discussion.materials),
        )
        .where(Discussion.id == discussion_id)
    )
    return result.scalar_one_or_none()


async def list_discussions(db: AsyncSession) -> list[Discussion]:
    result = await db.execute(
        select(Discussion)
        .options(selectinload(Discussion.agents))
        .order_by(Discussion.created_at.desc())
    )
    return list(result.scalars().all())


async def delete_discussion(db: AsyncSession, discussion_id: int) -> bool:
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        return False
    # Clean up uploaded files
    upload_path = os.path.join(UPLOAD_DIR, str(discussion_id))
    if os.path.exists(upload_path):
        shutil.rmtree(upload_path)
    await db.delete(discussion)
    await db.commit()
    return True


async def update_agent(db: AsyncSession, discussion_id: int, agent_id: int, data: AgentConfigUpdate) -> AgentConfig | None:
    """Update an agent's config fields. Only allowed before discussion runs."""
    result = await db.execute(
        select(AgentConfig).where(
            AgentConfig.id == agent_id,
            AgentConfig.discussion_id == discussion_id,
        )
    )
    agent = result.scalar_one_or_none()
    if not agent:
        return None
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(agent, field, value)
    await db.commit()
    await db.refresh(agent)
    return agent


async def prepare_agents(db: AsyncSession, discussion_id: int) -> list[AgentConfig]:
    """Pre-generate agents for non-custom modes so the user can edit them before running.

    Guards against concurrent calls (e.g. React strict mode double-firing)
    by re-checking after resolve completes.
    """
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        return []
    if discussion.agents:
        return list(discussion.agents)

    agent_defs = await _resolve_agents(discussion)

    # Re-check after async resolve to prevent TOCTOU race
    await db.refresh(discussion, ["agents"])
    if discussion.agents:
        return list(discussion.agents)

    agents = []
    for ad in agent_defs:
        agent = AgentConfig(
            discussion_id=discussion.id,
            name=ad["name"],
            role=ad["role"],
            persona=ad.get("persona", ""),
            provider=ad.get("provider", "openai"),
            model=ad.get("model", "gpt-4o"),
            api_key=ad.get("api_key"),
            base_url=ad.get("base_url"),
        )
        db.add(agent)
        agents.append(agent)
    await db.commit()
    for a in agents:
        await db.refresh(a)
    return agents


async def generate_title(db: AsyncSession, discussion_id: int) -> str:
    """Generate a short title for the discussion using the first available LLM."""
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        return ""

    topic = discussion.topic
    fallback = topic[:20] + ("..." if len(topic) > 20 else "")

    llm_configs = discussion.llm_configs or []
    if not llm_configs:
        discussion.title = fallback
        await db.commit()
        return fallback

    llm = llm_configs[0]
    try:
        title = await call_llm(
            provider=llm.get("provider", "openai"),
            model=llm.get("model", "gpt-4o"),
            messages=[{"role": "user", "content": f"用10字以内中文概括这个话题，只输出标题本身，不要引号和标点：{topic}"}],
            api_key=llm.get("api_key"),
            base_url=llm.get("base_url"),
            temperature=0.3,
            max_tokens=50,
        )
        title = title.strip().strip('"\'""''')[:50]
    except Exception:
        title = fallback

    discussion.title = title
    await db.commit()
    return title


async def upload_materials(db: AsyncSession, discussion_id: int, files: list[UploadFile]) -> list[DiscussionMaterial]:
    """Save uploaded files to disk and create DB records."""
    upload_path = os.path.join(UPLOAD_DIR, str(discussion_id))
    os.makedirs(upload_path, exist_ok=True)

    materials = []
    for file in files:
        ext = os.path.splitext(file.filename or "")[1].lower()
        if ext in ALLOWED_IMAGE_EXTS:
            file_type = "image"
        elif ext in ALLOWED_FILE_EXTS:
            file_type = "file"
        else:
            continue  # skip unsupported types

        content = await file.read()
        if len(content) > MAX_FILE_SIZE:
            continue  # skip oversized files

        filepath = os.path.join(upload_path, file.filename)
        with open(filepath, "wb") as f:
            f.write(content)

        # Extract text content for text-based files
        text_content = None
        if ext in (".txt", ".md"):
            try:
                text_content = content.decode("utf-8", errors="replace")
            except Exception:
                pass

        material = DiscussionMaterial(
            discussion_id=discussion_id,
            filename=file.filename,
            filepath=filepath,
            file_type=file_type,
            mime_type=file.content_type,
            file_size=len(content),
            text_content=text_content,
        )
        db.add(material)
        materials.append(material)

    await db.commit()
    for m in materials:
        await db.refresh(m)
    return materials


async def list_materials(db: AsyncSession, discussion_id: int) -> list[DiscussionMaterial]:
    result = await db.execute(
        select(DiscussionMaterial)
        .where(DiscussionMaterial.discussion_id == discussion_id)
        .order_by(DiscussionMaterial.created_at)
    )
    return list(result.scalars().all())


async def delete_material(db: AsyncSession, discussion_id: int, material_id: int) -> bool:
    result = await db.execute(
        select(DiscussionMaterial).where(
            DiscussionMaterial.id == material_id,
            DiscussionMaterial.discussion_id == discussion_id,
        )
    )
    material = result.scalar_one_or_none()
    if not material:
        return False
    # Remove file from disk
    if os.path.exists(material.filepath):
        os.remove(material.filepath)
    await db.delete(material)
    await db.commit()
    return True


def _build_materials_text(materials: list[DiscussionMaterial]) -> str:
    """Format materials into a text block for LLM prompts."""
    if not materials:
        return ""
    parts = []
    for m in materials:
        if m.file_type == "file" and m.text_content:
            parts.append(f"[文件: {m.filename}]\n{m.text_content}")
        elif m.file_type == "image":
            parts.append(f"[图片: {m.filename}]")
        else:
            parts.append(f"[附件: {m.filename}]")
    return "\n\n".join(parts)


async def _resolve_agents(discussion: Discussion) -> list[dict]:
    """Resolve agent definitions based on discussion mode and llm_configs."""
    llm_configs = discussion.llm_configs or []

    if discussion.mode == DiscussionMode.AUTO:
        # Use the first LLM as the planner
        if llm_configs:
            planner_llm = llm_configs[0]
            agent_defs = await plan_agents(
                topic=discussion.topic,
                provider=planner_llm.get("provider", "openai"),
                model=planner_llm.get("model", "gpt-4o"),
                api_key=planner_llm.get("api_key"),
                base_url=planner_llm.get("base_url"),
            )
        else:
            # No LLMs provided — use planner's default fallback panel
            agent_defs = await plan_agents(
                topic=discussion.topic,
                provider="openai",
                model="gpt-4o",
            )
    else:
        # Debate / Brainstorm / Sequential — use predefined templates
        agent_defs = get_mode_template(discussion.mode)

    # Assign user's LLMs to agents round-robin
    return assign_llms_to_agents(agent_defs, llm_configs)


async def run_discussion(db: AsyncSession, discussion_id: int) -> AsyncGenerator[DiscussionEvent, None]:
    """Run the discussion and yield SSE events."""
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        yield DiscussionEvent(event_type="error", content="Discussion not found")
        return

    if discussion.status == DiscussionStatus.COMPLETED:
        yield DiscussionEvent(event_type="error", content="Discussion already completed")
        return

    if discussion.status not in (DiscussionStatus.CREATED, DiscussionStatus.FAILED):
        yield DiscussionEvent(event_type="error", content="Discussion is already running")
        return

    # Retry cleanup: clear old messages and reset round counter
    if discussion.status == DiscussionStatus.FAILED:
        for msg in list(discussion.messages):
            await db.delete(msg)
        discussion.current_round = 0
        discussion.final_summary = None
        await db.commit()
        await db.refresh(discussion, ["messages"])

    # Resolve agents if not yet generated (non-custom modes)
    if not discussion.agents:
        yield DiscussionEvent(event_type="phase_change", phase="planning", content="正在生成专家团队...")
        agents_list = await prepare_agents(db, discussion_id)
        if not agents_list:
            yield DiscussionEvent(event_type="error", content="No agents available for discussion")
            return
        await db.refresh(discussion, ["agents"])

    # Build agent info list
    agents: list[AgentInfo] = []
    for a in discussion.agents:
        agents.append(AgentInfo(
            name=a.name,
            role=a.role,
            persona=a.persona or "",
            provider=a.provider,
            model=a.model,
            api_key=a.api_key,
            base_url=a.base_url,
        ))

    if not agents:
        yield DiscussionEvent(event_type="error", content="No agents available for discussion")
        return

    # Validate: at least one agent must have an API key (or use local provider)
    local_providers = {"ollama", "ollama_chat", "vllm"}
    agents_missing_key = [
        a for a in agents
        if not a.get("api_key") and a.get("provider", "").lower() not in local_providers
    ]
    if agents_missing_key:
        names = ", ".join(a["name"] for a in agents_missing_key)
        yield DiscussionEvent(
            event_type="error",
            content=f"以下 Agent 缺少 API Key: {names}。请在「设置」中为对应的 LLM 供应商配置 API Key，或设置相应的环境变量（如 OPENAI_API_KEY）。",
        )
        discussion.status = DiscussionStatus.FAILED
        await db.commit()
        return

    # Build materials text from uploaded files
    materials_text = _build_materials_text(list(discussion.materials)) if discussion.materials else ""

    # Initialize state
    initial_state: DiscussionState = {
        "topic": discussion.topic,
        "agents": agents,
        "messages": [],
        "current_round": 0,
        "max_rounds": discussion.max_rounds,
        "host_plan": "",
        "critic_feedback": "",
        "should_continue": True,
        "final_summary": "",
        "materials": materials_text,
        "phase": "planning",
        "error": None,
    }

    discussion.status = DiscussionStatus.PLANNING
    await db.commit()

    yield DiscussionEvent(event_type="phase_change", phase="planning", content="Discussion starting...")

    graph = build_discussion_graph()

    queue = asyncio.Queue()
    token = progress_queue_var.set(queue)

    async def _run_graph():
        """Run graph in background task, pushing node outputs to the queue."""
        try:
            async for event in graph.astream(initial_state, stream_mode="updates"):
                await queue.put((GRAPH_EVENT, event))
        except Exception as e:
            await queue.put((GRAPH_EVENT, {"_error": str(e)}))
        finally:
            await queue.put((GRAPH_DONE, None))

    task = asyncio.create_task(_run_graph())

    try:
        while True:
            msg_type, payload = await queue.get()

            if msg_type == GRAPH_DONE:
                break

            if msg_type == PROGRESS_EVENT:
                # Forward LLM streaming progress
                yield DiscussionEvent(
                    event_type="llm_progress",
                    agent_name=payload["agent_name"],
                    chars_received=payload["chars"],
                    llm_status=payload["status"],
                    phase=payload.get("phase", ""),
                )
                continue

            # GRAPH_EVENT — process node outputs
            if "_error" in payload:
                yield DiscussionEvent(event_type="error", content=payload["_error"])
                discussion.status = DiscussionStatus.FAILED
                await db.commit()
                return

            for node_name, node_output in payload.items():
                phase = node_output.get("phase", "")
                error = node_output.get("error")

                if error:
                    yield DiscussionEvent(event_type="error", content=error)
                    discussion.status = DiscussionStatus.FAILED
                    await db.commit()
                    return

                # Update discussion status based on phase
                if phase == "planning":
                    discussion.status = DiscussionStatus.PLANNING
                elif phase == "discussing":
                    discussion.status = DiscussionStatus.DISCUSSING
                elif phase == "reflecting":
                    discussion.status = DiscussionStatus.REFLECTING
                elif phase == "synthesizing":
                    discussion.status = DiscussionStatus.SYNTHESIZING

                # Save messages to DB and yield events
                new_messages = node_output.get("messages", [])
                for msg_data in new_messages:
                    msg = Message(
                        discussion_id=discussion.id,
                        agent_name=msg_data["agent_name"],
                        agent_role=msg_data["agent_role"],
                        content=msg_data["content"],
                        round_number=msg_data.get("round_number", 0),
                        phase=msg_data.get("phase", ""),
                    )
                    db.add(msg)

                    yield DiscussionEvent(
                        event_type="message",
                        agent_name=msg_data["agent_name"],
                        agent_role=msg_data["agent_role"],
                        content=msg_data["content"],
                        phase=msg_data.get("phase", ""),
                        round_number=msg_data.get("round_number", 0),
                    )

                if phase:
                    yield DiscussionEvent(event_type="phase_change", phase=phase)

                # Save final summary
                if node_output.get("final_summary"):
                    discussion.final_summary = node_output["final_summary"]

                discussion.current_round = node_output.get("current_round", discussion.current_round)
                await db.commit()

        discussion.status = DiscussionStatus.COMPLETED
        await db.commit()
        yield DiscussionEvent(event_type="complete", content="Discussion completed successfully")

    except Exception as e:
        task.cancel()
        discussion.status = DiscussionStatus.FAILED
        await db.commit()
        yield DiscussionEvent(event_type="error", content=f"Discussion failed: {str(e)}")
    finally:
        progress_queue_var.reset(token)
        # Guard against client disconnect (GeneratorExit) leaving status stuck
        try:
            await db.refresh(discussion)
            if discussion.status not in (
                DiscussionStatus.COMPLETED,
                DiscussionStatus.FAILED,
                DiscussionStatus.CREATED,
            ):
                discussion.status = DiscussionStatus.FAILED
                await db.commit()
        except Exception:
            pass  # DB session may already be closed
