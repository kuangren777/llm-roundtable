"""LangGraph-based multi-agent discussion engine.

Core flow:
  Multi-round: Host planning -> Panelists -> Critic -> Host round summary
              -> Host next-step planning -> iterate/final synthesis
  Incremental follow-up: Host planning -> Panelists -> Host round summary
"""
import asyncio
import contextvars
import json
import re
import uuid
from typing import TypedDict, Annotated, Optional
from langgraph.graph import StateGraph, END
from ..services.llm_service import call_llm, call_llm_stream
from ..models.models import AgentRole

# Queue for pushing LLM progress events out of graph nodes
progress_queue_var: contextvars.ContextVar[asyncio.Queue | None] = contextvars.ContextVar(
    'progress_queue', default=None
)

# Per-discussion pending user messages (non-blocking injection)
_pending_user_messages: dict[int, list[dict]] = {}

HISTORY_MAX_CHARS = 50000
HISTORY_HEAD_ROUNDS = 2
HISTORY_TAIL_MESSAGES = 24
MATERIALS_MAX_CHARS = 20000
USER_INPUTS_MAX_CHARS = 12000
ROUND_SUMMARIES_MAX_CHARS = 12000


class AgentInfo(TypedDict):
    name: str
    role: str
    persona: str
    provider: str
    model: str
    api_key: Optional[str]
    base_url: Optional[str]


class DiscussionState(TypedDict):
    topic: str
    agents: list[AgentInfo]
    messages: Annotated[list[dict], lambda a, b: a + b]  # accumulate messages
    round_summaries: Annotated[list[dict], lambda a, b: a + b]  # per-round host summaries
    current_round: int
    max_rounds: int
    host_plan: str
    critic_feedback: str
    should_continue: bool
    final_summary: str
    materials: str  # formatted reference materials text
    phase: str
    error: Optional[str]
    discussion_id: int
    single_round_mode: bool  # True when resuming after completion/waiting-input — run exactly one incremental round
    selected_panelists: list[str]
    panelist_tasks: dict[str, str]
    routing_constraints: dict
    needs_synthesis: bool
    execution_mode: str  # "panelists" | "host_only"
    intent_judgment: str
    host_position: str
    open_tasks: list[str]
    next_step_plan: str
    cycle_index: int


def _get_agent_by_role(agents: list[AgentInfo], role: str) -> Optional[AgentInfo]:
    for a in agents:
        if a["role"] == role:
            return a
    return None


def _get_agents_by_role(agents: list[AgentInfo], role: str) -> list[AgentInfo]:
    return [a for a in agents if a["role"] == role]


def _format_materials(materials: str) -> str:
    """Return a materials block for prompt injection, or empty string."""
    if not materials:
        return ""
    text = str(materials).strip()
    if len(text) > MATERIALS_MAX_CHARS:
        text = text[:MATERIALS_MAX_CHARS] + "\n...(参考材料过长，已截断)"
    return f"\n\n参考材料:\n{text}"


def _format_history(messages: list[dict], last_n: Optional[int] = 20) -> str:
    if last_n is None or last_n <= 0:
        recent = messages
    else:
        recent = messages[-last_n:] if len(messages) > last_n else messages
    lines = []
    for m in recent:
        lines.append(f"[{m.get('agent_name', '?')} ({m.get('phase', '?')})]: {m['content']}")
    return "\n\n".join(lines)


def _truncate_text(text: object, max_chars: int) -> str:
    s = str(text or "").strip()
    if len(s) <= max_chars:
        return s
    return s[:max_chars] + "..."


def _format_user_inputs(
    user_inputs: list[dict],
    max_total_chars: int = USER_INPUTS_MAX_CHARS,
    max_item_chars: int = 1200,
) -> str:
    if not user_inputs:
        return "- （无）"

    lines: list[str] = []
    used = 0
    omitted = 0
    for m in user_inputs:
        line = f"- {_truncate_text(m.get('content', ''), max_item_chars)}"
        cost = len(line) + 1
        if used + cost > max_total_chars:
            omitted += 1
            continue
        lines.append(line)
        used += cost

    if omitted > 0:
        lines.append(f"- （另有 {omitted} 条用户输入因过长被省略）")
    return "\n".join(lines) if lines else "- （用户输入过长，已省略）"


def _format_round_summaries(
    round_summaries: list[dict],
    max_total_chars: int = ROUND_SUMMARIES_MAX_CHARS,
    max_item_chars: int = 1800,
) -> str:
    if not round_summaries:
        return "（首轮，无历史总结）"

    lines: list[str] = []
    used = 0
    omitted = 0
    for rs in round_summaries:
        round_no = int(rs.get("round", 0)) + 1
        summary = _truncate_text(rs.get("summary", ""), max_item_chars)
        block = f"--- 第 {round_no} 轮总结 ---\n{summary}"
        cost = len(block) + 2
        if used + cost > max_total_chars:
            omitted += 1
            continue
        lines.append(block)
        used += cost
    if omitted > 0:
        lines.append(f"---\n（另有 {omitted} 轮历史总结因过长被省略）")
    return "\n\n".join(lines) if lines else "（历史总结过长，已省略）"


