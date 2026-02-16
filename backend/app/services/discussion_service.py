"""Discussion service — orchestrates DB operations and the LangGraph engine."""
import asyncio
import json
import logging
import os
import shutil
from typing import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload
from fastapi import UploadFile

from ..models.models import Discussion, AgentConfig, Message, LLMProvider, LLMModel, DiscussionMaterial, DiscussionStatus, DiscussionMode, AgentRole, SystemSetting
from ..schemas.schemas import DiscussionCreate, AgentConfigUpdate, DiscussionEvent
from ..database import async_session
from .discussion_engine import build_discussion_graph, AgentInfo, DiscussionState, progress_queue_var, _pending_user_messages
from .mode_templates import get_mode_template, assign_llms_to_agents
from .planner import plan_agents
from .llm_service import call_llm

logger = logging.getLogger(__name__)

GRAPH_EVENT = "graph_event"
PROGRESS_EVENT = "progress_event"
USER_MSG_CONSUMED = "user_message_consumed"
GRAPH_DONE = "graph_done"

# Track running graph tasks so they can be cancelled by the stop endpoint
_running_tasks: dict[int, asyncio.Task] = {}
# Track drain tasks (background DB writers after SSE disconnect)
_drain_tasks: dict[int, asyncio.Task] = {}

UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(__file__))), "uploads")
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
ALLOWED_FILE_EXTS = {".txt", ".md", ".pdf", ".docx"}
ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp"}

# Minimum content length to trigger summarization (short messages don't need it)
MIN_SUMMARY_LENGTH = 200


async def _get_summary_model_config() -> dict | None:
    """Read the summary_model system setting. Returns dict with provider/model/api_key/base_url or None."""
    async with async_session() as db:
        result = await db.execute(
            select(SystemSetting).where(SystemSetting.key == "summary_model")
        )
        setting = result.scalar_one_or_none()
        if not setting or not setting.value:
            return None
        try:
            cfg = json.loads(setting.value)
        except (json.JSONDecodeError, TypeError):
            return None
        # Resolve api_key/base_url from provider table
        provider_id = cfg.get("provider_id")
        if provider_id:
            prov_result = await db.execute(
                select(LLMProvider).where(LLMProvider.id == provider_id)
            )
            prov = prov_result.scalar_one_or_none()
            if prov:
                cfg["api_key"] = prov.api_key
                cfg["base_url"] = prov.base_url
                cfg["provider"] = prov.provider
        return cfg


