"""Tests for mode templates and planner utilities."""
import sys
import os
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.app.services.mode_templates import get_mode_template, assign_llms_to_agents
from backend.app.services.planner import _parse_planner_response, _default_panel
from backend.app.models.models import DiscussionMode, AgentRole


class TestGetModeTemplate:
    def test_debate_template(self):
        agents = get_mode_template(DiscussionMode.DEBATE)
        assert len(agents) == 4
        roles = [a["role"] for a in agents]
        assert AgentRole.HOST in roles
        assert AgentRole.CRITIC in roles
        assert roles.count(AgentRole.PANELIST) == 2

    def test_brainstorm_template(self):
        agents = get_mode_template(DiscussionMode.BRAINSTORM)
        assert len(agents) == 5
        roles = [a["role"] for a in agents]
        assert AgentRole.HOST in roles
        assert AgentRole.CRITIC in roles
        assert roles.count(AgentRole.PANELIST) == 3

    def test_sequential_template(self):
        agents = get_mode_template(DiscussionMode.SEQUENTIAL)
        assert len(agents) == 5
        roles = [a["role"] for a in agents]
        assert AgentRole.HOST in roles
        assert AgentRole.CRITIC in roles
        assert roles.count(AgentRole.PANELIST) == 3

    def test_auto_returns_empty(self):
        # Auto mode uses planner, not templates
        agents = get_mode_template(DiscussionMode.AUTO)
        assert agents == []

    def test_custom_returns_empty(self):
        agents = get_mode_template(DiscussionMode.CUSTOM)
        assert agents == []

    def test_all_agents_have_required_fields(self):
        for mode in [DiscussionMode.DEBATE, DiscussionMode.BRAINSTORM, DiscussionMode.SEQUENTIAL]:
            for agent in get_mode_template(mode):
                assert "name" in agent
                assert "role" in agent
                assert "persona" in agent
                assert isinstance(agent["role"], AgentRole)


class TestAssignLlmsToAgents:
    def test_round_robin_assignment(self):
        agents = [
            {"name": "A", "role": AgentRole.HOST},
            {"name": "B", "role": AgentRole.PANELIST},
            {"name": "C", "role": AgentRole.PANELIST},
            {"name": "D", "role": AgentRole.CRITIC},
        ]
        llms = [
            {"provider": "openai", "model": "gpt-4o"},
            {"provider": "anthropic", "model": "claude-3"},
        ]
        result = assign_llms_to_agents(agents, llms)
        assert result[0]["provider"] == "openai"
        assert result[1]["provider"] == "anthropic"
        assert result[2]["provider"] == "openai"  # cycles back
        assert result[3]["provider"] == "anthropic"

    def test_single_llm_assigned_to_all(self):
        agents = [{"name": "A"}, {"name": "B"}, {"name": "C"}]
        llms = [{"provider": "deepseek", "model": "deepseek-chat"}]
        result = assign_llms_to_agents(agents, llms)
        assert all(a["provider"] == "deepseek" for a in result)

    def test_empty_llms_returns_unchanged(self):
        agents = [{"name": "A", "role": AgentRole.HOST}]
        result = assign_llms_to_agents(agents, [])
        assert result == agents

    def test_preserves_existing_fields(self):
        agents = [{"name": "Host", "role": AgentRole.HOST, "persona": "A moderator"}]
        llms = [{"provider": "openai", "model": "gpt-4o"}]
        result = assign_llms_to_agents(agents, llms)
        assert result[0]["name"] == "Host"
        assert result[0]["persona"] == "A moderator"
        assert result[0]["provider"] == "openai"


class TestParsePlannerResponse:
    def test_valid_json(self):
        response = '''[
            {"name": "主持人", "role": "host", "persona": "A host"},
            {"name": "Expert", "role": "panelist", "persona": "An expert"},
            {"name": "Critic", "role": "critic", "persona": "A critic"}
        ]'''
        agents = _parse_planner_response(response)
        assert len(agents) == 3
        assert agents[0]["role"] == AgentRole.HOST
        assert agents[1]["role"] == AgentRole.PANELIST

    def test_json_with_code_fences(self):
        response = '''```json
[
    {"name": "主持人", "role": "host", "persona": "Host"},
    {"name": "Expert", "role": "panelist", "persona": "Expert"}
]
```'''
        agents = _parse_planner_response(response)
        assert len(agents) == 2

    def test_invalid_json_returns_empty(self):
        assert _parse_planner_response("not json") == []

    def test_missing_host_returns_empty(self):
        response = '[{"name": "Expert", "role": "panelist", "persona": "X"}]'
        assert _parse_planner_response(response) == []

    def test_missing_panelist_returns_empty(self):
        response = '[{"name": "Host", "role": "host", "persona": "X"}]'
        assert _parse_planner_response(response) == []

    def test_skips_invalid_roles(self):
        response = '''[
            {"name": "Host", "role": "host", "persona": "H"},
            {"name": "E", "role": "panelist", "persona": "E"},
            {"name": "Bad", "role": "unknown_role", "persona": "X"}
        ]'''
        agents = _parse_planner_response(response)
        assert len(agents) == 2  # unknown_role skipped


class TestDefaultPanel:
    def test_has_required_roles(self):
        panel = _default_panel()
        roles = [a["role"] for a in panel]
        assert AgentRole.HOST in roles
        assert AgentRole.PANELIST in roles
        assert AgentRole.CRITIC in roles

    def test_at_least_four_agents(self):
        assert len(_default_panel()) >= 4