def _format_history_with_anchors(
    messages: list[dict],
    max_total_chars: int = HISTORY_MAX_CHARS,
    keep_head_rounds: int = HISTORY_HEAD_ROUNDS,
    keep_tail_messages: int = HISTORY_TAIL_MESSAGES,
) -> str:
    """Bounded history:
    always keep initial user requirement + first rounds + all user inputs (truncated),
    then append recent tail messages until budget is exhausted.
    """
    if not messages:
        return ""

    def to_line(msg: dict, compact: bool) -> str:
        role = msg.get("agent_role")
        max_item = 1200 if role == AgentRole.USER else 700
        if compact:
            max_item = 700 if role == AgentRole.USER else 360
        content = _truncate_text(msg.get("content", ""), max_item)
        return f"[{msg.get('agent_name', '?')} ({msg.get('phase', '?')})]: {content}"

    total = len(messages)
    first_user_idx = next((i for i, m in enumerate(messages) if m.get("agent_role") == AgentRole.USER), None)
    head_round_indices = [
        i for i, m in enumerate(messages)
        if isinstance(m.get("round_number"), int) and int(m.get("round_number", 0)) < keep_head_rounds
    ]
    all_user_indices = [i for i, m in enumerate(messages) if m.get("agent_role") == AgentRole.USER]
    tail_start = max(0, total - keep_tail_messages)
    tail_indices = list(range(tail_start, total))

    chosen: dict[int, str] = {}
    used = 0

    def add_idx(idx: int, compact: bool = False) -> bool:
        nonlocal used
        if idx in chosen:
            return True
        line = to_line(messages[idx], compact=compact)
        cost = len(line) + 2
        if used + cost > max_total_chars:
            return False
        chosen[idx] = line
        used += cost
        return True

    # Priority 1: initial user requirement
    if first_user_idx is not None:
        add_idx(first_user_idx, compact=True)

    # Priority 2: first rounds (to preserve early reasoning chain)
    for idx in head_round_indices:
        add_idx(idx, compact=True)

    # Priority 3: user inputs across the whole discussion
    for idx in all_user_indices:
        add_idx(idx, compact=True)

    # Priority 4: latest messages (recent state)
    for idx in tail_indices:
        add_idx(idx, compact=False)

    ordered = sorted(chosen.keys())
    omitted = total - len(ordered)
    lines = [chosen[i] for i in ordered]
    if omitted > 0:
        lines.append(f"（历史已裁剪：省略 {omitted} 条较低优先级消息）")
    return "\n\n".join(lines)


def _strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        lines = stripped.splitlines()
        if lines:
            lines = lines[1:]
        if lines and lines[-1].strip().startswith("```"):
            lines = lines[:-1]
        return "\n".join(lines).strip()
    return stripped


def _extract_json_object(text: str) -> dict | None:
    cleaned = _strip_code_fence(text)
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass

    match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
    if not match:
        return None
    try:
        parsed = json.loads(match.group(0))
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        return None


def _normalize_selection(selected: list[str], panelists: list[AgentInfo], constraints: dict) -> list[str]:
    panelist_names = [str(p["name"]) for p in panelists]
    valid_selected = [name for name in selected if name in panelist_names]

    if not valid_selected:
        valid_selected = panelist_names.copy()

    constrained_targets = constraints.get("target_panelists") or []
    if constrained_targets:
        constrained_targets = [name for name in constrained_targets if name in panelist_names]
        # User explicitly named guests: host must only choose from this set.
        valid_selected = [name for name in valid_selected if name in constrained_targets]
        if not valid_selected:
            valid_selected = constrained_targets[:]

    if (
        constraints.get("avoid_all_panelists")
        and len(valid_selected) == len(panelist_names)
        and len(valid_selected) > 1
    ):
        valid_selected = valid_selected[:1]

    return valid_selected


def _normalize_execution_mode(raw_mode: object) -> str:
    candidate = str(raw_mode or "").strip().lower().replace("-", "_")
    if candidate in {"host_only", "hostonly"}:
        return "host_only"
    return "panelists"


def _normalize_open_tasks(raw_tasks: object) -> list[str]:
    if isinstance(raw_tasks, list):
        return [str(item).strip() for item in raw_tasks if str(item).strip()]
    if isinstance(raw_tasks, str):
        task = raw_tasks.strip()
        return [task] if task else []
    return []


