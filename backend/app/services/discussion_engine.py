"""LangGraph-based multi-agent discussion engine.

Implements the Intelligent Round Table Host Pattern:
  Host (Orchestrator) -> Panelists (Workers, parallel) -> Critic -> iterate or synthesize
"""
import asyncio
import contextvars
import json
import re
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
    single_round_mode: bool  # True when resuming — run one round, optional synthesis by host decision
    selected_panelists: list[str]
    panelist_tasks: dict[str, str]
    routing_constraints: dict
    needs_synthesis: bool
    execution_mode: str  # "panelists" | "host_only"
    intent_judgment: str
    host_position: str
    open_tasks: list[str]
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
    return f"\n\n参考材料:\n{materials}"


def _format_history(messages: list[dict], last_n: Optional[int] = 20) -> str:
    if last_n is None or last_n <= 0:
        recent = messages
    else:
        recent = messages[-last_n:] if len(messages) > last_n else messages
    lines = []
    for m in recent:
        lines.append(f"[{m.get('agent_name', '?')} ({m.get('phase', '?')})]: {m['content']}")
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


async def _call_with_progress(agent: AgentInfo, messages: list[dict], phase: str = "", **kwargs) -> str:
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

    chunk_count = 0

    async def on_chunk(delta: str, total_chars: int):
        nonlocal chunk_count
        chunk_count += 1
        # Emit first chunk immediately, then throttle every 5 chunks
        if chunk_count == 1 or chunk_count % 5 == 0:
            await queue.put(("progress_event", {
                "agent_name": agent["name"],
                "chars": total_chars,
                "status": "streaming",
                "phase": phase,
            }))

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

    # Consume pending user messages (non-blocking injection)
    discussion_id = state.get("discussion_id", 0)
    user_msgs = _pending_user_messages.pop(discussion_id, [])
    injected_messages = []
    queue = progress_queue_var.get(None)
    for um in user_msgs:
        msg_data = {
            "agent_name": um.get("agent_name", "用户"),
            "agent_role": AgentRole.USER,
            "content": um["content"],
            "round_number": state["current_round"],
            "cycle_index": um.get("cycle_index", state.get("cycle_index", 0)),
            "phase": "user_input",
        }
        injected_messages.append(msg_data)
        # Notify frontend that the message was consumed
        if queue:
            await queue.put(("user_message_consumed", msg_data))

    panelists = _get_agents_by_role(state["agents"], AgentRole.PANELIST)
    if not panelists:
        return {"error": "No panelist agents configured", "phase": "error"}
    panelist_desc = "\n".join(
        f"- {p['name']}: {p.get('persona', 'General expert')}" for p in panelists
    )

    history = _format_history(state["messages"], last_n=None)
    materials_block = _format_materials(state.get("materials", ""))

    # Extract recent user messages for explicit highlighting
    user_inputs = [m for m in state["messages"] if m.get("agent_role") == AgentRole.USER]
    recent_user_inputs = user_inputs[-3:]  # last 3 user messages
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
    user_input_text = "\n".join(f"- {m['content']}" for m in recent_user_inputs) or "- （无）"
    critic_feedback = state.get("critic_feedback", "") or "None"
    synthesis_rule = (
        "本轮结束后你要决定是否需要主持人综合总结（needs_synthesis=true/false）。"
        if state.get("single_round_mode")
        else "多轮阶段不需要设置综合总结（needs_synthesis 固定 false）。"
    )

    prompt = f"""You are the Host of an expert round table discussion.

Current stage: {round_context}
Topic: {state['topic']}{materials_block}

Previous discussion history:
{history}

Latest user inputs:
{user_input_text}

Critic feedback from last round:
{critic_feedback}

Available panelists:
{panelist_desc}

Hard routing constraints (must follow if provided):
{constraints_block}

Your job:
1) Infer user intent and state it clearly in "intent_judgment".
2) Provide your own host viewpoint in "host_position" (do not just repeat user words).
3) Output a concise mainline in "discussion_plan".
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
  "assignments": [{{"panelist":"name1","task":"..."}}, {{"panelist":"name2","task":"..."}}],
  "open_tasks": ["follow-up task 1", "follow-up task 2"],
  "needs_synthesis": false
}}

Never select unknown names. If user named specific panelists, only choose among them.
If execution_mode is "host_only", set selected_panelists to [] and assignments to []."""

    try:
        plan = await _call_with_progress(
            host,
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
            "messages": injected_messages + [host_msg],
        }
    except Exception as e:
        return {"error": f"Host planning failed: {str(e)}", "phase": "error"}