async def _summarize_message_bg(message_id: int):
    """Background task: generate a summary for a message using the configured summary model."""
    try:
        cfg = await _get_summary_model_config()
        if not cfg:
            return

        async with async_session() as db:
            result = await db.execute(select(Message).where(Message.id == message_id))
            msg = result.scalar_one_or_none()
            if not msg or msg.summary:
                return
            if len(msg.content) < MIN_SUMMARY_LENGTH:
                return

            summary = await call_llm(
                provider=cfg.get("provider", "openai"),
                model=cfg.get("model", "gpt-4o-mini"),
                messages=[{"role": "user", "content": f"请用2-3句话简洁总结以下内容，保留关键观点，不要添加额外评论：\n\n{msg.content}"}],
                api_key=cfg.get("api_key"),
                base_url=cfg.get("base_url"),
                temperature=0.3,
                max_tokens=200,
            )
            msg.summary = summary.strip()
            await db.commit()
    except Exception as e:
        logger.warning("Failed to summarize message %d: %s", message_id, e)


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

    updates = data.model_dump(exclude_unset=True)
    # Don't let frontend overwrite api_key/base_url — resolve from provider table
    updates.pop("api_key", None)
    updates.pop("base_url", None)
    # Extract provider_id before applying updates (not an AgentConfig column)
    provider_id = updates.pop("provider_id", None)
    for field, value in updates.items():
        setattr(agent, field, value)

    # Auto-resolve api_key and base_url from LLMProvider
    # Prefer provider_id (precise) over provider type (ambiguous with multiple same-type providers)
    if provider_id:
        prov_result = await db.execute(
            select(LLMProvider).where(LLMProvider.id == provider_id)
        )
    else:
        target_provider = updates.get("provider", agent.provider)
        prov_result = await db.execute(
            select(LLMProvider).where(LLMProvider.provider == target_provider)
        )
    prov = prov_result.scalar_one_or_none()
    if prov:
        agent.api_key = prov.api_key
        agent.base_url = prov.base_url

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

    if discussion.status not in (DiscussionStatus.CREATED, DiscussionStatus.FAILED, DiscussionStatus.WAITING_INPUT):
        yield DiscussionEvent(event_type="error", content="Discussion is already running")
        return

    # Continuing from WAITING_INPUT — keep messages, reset round counter for new cycle
    resuming = discussion.status == DiscussionStatus.WAITING_INPUT

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

    # Initialize state — when resuming, carry over previous messages for context
    prior_messages = []
    if resuming and discussion.messages:
        for m in discussion.messages:
            prior_messages.append({
                "agent_name": m.agent_name,
                "agent_role": m.agent_role,
                "content": m.content,
                "round_number": m.round_number,
                "phase": m.phase or "",
            })

    initial_state: DiscussionState = {
        "topic": discussion.topic,
        "agents": agents,
        "messages": prior_messages,
        "current_round": 0,
        "max_rounds": discussion.max_rounds,
        "host_plan": "",
        "critic_feedback": "",
        "should_continue": True,
        "final_summary": "",
        "materials": materials_text,
        "phase": "planning",
        "error": None,
        "discussion_id": discussion_id,
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
    _running_tasks[discussion_id] = task

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

            if msg_type == USER_MSG_CONSUMED:
                # Notify frontend that a user message was consumed by the engine
                yield DiscussionEvent(
                    event_type="user_message_consumed",
                    agent_name=payload.get("agent_name", "用户"),
                    content=payload.get("content", ""),
                    phase="user_input",
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
                saved_msgs = []
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
                    saved_msgs.append(msg)

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

                # Fire background summarization for saved messages
                for msg in saved_msgs:
                    if msg.id and len(msg.content) >= MIN_SUMMARY_LENGTH:
                        asyncio.create_task(_summarize_message_bg(msg.id))

        discussion.status = DiscussionStatus.WAITING_INPUT
        await db.commit()
        yield DiscussionEvent(event_type="cycle_complete", content="本轮讨论结束，等待您的输入后继续...")

    except Exception as e:
        task.cancel()
        discussion.status = DiscussionStatus.FAILED
        await db.commit()
        yield DiscussionEvent(event_type="error", content=f"Discussion failed: {str(e)}")
    finally:
        _pending_user_messages.pop(discussion_id, None)
        progress_queue_var.reset(token)

        # If the graph task is still running (e.g. SSE client disconnected),
        # spawn a background drain task to keep saving messages to DB.
        if not task.done():
            logger.info("SSE disconnected for discussion %d — spawning drain task", discussion_id)
            drain = asyncio.create_task(_drain_queue(discussion_id, queue, task))
            _drain_tasks[discussion_id] = drain
        else:
            # Task finished normally — clean up
            _running_tasks.pop(discussion_id, None)
            try:
                await db.refresh(discussion)
                if discussion.status not in (
                    DiscussionStatus.COMPLETED,
                    DiscussionStatus.FAILED,
                    DiscussionStatus.CREATED,
                    DiscussionStatus.WAITING_INPUT,
                ):
                    discussion.status = DiscussionStatus.FAILED
                    await db.commit()
            except Exception:
                pass


async def _drain_queue(discussion_id: int, queue: asyncio.Queue, graph_task: asyncio.Task):
    """Background task: keep reading the graph queue and saving messages to DB
    after the SSE client has disconnected. Uses its own DB session."""
    try:
        async with async_session() as db:
            result = await db.execute(
                select(Discussion).where(Discussion.id == discussion_id)
            )
            discussion = result.scalar_one_or_none()
            if not discussion:
                graph_task.cancel()
                return

            while True:
                msg_type, payload = await queue.get()

                if msg_type == GRAPH_DONE:
                    break

                if msg_type == PROGRESS_EVENT:
                    continue  # no SSE consumer — skip progress events

                if msg_type == USER_MSG_CONSUMED:
                    continue

                # GRAPH_EVENT
                if "_error" in payload:
                    discussion.status = DiscussionStatus.FAILED
                    await db.commit()
                    return

                for node_name, node_output in payload.items():
                    phase = node_output.get("phase", "")
                    error = node_output.get("error")

                    if error:
                        discussion.status = DiscussionStatus.FAILED
                        await db.commit()
                        return

                    if phase == "planning":
                        discussion.status = DiscussionStatus.PLANNING
                    elif phase == "discussing":
                        discussion.status = DiscussionStatus.DISCUSSING
                    elif phase == "reflecting":
                        discussion.status = DiscussionStatus.REFLECTING
                    elif phase == "synthesizing":
                        discussion.status = DiscussionStatus.SYNTHESIZING

                    saved_msgs = []
                    for msg_data in node_output.get("messages", []):
                        msg = Message(
                            discussion_id=discussion_id,
                            agent_name=msg_data["agent_name"],
                            agent_role=msg_data["agent_role"],
                            content=msg_data["content"],
                            round_number=msg_data.get("round_number", 0),
                            phase=msg_data.get("phase", ""),
                        )
                        db.add(msg)
                        saved_msgs.append(msg)

                    if node_output.get("final_summary"):
                        discussion.final_summary = node_output["final_summary"]

                    discussion.current_round = node_output.get("current_round", discussion.current_round)
                    await db.commit()

                    # Fire background summarization
                    for msg in saved_msgs:
                        if msg.id and len(msg.content) >= MIN_SUMMARY_LENGTH:
                            asyncio.create_task(_summarize_message_bg(msg.id))

            # Graph finished — set final status
            discussion.status = DiscussionStatus.WAITING_INPUT
            await db.commit()
            logger.info("Drain task completed for discussion %d", discussion_id)

    except Exception as e:
        logger.warning("Drain task error for discussion %d: %s", discussion_id, e)
        try:
            async with async_session() as db:
                result = await db.execute(
                    select(Discussion).where(Discussion.id == discussion_id)
                )
                disc = result.scalar_one_or_none()
                if disc and disc.status not in (
                    DiscussionStatus.COMPLETED, DiscussionStatus.FAILED,
                    DiscussionStatus.CREATED, DiscussionStatus.WAITING_INPUT,
                ):
                    disc.status = DiscussionStatus.FAILED
                    await db.commit()
        except Exception:
            pass
    finally:
        _running_tasks.pop(discussion_id, None)
        _drain_tasks.pop(discussion_id, None)


async def stop_discussion(db: AsyncSession, discussion_id: int) -> bool:
    """Cancel a running discussion: kill the graph task, drain task, and reset status."""
    task = _running_tasks.pop(discussion_id, None)
    if task and not task.done():
        task.cancel()
    drain = _drain_tasks.pop(discussion_id, None)
    if drain and not drain.done():
        drain.cancel()

    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        return False

    if discussion.status not in (
        DiscussionStatus.COMPLETED,
        DiscussionStatus.FAILED,
        DiscussionStatus.CREATED,
        DiscussionStatus.WAITING_INPUT,
    ):
        discussion.status = DiscussionStatus.FAILED
        await db.commit()
    return True


async def complete_discussion(db: AsyncSession, discussion_id: int) -> bool:
    """Manually mark a discussion as completed (end the cyclic loop)."""
    discussion = await get_discussion(db, discussion_id)
    if not discussion:
        return False
    discussion.status = DiscussionStatus.COMPLETED
    await db.commit()
    return True


async def submit_user_input(db: AsyncSession, discussion_id: int, content: str) -> Message:
    """Submit a user message into a running discussion.

    The message is saved to DB immediately and queued for injection
    into the next host_planning_node round.
    """
    msg = Message(
        discussion_id=discussion_id,
        agent_name="用户",
        agent_role=AgentRole.USER,
        content=content,
        round_number=0,
        phase="user_input",
    )
    db.add(msg)
    await db.commit()
    await db.refresh(msg)

    # Append to pending queue for engine consumption
    _pending_user_messages.setdefault(discussion_id, []).append({
        "agent_name": "用户",
        "content": content,
    })

    return msg