def _parse_host_routing(
    raw_plan: str,
    panelists: list[AgentInfo],
    constraints: dict,
    single_round_mode: bool,
) -> tuple[str, list[str], dict[str, str], bool, str, str, str, str, list[str]]:
    panelist_names = [str(p["name"]) for p in panelists]
    parsed = _extract_json_object(raw_plan)

    selected: list[str] = []
    tasks: dict[str, str] = {}
    needs_synthesis = False
    execution_mode = "panelists"
    intent_judgment = "用户意图未明确，默认按常规讨论推进。"
    host_position = "主持人建议先聚焦可验证结论，再决定是否扩展讨论范围。"
    reasoning_text = ""
    open_tasks: list[str] = []
    plan_text = raw_plan.strip()

    if parsed:
        plan_text = str(parsed.get("discussion_plan") or parsed.get("reasoning") or plan_text).strip()
        reasoning_text = str(parsed.get("reasoning") or "").strip()
        execution_mode = _normalize_execution_mode(parsed.get("execution_mode"))
        intent_judgment = str(parsed.get("intent_judgment") or intent_judgment).strip()
        host_position = str(
            parsed.get("host_position") or reasoning_text or host_position
        ).strip()
        open_tasks = _normalize_open_tasks(parsed.get("open_tasks"))

        selected_raw = parsed.get("selected_panelists")
        if isinstance(selected_raw, list):
            selected = [str(name).strip() for name in selected_raw if str(name).strip()]

        assignments = parsed.get("assignments")
        if isinstance(assignments, dict):
            for name, task in assignments.items():
                n = str(name).strip()
                t = str(task).strip()
                if n and t:
                    tasks[n] = t
            if not selected and tasks:
                selected = list(tasks.keys())
        elif isinstance(assignments, list):
            for item in assignments:
                if not isinstance(item, dict):
                    continue
                name = str(item.get("panelist", "")).strip()
                task = str(item.get("task", "")).strip()
                if name and task:
                    tasks[name] = task
            if not selected and tasks:
                selected = list(tasks.keys())

        if isinstance(parsed.get("needs_synthesis"), bool):
            needs_synthesis = parsed["needs_synthesis"]

    if execution_mode == "panelists":
        selected = _normalize_selection(selected, panelists, constraints)
        if not selected and panelist_names:
            selected = panelist_names[:1]

        for name in selected:
            if not tasks.get(name):
                tasks[name] = "请结合你的专业视角，直接回应主持人的问题与用户最新需求。"
    else:
        selected = []
        tasks = {}

    # Only used in post-cycle single-round mode.
    if not single_round_mode:
        needs_synthesis = False

    if not open_tasks:
        open_tasks = ["请确认该主线是否可直接进入执行；若否，请指出最小补充信息。"]

    return (
        plan_text,
        selected,
        tasks,
        needs_synthesis,
        execution_mode,
        intent_judgment,
        host_position,
        reasoning_text,
        open_tasks,
    )


async def _call_with_progress(
    agent: AgentInfo,
    messages: list[dict],
    phase: str = "",
    stream_content: bool = False,
    use_stream: bool = True,
    **kwargs,
) -> str:
    """Call LLM with streaming, pushing progress events to the context queue.

    Falls back to non-streaming call_llm if no queue is set (e.g. in tests).
    """
    queue = progress_queue_var.get(None)
    if queue is None:
        # No queue — fall back to non-streaming
        return await call_llm(
            provider=agent["provider"],
            model=agent["model"],
            messages=messages,
            api_key=agent.get("api_key"),
            base_url=agent.get("base_url"),
            **kwargs,
        )

    # Emit "waiting" event immediately so frontend shows feedback before first token
    await queue.put(("progress_event", {
        "agent_name": agent["name"],
        "chars": 0,
        "status": "waiting",
        "phase": phase,
    }))

    if not use_stream:
        text = await call_llm(
            provider=agent["provider"],
            model=agent["model"],
            messages=messages,
            api_key=agent.get("api_key"),
            base_url=agent.get("base_url"),
            **kwargs,
        )
        await queue.put(("progress_event", {
            "agent_name": agent["name"],
            "chars": len(text or ""),
            "status": "done",
            "phase": phase,
        }))
        return text

    chunk_count = 0
    accumulated_text = ""

    async def on_chunk(delta: str, total_chars: int):
        nonlocal chunk_count, accumulated_text
        chunk_count += 1
        if stream_content:
            accumulated_text += delta
        # Emit first chunk immediately, then throttle every 5 chunks
        if chunk_count == 1 or chunk_count % 5 == 0:
            evt = {
                "agent_name": agent["name"],
                "chars": total_chars,
                "status": "streaming",
                "phase": phase,
            }
            if stream_content:
                evt["content"] = accumulated_text
            await queue.put(("progress_event", evt))

    text, total_chars = await call_llm_stream(
        provider=agent["provider"],
        model=agent["model"],
        messages=messages,
        api_key=agent.get("api_key"),
        base_url=agent.get("base_url"),
        on_chunk=on_chunk,
        **kwargs,
    )

    # Final "done" event
    await queue.put(("progress_event", {
        "agent_name": agent["name"],
        "chars": total_chars,
        "status": "done",
        "phase": phase,
    }))

    return text