async def panelist_discussion_node(state: DiscussionState) -> dict:
    """Selected panelists respond in parallel based on host routing."""
    all_panelists = _get_agents_by_role(state["agents"], AgentRole.PANELIST)
    if not all_panelists:
        return {"error": "No panelist agents configured", "phase": "error"}

    selected_names = state.get("selected_panelists") or [str(p["name"]) for p in all_panelists]
    panelists = [p for p in all_panelists if p["name"] in selected_names]
    if not panelists:
        panelists = all_panelists[:1]

    history = _format_history(state["messages"], last_n=None)
    materials_block = _format_materials(state.get("materials", ""))

    # Extract user messages for explicit highlighting in panelist prompts
    user_inputs = [m for m in state["messages"] if m.get("agent_role") == AgentRole.USER]
    recent_user_inputs = user_inputs[-3:]
    user_input_block = ""
    if recent_user_inputs:
        user_input_text = "\n".join(f"- {m['content']}" for m in recent_user_inputs)
        user_input_block = f"\n\n⚠️ 用户新的输入/问题（请重点回应）:\n{user_input_text}"
    panelist_tasks = state.get("panelist_tasks", {})

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
                messages=[
                    {"role": "system", "content": f"You are {panelist['name']}. {panelist.get('persona', '')} Respond thoughtfully and specifically."},
                    {"role": "user", "content": prompt},
                ],
                phase="discussing",
            )
            return {
                "agent_name": panelist["name"],
                "agent_role": AgentRole.PANELIST,
                "content": response,
                "round_number": state["current_round"],
                "cycle_index": state.get("cycle_index", 0),
                "phase": "discussing",
            }
        except Exception as e:
            return {
                "agent_name": panelist["name"],
                "agent_role": AgentRole.PANELIST,
                "content": f"[Error: {str(e)}]",
                "round_number": state["current_round"],
                "cycle_index": state.get("cycle_index", 0),
                "phase": "discussing",
            }

    # Run all panelists in parallel
    results = await asyncio.gather(*[_panelist_respond(p) for p in panelists])
    return {"messages": list(results), "phase": "discussing"}


async def critic_node(state: DiscussionState) -> dict:
    """Critic evaluates the discussion and identifies gaps/contradictions."""
    critic = _get_agent_by_role(state["agents"], AgentRole.CRITIC)
    if not critic:
        return {"critic_feedback": "No critic configured - skipping review.", "phase": "reflecting"}

    history = _format_history(state["messages"], last_n=None)
    materials_block = _format_materials(state.get("materials", ""))

    # Highlight user input for critic evaluation
    user_inputs = [m for m in state["messages"] if m.get("agent_role") == AgentRole.USER]
    recent_user_inputs = user_inputs[-3:]
    user_input_section = ""
    if recent_user_inputs:
        user_input_text = "\n".join(f"- {m['content']}" for m in recent_user_inputs)
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


def should_continue_or_synthesize(state: DiscussionState) -> str:
    """Decide whether to continue iterating or move to synthesis.

    Pure round-counting — no VERDICT parsing. This prevents the LLM from
    short-circuiting multi-round discussions by outputting SYNTHESIZE early.
    In single_round_mode (post-completion follow-up), synthesize only when
    the host explicitly asks for it.
    """
    if state.get("error"):
        return "synthesize"
    if state.get("single_round_mode"):
        return "synthesize" if state.get("needs_synthesis") else "stop"
    if state["current_round"] >= state["max_rounds"] - 1:
        return "synthesize"
    return "continue"


def route_after_host_planning(state: DiscussionState) -> str:
    """Choose between panelist flow and host-only direct output."""
    if state.get("execution_mode") == "host_only":
        return "synthesize" if state.get("needs_synthesis") else "stop"
    return "panelists"


async def increment_round(state: DiscussionState) -> dict:
    return {"current_round": state["current_round"] + 1}


async def synthesis_node(state: DiscussionState) -> dict:
    """Host creates the final synthesis of the discussion."""
    host = _get_agent_by_role(state["agents"], AgentRole.HOST)
    if not host:
        return {"final_summary": "No host to synthesize.", "phase": "synthesizing"}

    history = _format_history(state["messages"], last_n=None)
    materials_block = _format_materials(state.get("materials", ""))

    prompt = f"""You are the Host wrapping up the round table discussion.

Topic: {state['topic']}{materials_block}

Complete discussion history:
{history}

Create a comprehensive final synthesis that:
1. Summarizes the key insights from each panelist
2. Notes where consensus was reached
3. Highlights resolved and unresolved disagreements
4. Lists concrete recommendations or conclusions
5. Notes any caveats or areas needing further exploration

Format as a well-structured report."""

    try:
        summary = await _call_with_progress(
            host,
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
        return {
            "final_summary": f"Synthesis failed: {str(e)}",
            "phase": "error",
        }


def build_discussion_graph() -> StateGraph:
    """Build the LangGraph state graph for the discussion workflow."""
    graph = StateGraph(DiscussionState)

    graph.add_node("host_planning", host_planning_node)
    graph.add_node("panelist_discussion", panelist_discussion_node)
    graph.add_node("critic_review", critic_node)
    graph.add_node("increment_round", increment_round)
    graph.add_node("synthesis", synthesis_node)

    graph.set_entry_point("host_planning")
    graph.add_conditional_edges(
        "host_planning",
        route_after_host_planning,
        {
            "panelists": "panelist_discussion",
            "synthesize": "synthesis",
            "stop": END,
        },
    )
    graph.add_edge("panelist_discussion", "critic_review")
    graph.add_conditional_edges(
        "critic_review",
        should_continue_or_synthesize,
        {
            "continue": "increment_round",
            "synthesize": "synthesis",
            "stop": END,
        },
    )
    graph.add_edge("increment_round", "host_planning")
    graph.add_edge("synthesis", END)

    return graph.compile()
