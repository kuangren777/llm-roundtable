"""Predefined agent templates for each orchestration mode.

Each template defines the agents (name, role, persona) that will be
auto-generated when a user selects a non-custom mode.  The user's
LLM configs are cycled round-robin across the generated agents.
"""
from ..models.models import AgentRole, DiscussionMode


# Each entry: {"name": str, "role": AgentRole, "persona": str}
MODE_TEMPLATES: dict[DiscussionMode, list[dict]] = {
    DiscussionMode.DEBATE: [
        {
            "name": "主持人",
            "role": AgentRole.HOST,
            "persona": "公正的辩论主持人，负责引导讨论、总结观点、确保双方公平发言。",
        },
        {
            "name": "正方辩手",
            "role": AgentRole.PANELIST,
            "persona": "支持该观点的辩手，提供有力论据和证据来支持正方立场。",
        },
        {
            "name": "反方辩手",
            "role": AgentRole.PANELIST,
            "persona": "反对该观点的辩手，提出质疑和反驳，寻找正方论证的漏洞。",
        },
        {
            "name": "评判员",
            "role": AgentRole.CRITIC,
            "persona": "客观的评判者，分析双方论点的逻辑性、证据充分性和说服力。",
        },
    ],
    DiscussionMode.BRAINSTORM: [
        {
            "name": "主持人",
            "role": AgentRole.HOST,
            "persona": "创意工作坊主持人，鼓励发散思维，引导团队探索多种可能性。",
        },
        {
            "name": "创意专家A",
            "role": AgentRole.PANELIST,
            "persona": "擅长跨领域联想的创意思考者，善于从不同行业和学科中寻找灵感。",
        },
        {
            "name": "创意专家B",
            "role": AgentRole.PANELIST,
            "persona": "注重用户体验和实际需求的创新者，善于将抽象概念转化为可行方案。",
        },
        {
            "name": "创意专家C",
            "role": AgentRole.PANELIST,
            "persona": "技术导向的创新者，关注前沿技术趋势和技术可行性。",
        },
        {
            "name": "批评家",
            "role": AgentRole.CRITIC,
            "persona": "建设性的批评者，评估创意的可行性、风险和改进空间，帮助收敛到最佳方案。",
        },
    ],
    DiscussionMode.SEQUENTIAL: [
        {
            "name": "主持人",
            "role": AgentRole.HOST,
            "persona": "评审流程主持人，确保每位评审员依次发言，后者基于前者的反馈进行改进。",
        },
        {
            "name": "评审员A",
            "role": AgentRole.PANELIST,
            "persona": "第一轮评审员，提供初步分析和基础评估。",
        },
        {
            "name": "评审员B",
            "role": AgentRole.PANELIST,
            "persona": "第二轮评审员，基于前一位评审的反馈进行深入分析和补充。",
        },
        {
            "name": "评审员C",
            "role": AgentRole.PANELIST,
            "persona": "第三轮评审员，综合前两位评审的意见，提出最终改进建议。",
        },
        {
            "name": "质量检查员",
            "role": AgentRole.CRITIC,
            "persona": "最终质量把关者，检查所有评审意见的一致性和完整性。",
        },
    ],
}


def get_mode_template(mode: DiscussionMode) -> list[dict]:
    """Return the agent template list for a given mode."""
    return MODE_TEMPLATES.get(mode, [])


def assign_llms_to_agents(
    agent_defs: list[dict],
    llm_configs: list[dict],
) -> list[dict]:
    """Assign LLM configs to agents via round-robin cycling.

    Each agent_def gets provider/model/api_key/base_url from the
    llm_configs list, cycling if there are more agents than LLMs.
    """
    if not llm_configs:
        return agent_defs

    result = []
    for i, agent in enumerate(agent_defs):
        llm = llm_configs[i % len(llm_configs)]
        result.append({
            **agent,
            "provider": llm.get("provider", "openai"),
            "model": llm.get("model", "gpt-4o"),
            "api_key": llm.get("api_key"),
            "base_url": llm.get("base_url"),
        })
    return result