async def host_planning_node(state: DiscussionState) -> dict:
    """Host analyzes the topic and creates a discussion plan with sub-questions."""
    host = _get_agent_by_role(state["agents"], AgentRole.HOST)
    if not host:
        return {"error": "No host agent configured", "phase": "error"}

    panelists = _get_agents_by_role(state["agents"], AgentRole.PANELIST)
    if not panelists:
        return {"error": "No panelist agents configured", "phase": "error"}
    panelist_desc = "\n".join(
        f"- {p['name']}: {p.get('persona', 'General expert')}" for p in panelists
    )

    history = _format_history_with_anchors(state["messages"])
    materials_block = _format_materials(state.get("materials", ""))

    # Extract recent user messages for explicit highlighting
    user_inputs = [m for m in state["messages"] if m.get("agent_role") == AgentRole.USER]
    recent_user_inputs = user_inputs  # all user messages
    constraints = dict(state.get("routing_constraints", {}))

    constraints_lines = []
    target_panelists = constraints.get("target_panelists") or []
    if target_panelists:
        constraints_lines.append(f"- 外部限制指定候选嘉宾：{', '.join(target_panelists)}。")
    if constraints.get("avoid_all_panelists"):
        constraints_lines.append("- 外部限制：本轮禁止选择全体嘉宾。")
    constraints_block = "\n".join(constraints_lines) if constraints_lines else "- 无额外硬性约束。"

    # First round = no prior discussion at all (not just current_round==0, which also happens when resuming)
    has_prior_discussion = any(m.get("agent_role") != AgentRole.USER for m in state["messages"])
    is_first_round = state["current_round"] == 0 and not has_prior_discussion

    round_context = "首轮讨论" if is_first_round else f"第 {state['current_round'] + 1} 轮"
    user_input_text = _format_user_inputs(recent_user_inputs)
    critic_feedback = state.get("critic_feedback", "") or "None"
    next_step_plan = state.get("next_step_plan", "") or "（首轮，无上一轮下一步规划）"
    round_summaries = state.get("round_summaries", [])
    summaries_text = _format_round_summaries(round_summaries)
    synthesis_rule = "当前流程不使用综合开关（needs_synthesis 固定 false）。"

    prompt = f"""You are the Host of an expert round table discussion.

Current stage: {round_context}
Topic: {state['topic']}{materials_block}

Previous round summaries (track discussion progress):
{summaries_text}

Previous discussion history:
{history}

All user inputs (address ALL of these):
{user_input_text}

Critic feedback from last round:
{critic_feedback}

Next-step plan made after last round:
{next_step_plan}

Available panelists:
{panelist_desc}

Hard routing constraints (must follow if provided):
{constraints_block}

User-priority hard rules (MUST follow):
0) Latest user input has highest priority. If it conflicts with prior plan/history, revise plan to match latest user intent.
1) Do not drift to generic discussion. Keep this round tightly scoped to user-requested objective, constraints, and deliverable.
2) In first round, establish a clear working topic/sub-topic based on user input (not only the original topic title).
3) For follow-up rounds, continue unresolved user requests first, then extend.
4) Every selected panelist assignment must explicitly state which user question/request it is answering.
5) Open tasks must be unresolved user-oriented items, not generic filler.

Your job:
1) Infer user intent and state it clearly in "intent_judgment".
2) Provide your own host viewpoint in "host_position" (do not just repeat user words).
3) Output a concise mainline in "discussion_plan" that explicitly includes:
   - user's target outcome
   - scope/boundary for this round
   - what concrete answer/artifact this round should produce
4) Choose execution_mode:
   - "panelists": normal mode, select panelists and assign tasks.
   - "host_only": host directly outputs a ready-to-use plan when user explicitly asks not to split by panelists / asks for direct finalization.
5) Always provide 1-3 "open_tasks" for what remains to validate or refine.
6) {synthesis_rule}
7) Infer user intent from latest user inputs: if user asks to talk to a specific panelist, pick that panelist; if user asks not to call everyone, do not select all panelists.

Return ONLY valid JSON with this schema:
{{
  "intent_judgment": "what user wants this round",
  "host_position": "host's own stance",
  "discussion_plan": "short host plan",
  "execution_mode": "panelists",
  "reasoning": "why these panelists",
  "selected_panelists": ["name1", "name2"],
  "assignments": [{{"panelist":"name1","task":"what to do + which user request it answers"}}, {{"panelist":"name2","task":"..."}},],
  "open_tasks": ["follow-up task 1", "follow-up task 2"],
  "needs_synthesis": false
}}

Never select unknown names. If user named specific panelists, only choose among them.
If execution_mode is "host_only", set selected_panelists to [] and assignments to []."""

    try:
        plan = await _call_with_progress(
            host,
            stream_content=False,
            messages=[
                {"role": "system", "content": f"You are {host['name']}, a skilled discussion moderator. {host.get('persona', '')}"},
                {"role": "user", "content": prompt},
            ],
            phase="planning",
        )
        parsed_plan, selected, panelist_tasks, needs_synthesis, execution_mode, intent_judgment, host_position, reasoning_text, open_tasks = _parse_host_routing(
            raw_plan=plan,
            panelists=panelists,
            constraints=constraints,
            single_round_mode=state.get("single_round_mode", False),
        )
        # Strict workflow always runs panelists; normalize host output accordingly.
        execution_mode = "panelists"
        if not selected:
            selected = [str(p["name"]) for p in panelists]
        for name in selected:
            panelist_tasks.setdefault(name, "请结合你的专业视角，直接回应主持人的问题与用户最新需求。")
        needs_synthesis = False

        assignment_lines = [f"- {name}: {panelist_tasks[name]}" for name in selected if panelist_tasks.get(name)]
        assignment_text = "\n".join(assignment_lines) if assignment_lines else "- （无，主持人直出）"
        open_tasks_text = "\n".join(f"- {task}" for task in open_tasks)
        mode_text = "主持人直出" if execution_mode == "host_only" else "嘉宾分工讨论"
        selected_text = ", ".join(selected) if selected else "无"
        reasoning_block = f"补充说明: {reasoning_text}\n" if reasoning_text else ""
        host_content = (
            f"意图判断: {intent_judgment}\n\n"
            f"主持人观点: {host_position}\n\n"
            f"本轮主线: {parsed_plan}\n\n"
            f"{reasoning_block}"
            f"执行模式: {mode_text}\n"
            f"本轮调用嘉宾: {selected_text}\n"
            f"任务分配:\n{assignment_text}\n"
            f"开放任务:\n{open_tasks_text}\n"
            f"是否需要综合: {'是' if needs_synthesis else '否'}"
        ).strip()

        host_msg = {
            "agent_name": host["name"],
            "agent_role": AgentRole.HOST,
            "content": host_content,
            "round_number": state["current_round"],
            "cycle_index": state.get("cycle_index", 0),
            "phase": "planning",
        }
        return {
            "host_plan": parsed_plan,
            "phase": "planning",
            "selected_panelists": selected,
            "panelist_tasks": panelist_tasks,
            "routing_constraints": constraints,
            "needs_synthesis": needs_synthesis,
            "execution_mode": execution_mode,
            "intent_judgment": intent_judgment,
            "host_position": host_position,
            "open_tasks": open_tasks,
            "messages": [host_msg],
        }
    except Exception as e:
        # Degrade gracefully instead of failing the whole discussion on transient host LLM errors.
        fallback_selected = [str(p["name"]) for p in panelists]
        fallback_tasks = {
            name: "请结合你的专业视角，直接回应主持人的问题与用户最新需求。"
            for name in fallback_selected
        }
        latest_user = ""
        for m in reversed(state.get("messages", [])):
            if m.get("agent_role") == AgentRole.USER and str(m.get("content", "")).strip():
                latest_user = str(m.get("content", "")).strip()
                break
        fallback_plan = (
            f"围绕用户最新目标推进：{latest_user}" if latest_user
            else "围绕当前主题推进，并优先收敛可执行结论。"
        )
        host_msg = {
            "agent_name": host["name"],
            "agent_role": AgentRole.HOST,
            "content": (
                "主持人规划降级执行（上游调用异常，已自动继续）\n\n"
                f"本轮主线: {fallback_plan}\n\n"
                f"异常信息: {str(e)}\n"
                f"本轮调用嘉宾: {', '.join(fallback_selected) if fallback_selected else '无'}"
            ),
            "round_number": state["current_round"],
            "cycle_index": state.get("cycle_index", 0),
            "phase": "planning",
        }
        return {
            "host_plan": fallback_plan,
            "phase": "planning",
            "selected_panelists": fallback_selected,
            "panelist_tasks": fallback_tasks,
            "routing_constraints": constraints,
            "needs_synthesis": False,
            "execution_mode": "panelists",
            "intent_judgment": "主持人调用异常，已按用户最新目标进行降级推进。",
            "host_position": "先保证流程不中断，继续产出可用讨论结果。",
            "open_tasks": ["确认本轮输出是否覆盖用户最新诉求。"],
            "messages": [host_msg],
        }


