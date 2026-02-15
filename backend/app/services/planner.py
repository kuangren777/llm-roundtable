"""Auto-mode planner: uses the first LLM to analyze the topic and generate agents."""
import json
from typing import Optional
from .llm_service import call_llm
from ..models.models import AgentRole

PLANNER_PROMPT = """You are an AI discussion planner. Given a topic, you must design the optimal panel of experts for a round table discussion.

Topic: {topic}

Design a panel of 3-5 experts (plus a host and a critic) that would provide the most insightful, multi-perspective discussion on this topic.

You MUST respond with valid JSON only, no other text. Use this exact format:
[
  {{"name": "主持人", "role": "host", "persona": "Brief description of the host's approach"}},
  {{"name": "Expert Name", "role": "panelist", "persona": "Brief description of expertise and perspective"}},
  ...more panelists...,
  {{"name": "Critic Name", "role": "critic", "persona": "Brief description of the critic's analytical focus"}}
]

Rules:
- Always include exactly 1 host (role: "host") and 1 critic (role: "critic")
- Include 2-4 panelists (role: "panelist") with diverse, complementary perspectives
- Use Chinese names and personas
- Each persona should be specific to the topic, not generic
- The host should be named 主持人
"""

ROLE_MAP = {"host": AgentRole.HOST, "panelist": AgentRole.PANELIST, "critic": AgentRole.CRITIC}


async def plan_agents(
    topic: str,
    provider: str,
    model: str,
    api_key: Optional[str] = None,
    base_url: Optional[str] = None,
) -> list[dict]:
    """Call the planner LLM to generate an optimal agent panel for the topic.

    Returns a list of dicts with keys: name, role (AgentRole), persona.
    Falls back to a default panel on failure.
    """
    try:
        response = await call_llm(
            provider=provider,
            model=model,
            messages=[
                {"role": "system", "content": "You are a discussion planning assistant. Respond with valid JSON only."},
                {"role": "user", "content": PLANNER_PROMPT.format(topic=topic)},
            ],
            api_key=api_key,
            base_url=base_url,
            temperature=0.5,
            max_tokens=1500,
        )
        agents = _parse_planner_response(response)
        if agents:
            return agents
    except Exception:
        pass

    # Fallback: generic panel
    return _default_panel()


def _parse_planner_response(response: str) -> list[dict]:
    """Parse the JSON response from the planner LLM."""
    # Strip markdown code fences if present
    text = response.strip()
    if text.startswith("```"):
        lines = text.split("\n")
        lines = [l for l in lines if not l.strip().startswith("```")]
        text = "\n".join(lines)

    try:
        raw = json.loads(text)
    except json.JSONDecodeError:
        return []

    if not isinstance(raw, list):
        return []

    agents = []
    for item in raw:
        role_str = item.get("role", "").lower()
        role = ROLE_MAP.get(role_str)
        if not role or not item.get("name"):
            continue
        agents.append({
            "name": item["name"],
            "role": role,
            "persona": item.get("persona", ""),
        })

    # Validate: must have at least 1 host and 1 panelist
    roles = [a["role"] for a in agents]
    if AgentRole.HOST not in roles or AgentRole.PANELIST not in roles:
        return []

    return agents


def _default_panel() -> list[dict]:
    """Fallback panel when the planner LLM fails."""
    return [
        {"name": "主持人", "role": AgentRole.HOST, "persona": "经验丰富的讨论主持人，善于引导深入对话。"},
        {"name": "专家A", "role": AgentRole.PANELIST, "persona": "该领域的资深研究者，注重理论分析。"},
        {"name": "专家B", "role": AgentRole.PANELIST, "persona": "实践导向的从业者，关注实际应用和案例。"},
        {"name": "批评家", "role": AgentRole.CRITIC, "persona": "严谨的分析者，善于发现逻辑漏洞和盲点。"},
    ]
