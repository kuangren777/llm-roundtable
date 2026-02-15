"""LangGraph-based multi-agent discussion engine.

Implements the Intelligent Round Table Host Pattern:
  Host (Orchestrator) -> Panelists (Workers, parallel) -> Critic -> iterate or synthesize
"""
import asyncio
import contextvars
import json
from typing import TypedDict, Annotated, Optional
from langgraph.graph import StateGraph, END
from ..services.llm_service import call_llm, call_llm_stream
from ..models.models import AgentRole

# Queue for pushing LLM progress events out of graph nodes
progress_queue_var: contextvars.ContextVar[asyncio.Queue | None] = contextvars.ContextVar(
    'progress_queue', default=None
)


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


def _format_history(messages: list[dict], last_n: int = 20) -> str:
    recent = messages[-last_n:] if len(messages) > last_n else messages
    lines = []
    for m in recent:
        lines.append(f"[{m.get('agent_name', '?')} ({m.get('phase', '?')})]: {m['content']}")
    return "\n\n".join(lines)


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

    chunk_count = 0

    async def on_chunk(delta: str, total_chars: int):
        nonlocal chunk_count
        chunk_count += 1
        # Throttle: emit progress every 5 chunks
        if chunk_count % 5 == 0:
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

    panelists = _get_agents_by_role(state["agents"], AgentRole.PANELIST)
    panelist_desc = "\n".join(
        f"- {p['name']}: {p.get('persona', 'General expert')}" for p in panelists
    )

    is_first_round = state["current_round"] == 0
    history = _format_history(state["messages"])
    materials_block = _format_materials(state.get("materials", ""))

    if is_first_round:
        prompt = f"""You are the Host of an expert round table discussion. Your job is NOT to answer the question yourself, but to orchestrate a productive discussion.

Topic: {state['topic']}{materials_block}

Available panelists:
{panelist_desc}

Your tasks:
1. Break down the topic into 2-3 specific sub-questions tailored to each panelist's expertise
2. Assign each panelist a specific angle to address
3. Set the tone and scope for this round

Output a structured plan in this format:
## Discussion Plan
[Brief analysis of the topic]

## Assignments
- [Panelist Name]: [Specific question/angle for them to address]
..."""
    else:
        prompt = f"""You are the Host of an expert round table discussion, now in round {state['current_round'] + 1}.

Topic: {state['topic']}{materials_block}

Previous discussion:
{history}

Critic's feedback from last round:
{state.get('critic_feedback', 'None')}

Available panelists:
{panelist_desc}

Based on the critic's feedback and gaps identified, create follow-up questions for the panelists. Focus on:
1. Addressing contradictions or blind spots the critic identified
2. Deepening the analysis where needed
3. Exploring new angles that emerged

## Follow-up Assignments
- [Panelist Name]: [Specific follow-up question]
..."""

    try:
        plan = await _call_with_progress(
            host,
            messages=[
                {"role": "system", "content": f"You are {host['name']}, a skilled discussion moderator. {host.get('persona', '')}"},
                {"role": "user", "content": prompt},
            ],
            phase="planning",
        )
        return {
            "host_plan": plan,
            "phase": "planning",
            "messages": [{
                "agent_name": host["name"],
                "agent_role": AgentRole.HOST,
                "content": plan,
                "round_number": state["current_round"],
                "phase": "planning",
            }],
        }
    except Exception as e:
        return {"error": f"Host planning failed: {str(e)}", "phase": "error"}


async def panelist_discussion_node(state: DiscussionState) -> dict:
    """All panelists respond in parallel to the host's plan."""
    panelists = _get_agents_by_role(state["agents"], AgentRole.PANELIST)
    if not panelists:
        return {"error": "No panelist agents configured", "phase": "error"}

    history = _format_history(state["messages"])
    materials_block = _format_materials(state.get("materials", ""))

    async def _panelist_respond(panelist: AgentInfo) -> dict:
        prompt = f"""You are participating in an expert round table discussion.

Topic: {state['topic']}{materials_block}

The host's current plan/questions:
{state['host_plan']}

Previous discussion (if any):
{history}

You are {panelist['name']}. Your expertise/persona: {panelist.get('persona', 'General expert')}

Respond to the host's questions from your unique perspective. Be specific, provide concrete examples or data points where possible. If you disagree with another panelist's previous point, explain why constructively."""

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
                "phase": "discussing",
            }
        except Exception as e:
            return {
                "agent_name": panelist["name"],
                "agent_role": AgentRole.PANELIST,
                "content": f"[Error: {str(e)}]",
                "round_number": state["current_round"],
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

    history = _format_history(state["messages"])
    materials_block = _format_materials(state.get("materials", ""))

    prompt = f"""You are the Critic in an expert round table discussion. Your job is to be rigorous and constructive.

Topic: {state['topic']}{materials_block}
Current round: {state['current_round'] + 1} of {state['max_rounds']}

Full discussion so far:
{history}

Analyze the discussion and identify:
1. **Contradictions**: Where do panelists disagree? Are these resolved?
2. **Blind spots**: What important aspects haven't been addressed?
3. **Logical gaps**: Are there unsupported claims or weak reasoning?
4. **Missing perspectives**: What viewpoints are absent?

If this is the final round or the discussion is sufficiently thorough, indicate that synthesis can proceed.

End with either:
- "VERDICT: CONTINUE" (if more discussion is needed)
- "VERDICT: SYNTHESIZE" (if ready for final summary)"""

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
                "phase": "reflecting",
            }],
        }


def should_continue_or_synthesize(state: DiscussionState) -> str:
    """Decide whether to continue iterating or move to synthesis."""
    if state.get("error"):
        return "synthesize"
    if state["current_round"] >= state["max_rounds"] - 1:
        return "synthesize"
    feedback = state.get("critic_feedback", "")
    if "VERDICT: SYNTHESIZE" in feedback.upper():
        return "synthesize"
    return "continue"


async def increment_round(state: DiscussionState) -> dict:
    return {"current_round": state["current_round"] + 1}


async def synthesis_node(state: DiscussionState) -> dict:
    """Host creates the final synthesis of the discussion."""
    host = _get_agent_by_role(state["agents"], AgentRole.HOST)
    if not host:
        return {"final_summary": "No host to synthesize.", "phase": "synthesizing"}

    history = _format_history(state["messages"], last_n=50)
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
            max_tokens=3000,
        )
        return {
            "final_summary": summary,
            "phase": "synthesizing",
            "messages": [{
                "agent_name": host["name"],
                "agent_role": AgentRole.HOST,
                "content": summary,
                "round_number": state["current_round"],
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
    graph.add_edge("host_planning", "panelist_discussion")
    graph.add_edge("panelist_discussion", "critic_review")
    graph.add_conditional_edges(
        "critic_review",
        should_continue_or_synthesize,
        {
            "continue": "increment_round",
            "synthesize": "synthesis",
        },
    )
    graph.add_edge("increment_round", "host_planning")
    graph.add_edge("synthesis", END)

    return graph.compile()