async def panelist_discussion_node(state: DiscussionState) -> dict:
    """Selected panelists respond in parallel based on host routing."""
    all_panelists = _get_agents_by_role(state["agents"], AgentRole.PANELIST)
    if not all_panelists:
        return {"error": "No panelist agents configured", "phase": "error"}

    selected = state.get("selected_panelists") or []
    panelists = [p for p in all_panelists if p["name"] in selected] if selected else all_panelists
    if not panelists:
        panelists = all_panelists[:1]

    history = _format_history_with_anchors(state["messages"], max_total_chars=30000, keep_tail_messages=20)
    materials_block = _format_materials(state.get("materials", ""))

    # Extract user messages for explicit highlighting in panelist prompts
    user_inputs = [m for m in state["messages"] if m.get("agent_role") == AgentRole.USER]
    recent_user_inputs = user_inputs[-3:]
    user_input_block = ""
    if recent_user_inputs:
        user_input_text = _format_user_inputs(recent_user_inputs, max_total_chars=3000, max_item_chars=800)
        user_input_block = f"\n\n⚠️ 用户新的输入/问题（请重点回应）:\n{user_input_text}"
    panelist_tasks = state.get("panelist_tasks", {})
    queue = progress_queue_var.get(None)

    async def _panelist_respond(panelist: AgentInfo) -> dict:
        assigned_task = panelist_tasks.get(panelist["name"], "请从你的专业视角回应主持人本轮问题。")
        prompt = f"""You are participating in an expert round table discussion.

Topic: {state['topic']}{materials_block}

The host's current plan/questions:
{state['host_plan']}

Your assigned task:
{assigned_task}

Previous discussion (if any):
{history}{user_input_block}

You are {panelist['name']}. Your expertise/persona: {panelist.get('persona', 'General expert')}

Respond to the host's questions from your unique perspective. Be specific, provide concrete examples or data points where possible. If you disagree with another panelist's previous point, explain why constructively.{' Pay special attention to the user input above and make sure your response addresses it.' if user_input_block else ''}"""

        try:
            response = await _call_with_progress(
                panelist,
                stream_content=False,
                messages=[
                    {"role": "system", "content": f"You are {panelist['name']}. {panelist.get('persona', '')} Respond thoughtfully and specifically."},
                    {"role": "user", "content": prompt},
                ],
                phase="discussing",
            )
            msg = {
                "agent_name": panelist["name"],
                "agent_role": AgentRole.PANELIST,
                "content": response,
                "round_number": state["current_round"],
                "cycle_index": state.get("cycle_index", 0),
                "phase": "discussing",
                "message_uid": uuid.uuid4().hex,
            }
            if queue is not None:
                await queue.put(("node_message", msg))
            return msg
        except Exception as e:
            msg = {
                "agent_name": panelist["name"],
                "agent_role": AgentRole.PANELIST,
                "content": f"[Error: {str(e)}]",
                "round_number": state["current_round"],
                "cycle_index": state.get("cycle_index", 0),
                "phase": "discussing",
                "message_uid": uuid.uuid4().hex,
            }
            if queue is not None:
                await queue.put(("node_message", msg))
            return msg

    # Run all panelists in parallel
    results = await asyncio.gather(*[_panelist_respond(p) for p in panelists])
    return {"messages": list(results), "phase": "discussing"}


