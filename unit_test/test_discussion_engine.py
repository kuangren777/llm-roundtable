"""Tests for discussion engine helper functions and graph structure."""
import sys
import os
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.app.services.discussion_engine import (
    _get_agent_by_role,
    _get_agents_by_role,
    _format_history,
    should_continue_or_synthesize,
    AgentInfo,
)
from backend.app.models.models import AgentRole


def _make_agent(name="TestAgent", role="host", **kwargs) -> AgentInfo:
    return AgentInfo(
        name=name,
        role=role,
        persona=kwargs.get("persona", ""),
        provider=kwargs.get("provider", "openai"),
        model=kwargs.get("model", "gpt-4o"),
        api_key=kwargs.get("api_key", None),
        base_url=kwargs.get("base_url", None),
    )


def _make_state(**overrides) -> dict:
    defaults = {
        "topic": "test topic",
        "agents": [],
        "messages": [],
        "current_round": 0,
        "max_rounds": 3,
        "host_plan": "",
        "critic_feedback": "",
        "should_continue": True,
        "final_summary": "",
        "phase": "planning",
        "error": None,
        "discussion_id": 0,
    }
    defaults.update(overrides)
    return defaults


class TestGetAgentByRole:
    def test_finds_host(self):
        agents = [_make_agent("Host", "host"), _make_agent("Expert", "panelist")]
        result = _get_agent_by_role(agents, AgentRole.HOST)
        assert result is not None
        assert result["name"] == "Host"

    def test_returns_none_when_missing(self):
        agents = [_make_agent("Expert", "panelist")]
        assert _get_agent_by_role(agents, AgentRole.HOST) is None

    def test_returns_first_match(self):
        agents = [_make_agent("A", "panelist"), _make_agent("B", "panelist")]
        result = _get_agent_by_role(agents, AgentRole.PANELIST)
        assert result["name"] == "A"


class TestGetAgentsByRole:
    def test_finds_all_panelists(self):
        agents = [
            _make_agent("Host", "host"),
            _make_agent("A", "panelist"),
            _make_agent("B", "panelist"),
            _make_agent("Critic", "critic"),
        ]
        result = _get_agents_by_role(agents, AgentRole.PANELIST)
        assert len(result) == 2
        assert {a["name"] for a in result} == {"A", "B"}

    def test_empty_when_no_match(self):
        agents = [_make_agent("Host", "host")]
        assert _get_agents_by_role(agents, AgentRole.CRITIC) == []


class TestFormatHistory:
    def test_formats_messages(self):
        messages = [
            {"agent_name": "Host", "phase": "planning", "content": "Let's discuss X"},
            {"agent_name": "Expert", "phase": "discussing", "content": "I think Y"},
        ]
        result = _format_history(messages)
        assert "[Host (planning)]:" in result
        assert "[Expert (discussing)]:" in result
        assert "Let's discuss X" in result

    def test_truncates_to_last_n(self):
        messages = [{"agent_name": f"Agent{i}", "phase": "p", "content": f"msg{i}"} for i in range(30)]
        result = _format_history(messages, last_n=5)
        assert "Agent25" in result
        assert "Agent0" not in result

    def test_handles_empty(self):
        assert _format_history([]) == ""

    def test_handles_missing_fields(self):
        messages = [{"content": "hello"}]
        result = _format_history(messages)
        assert "[? (?)]:" in result


class TestShouldContinueOrSynthesize:
    def test_synthesize_on_error(self):
        state = _make_state(error="something broke")
        assert should_continue_or_synthesize(state) == "synthesize"

    def test_synthesize_on_max_rounds(self):
        state = _make_state(current_round=2, max_rounds=3)
        assert should_continue_or_synthesize(state) == "synthesize"

    def test_continue_when_rounds_remain(self):
        state = _make_state(current_round=0, max_rounds=3, critic_feedback="Some feedback")
        assert should_continue_or_synthesize(state) == "continue"

    def test_continue_when_no_feedback(self):
        state = _make_state(current_round=0, max_rounds=3, critic_feedback="")
        assert should_continue_or_synthesize(state) == "continue"

    def test_ignores_verdict_in_feedback(self):
        """VERDICT is no longer checked — pure round counting."""
        state = _make_state(current_round=0, max_rounds=3, critic_feedback="VERDICT: SYNTHESIZE")
        assert should_continue_or_synthesize(state) == "continue"

    def test_multi_round_continues_each_round(self):
        """Verify all rounds before max_rounds-1 return continue."""
        for r in range(5):
            state = _make_state(current_round=r, max_rounds=6)
            assert should_continue_or_synthesize(state) == "continue"

    def test_multi_round_synthesizes_at_last(self):
        """Verify synthesis triggers exactly at max_rounds-1."""
        state = _make_state(current_round=5, max_rounds=6)
        assert should_continue_or_synthesize(state) == "synthesize"

    def test_single_round_synthesizes_immediately(self):
        state = _make_state(current_round=0, max_rounds=1)
        assert should_continue_or_synthesize(state) == "synthesize"