async def critic_node(state: DiscussionState) -> dict:
    """Critic evaluates the discussion and identifies gaps/contradictions."""
    critic = _get_agent_by_role(state["agents"], AgentRole.CRITIC)
    if not critic:
        return {"critic_feedback": "No critic configured - skipping review.", "phase": "reflecting"}

    history = _format_history_with_anchors(state["messages"], max_total_chars=30000, keep_tail_messages=20)
    materials_block = _format_materials(state.get("materials", ""))

    # Highlight user input for critic evaluation
    user_inputs = [m for m in state["messages"] if m.get("agent_role") == AgentRole.USER]
    recent_user_inputs = user_inputs[-3:]
    user_input_section = ""
    if recent_user_inputs:
        user_input_text = _format_user_inputs(recent_user_inputs, max_total_chars=3000, max_item_chars=800)
        user_input_section = f"\n\n用户提出的问题/意见:\n{user_input_text}\n"

    prompt = f"""You are the Critic in an expert round table discussion. Your job is to be rigorous and constructive.

Topic: {state['topic']}{materials_block}
Current round: {state['current_round'] + 1} of {state['max_rounds']}

Full discussion so far:
{history}{user_input_section}

Analyze the discussion and provide constructive feedback:
1. **Contradictions**: Where do panelists disagree? Are these resolved?
2. **Blind spots**: What important aspects haven't been addressed?
3. **Logical gaps**: Are there unsupported claims or weak reasoning?
4. **Missing perspectives**: What viewpoints are absent?
5. **Suggestions**: What specific questions or angles should the next round explore?{'''
6. **User input response**: Did the panelists adequately address the user's questions/concerns? What was missed?''' if user_input_section else ''}

Focus on actionable feedback that will improve the next round of discussion."""

    try:
        feedback = await _call_with_progress(
            critic,
            stream_content=False,
            messages=[
                {"role": "system", "content": f"You are {critic['name']}, a rigorous analytical critic. {critic.get('persona', '')}"},
                {"role": "user", "content": prompt},
            ],
            phase="reflecting",
        )
        return {
            "critic_feedback": feedback,
            "phase": "reflecting",
            "messages": [{
                "agent_name": critic["name"],
                "agent_role": AgentRole.CRITIC,
                "content": feedback,
                "round_number": state["current_round"],
                "cycle_index": state.get("cycle_index", 0),
                "phase": "reflecting",
            }],
        }
    except Exception as e:
        return {
            "critic_feedback": f"Critic error: {str(e)}",
            "phase": "reflecting",
            "messages": [{
                "agent_name": critic.get("name", "Critic"),
                "agent_role": AgentRole.CRITIC,
                "content": f"[Critic error: {str(e)}]",
                "round_number": state["current_round"],
                "cycle_index": state.get("cycle_index", 0),
                "phase": "reflecting",
            }],
        }


async def host_round_summary_node(state: DiscussionState) -> dict:
    """Host produces a structured summary after each round."""
    host = _get_agent_by_role(state["agents"], AgentRole.HOST)
    if not host:
        return {"phase": "round_summary"}

    current_round = state["current_round"]
    round_msgs = [m for m in state["messages"]
                  if m.get("round_number") == current_round
                  and m.get("phase") in ("discussing", "reflecting")]
    round_history = _format_history_with_anchors(
        round_msgs, max_total_chars=15000, keep_head_rounds=1, keep_tail_messages=20
    )
    critic_feedback = state.get("critic_feedback", "") or "无"
    materials_block = _format_materials(state.get("materials", ""))

    round_user_inputs = [m for m in state["messages"]
                         if m.get("agent_role") == AgentRole.USER
                         and m.get("round_number") == current_round]
    round_user_input_text = _format_user_inputs(round_user_inputs, max_total_chars=2500, max_item_chars=700)

    prompt = f"""你是圆桌讨论的主持人。请对本轮讨论进行结构化总结。

主题: {state['topic']}{materials_block}
当前轮次: 第 {current_round + 1} 轮（共 {state['max_rounds']} 轮）

本轮讨论内容:
{round_history}

评论员反馈:
{critic_feedback}

本轮用户输入（优先级最高）:
{round_user_input_text}

请输出本轮总结，包含:
1. 本轮讨论概述（一句话）
2. 各嘉宾关键观点
3. 评论员主要反馈
4. 用户输入覆盖情况（逐条说明“已回答/部分回答/未回答”）
5. 已达成共识
6. 待解决问题（优先列用户仍未被回答的问题）"""

    try:
        summary_text = await _call_with_progress(
            host,
            stream_content=False,
            use_stream=False,
            messages=[
                {"role": "system", "content": f"You are {host['name']}, summarizing the current round. {host.get('persona', '')}"},
                {"role": "user", "content": prompt},
            ],
            phase="round_summary",
        )
        msg = {
            "agent_name": host["name"],
            "agent_role": AgentRole.HOST,
            "content": summary_text,
            "round_number": current_round,
            "cycle_index": state.get("cycle_index", 0),
            "phase": "round_summary",
        }
        return {
            "round_summaries": [{"round": current_round, "summary": summary_text}],
            "phase": "round_summary",
            "messages": [msg],
        }
    except Exception as e:
        return {
            "round_summaries": [{"round": current_round, "summary": f"[总结失败: {e}]"}],
            "phase": "round_summary",
        }


async def host_next_step_planning_node(state: DiscussionState) -> dict:
    """Host plans what to do next after completing the current round."""
    host = _get_agent_by_role(state["agents"], AgentRole.HOST)
    if not host:
        return {"next_step_plan": "", "phase": "next_step_planning"}

    discussion_id = state.get("discussion_id", 0)
    user_msgs = _pending_user_messages.pop(discussion_id, [])
    injected_messages = []
    queue = progress_queue_var.get(None)
    for um in user_msgs:
        msg_data = {
            "agent_name": um.get("agent_name", "用户"),
            "agent_role": AgentRole.USER,
            "content": um["content"],
            "round_number": um.get("round_number", state["current_round"]),
            "cycle_index": um.get("cycle_index", state.get("cycle_index", 0)),
            "phase": "user_input",
        }
        injected_messages.append(msg_data)
        if queue:
            await queue.put(("user_message_consumed", msg_data))

    materials_block = _format_materials(state.get("materials", ""))
    current_round = state["current_round"]
    latest_round_summary = next(
        (rs["summary"] for rs in reversed(state.get("round_summaries", [])) if rs.get("round") == current_round),
        "（无）",
    )
    user_question_text = _format_user_inputs(user_msgs, max_total_chars=3000, max_item_chars=800)
    all_user_inputs = [m for m in state["messages"] if m.get("agent_role") == AgentRole.USER]
    all_user_input_text = _format_user_inputs(all_user_inputs, max_total_chars=6000, max_item_chars=900)
    critic_feedback = state.get("critic_feedback", "") or "无"
    history = _format_history_with_anchors(state["messages"], max_total_chars=18000, keep_tail_messages=20)

    prompt = f"""你是主持人。第 {current_round + 1} 轮刚结束，请规划下一步。

主题: {state['topic']}{materials_block}

本轮总结:
{latest_round_summary}

评论员反馈:
{critic_feedback}

本轮期间用户新增问题（必须纳入下一步）:
{user_question_text}

历史全部用户输入（同样必须保持对齐）:
{all_user_input_text}

最近讨论上下文:
{history}

请输出一个简洁的“下一步规划”，包含:
1. 下一轮的核心目标（直接对应用户目标）
2. 用户输入覆盖检查：哪些已解决，哪些未解决（逐条）
3. 需要重点追问的 1-3 个问题（优先未解决用户问题）
4. 你建议的推进顺序（先做什么，后做什么）
"""

    try:
        next_step_plan = await _call_with_progress(
            host,
            stream_content=False,
            messages=[
                {"role": "system", "content": f"You are {host['name']}, planning the next step after each round. {host.get('persona', '')}"},
                {"role": "user", "content": prompt},
            ],
            phase="next_step_planning",
        )
        user_block = "\n".join(f"- {m['content']}" for m in user_msgs) if user_msgs else "- （本轮无新增用户插问）"
        msg = {
            "agent_name": host["name"],
            "agent_role": AgentRole.HOST,
            "content": f"下一步规划:\n{next_step_plan.strip()}\n\n本轮回收的用户插问:\n{user_block}",
            "round_number": current_round,
            "cycle_index": state.get("cycle_index", 0),
            "phase": "next_step_planning",
        }
        return {
            "next_step_plan": next_step_plan,
            "phase": "next_step_planning",
            "messages": injected_messages + [msg],
        }
    except Exception as e:
        return {
            "next_step_plan": f"[下一步规划失败: {e}]",
            "phase": "next_step_planning",
        }


def should_continue_or_synthesize(state: DiscussionState) -> str:
    """After next-step planning, decide to continue to next round or finalize."""
    if state.get("error"):
        return "synthesize"
    if state["current_round"] >= state["max_rounds"] - 1:
        return "synthesize"
    return "continue"


def route_after_host_planning(state: DiscussionState) -> str:
    """Always execute panelist stage to keep a strict round workflow."""
    return "panelists"


def route_after_panelist_discussion(state: DiscussionState) -> str:
    """Incremental follow-up skips critic; full rounds include critic."""
    if state.get("single_round_mode"):
        return "round_summary"
    return "critic"


def route_after_round_summary(state: DiscussionState) -> str:
    """Incremental follow-up stops after summary; full rounds continue to next-step planning."""
    if state.get("single_round_mode"):
        return "stop"
    return "next_step"


async def increment_round(state: DiscussionState) -> dict:
    return {"current_round": state["current_round"] + 1, "next_step_plan": ""}


async def synthesis_node(state: DiscussionState) -> dict:
    """Host creates the final synthesis of the discussion."""
    host = _get_agent_by_role(state["agents"], AgentRole.HOST)
    if not host:
        return {"final_summary": "No host to synthesize.", "phase": "synthesizing"}

    history = _format_history_with_anchors(state["messages"], max_total_chars=35000, keep_tail_messages=30)
    materials_block = _format_materials(state.get("materials", ""))
    round_summaries_text = _format_round_summaries(state.get("round_summaries", []), max_total_chars=8000, max_item_chars=1200)

    user_inputs = [m for m in state["messages"] if m.get("agent_role") == AgentRole.USER]
    user_input_text = _format_user_inputs(user_inputs, max_total_chars=6000, max_item_chars=900)

    prompt = f"""You are the Host wrapping up the round table discussion.

Topic: {state['topic']}{materials_block}

Complete discussion history:
{history}

Round summaries:
{round_summaries_text}

All user inputs to satisfy:
{user_input_text}

Create a comprehensive final synthesis that:
1. Summarizes the key insights from each panelist
2. Notes where consensus was reached
3. Highlights resolved and unresolved disagreements
4. Explicitly checks each user request: answered / partially answered / unanswered
5. Lists concrete recommendations or conclusions
6. Notes any caveats or areas needing further exploration

Format as a well-structured report."""

    try:
        summary = await _call_with_progress(
            host,
            stream_content=False,
            messages=[
                {"role": "system", "content": f"You are {host['name']}, synthesizing the discussion into a final report. {host.get('persona', '')}"},
                {"role": "user", "content": prompt},
            ],
            phase="synthesizing",
        )
        return {
            "final_summary": summary,
            "phase": "synthesizing",
            "messages": [{
                "agent_name": host["name"],
                "agent_role": AgentRole.HOST,
                "content": summary,
                "round_number": state["current_round"],
                "cycle_index": state.get("cycle_index", 0),
                "phase": "synthesizing",
            }],
        }
    except Exception as e:
        # Keep workflow completed with a fallback summary instead of hard-failing.
        fallback_summary = (
            "最终综合阶段调用异常，已返回降级总结。\n\n"
            f"异常信息: {str(e)}\n"
            "建议：请重试一次综合，或在下一轮输入中指定需要重点整合的结论。"
        )
        return {
            "final_summary": fallback_summary,
            "phase": "synthesizing",
            "messages": [{
                "agent_name": host["name"],
                "agent_role": AgentRole.HOST,
                "content": fallback_summary,
                "round_number": state["current_round"],
                "cycle_index": state.get("cycle_index", 0),
                "phase": "synthesizing",
            }],
        }


def build_discussion_graph() -> StateGraph:
    """Build the LangGraph state graph for the discussion workflow."""
    graph = StateGraph(DiscussionState)

    graph.add_node("host_planning", host_planning_node)
    graph.add_node("panelist_discussion", panelist_discussion_node)
    graph.add_node("critic_review", critic_node)
    graph.add_node("increment_round", increment_round)
    graph.add_node("synthesis", synthesis_node)
    graph.add_node("host_round_summary", host_round_summary_node)
    graph.add_node("host_next_step_planning", host_next_step_planning_node)

    graph.set_entry_point("host_planning")
    graph.add_conditional_edges(
        "host_planning",
        route_after_host_planning,
        {
            "panelists": "panelist_discussion",
        },
    )
    graph.add_conditional_edges(
        "panelist_discussion",
        route_after_panelist_discussion,
        {
            "critic": "critic_review",
            "round_summary": "host_round_summary",
        },
    )
    graph.add_edge("critic_review", "host_round_summary")
    graph.add_conditional_edges(
        "host_round_summary",
        route_after_round_summary,
        {
            "next_step": "host_next_step_planning",
            "stop": END,
        },
    )
    graph.add_conditional_edges(
        "host_next_step_planning",
        should_continue_or_synthesize,
        {
            "continue": "increment_round",
            "synthesize": "synthesis",
        },
    )
    graph.add_edge("increment_round", "host_planning")
    graph.add_edge("synthesis", END)

    return graph.compile()
