"""Tests for discussion engine helper functions and graph structure."""
import sys
import os
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.app.services.discussion_engine import (
    _get_agent_by_role,
    _get_agents_by_role,
    _format_history,
    _parse_host_routing,
    route_after_host_planning,
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
        "materials": "",
        "phase": "planning",
        "error": None,
        "discussion_id": 0,
        "single_round_mode": False,
        "selected_panelists": [],
        "panelist_tasks": {},
        "routing_constraints": {},
        "needs_synthesis": False,
        "execution_mode": "panelists",
        "intent_judgment": "",
        "host_position": "",
        "open_tasks": [],
        "cycle_index": 0,
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

    def test_single_round_followup_stops_without_synthesis(self):
        state = _make_state(single_round_mode=True, needs_synthesis=False)
        assert should_continue_or_synthesize(state) == "stop"

    def test_single_round_followup_can_synthesize(self):
        state = _make_state(single_round_mode=True, needs_synthesis=True)
        assert should_continue_or_synthesize(state) == "synthesize"


class TestHostRoutingParsing:
    def test_parses_selected_panelists_and_tasks(self):
        panelists = [_make_agent("A", "panelist"), _make_agent("B", "panelist")]
        raw = """
        {
          "intent_judgment": "用户要先聚焦风险",
          "host_position": "我建议先给出最小证据集",
          "discussion_plan": "先聚焦风险分析",
          "execution_mode": "panelists",
          "selected_panelists": ["B"],
          "assignments": [{"panelist": "B", "task": "从反方角度指出主要风险"}],
          "open_tasks": ["补齐实验复现细节"],
          "needs_synthesis": true
        }
        """
        plan, selected, tasks, needs_synthesis, execution_mode, intent_judgment, host_position, reasoning_text, open_tasks = _parse_host_routing(
            raw_plan=raw,
            panelists=panelists,
            constraints={},
            single_round_mode=True,
        )
        assert plan == "先聚焦风险分析"
        assert selected == ["B"]
        assert tasks["B"] == "从反方角度指出主要风险"
        assert needs_synthesis is True
        assert execution_mode == "panelists"
        assert intent_judgment == "用户要先聚焦风险"
        assert host_position == "我建议先给出最小证据集"
        assert reasoning_text == ""
        assert open_tasks == ["补齐实验复现细节"]

    def test_falls_back_to_all_panelists_when_json_invalid(self):
        panelists = [_make_agent("A", "panelist"), _make_agent("B", "panelist")]
        plan, selected, tasks, needs_synthesis, execution_mode, intent_judgment, host_position, reasoning_text, open_tasks = _parse_host_routing(
            raw_plan="not-json",
            panelists=panelists,
            constraints={},
            single_round_mode=True,
        )
        assert plan == "not-json"
        assert selected == ["A", "B"]
        assert set(tasks.keys()) == {"A", "B"}
        assert needs_synthesis is False
        assert execution_mode == "panelists"
        assert intent_judgment
        assert host_position
        assert reasoning_text == ""
        assert len(open_tasks) == 1

    def test_host_only_mode_skips_panelist_selection(self):
        panelists = [_make_agent("A", "panelist"), _make_agent("B", "panelist")]
        raw = """
        {
          "discussion_plan": "直接固化终稿框架",
          "execution_mode": "host_only",
          "selected_panelists": ["A", "B"],
          "assignments": [{"panelist": "A", "task": "不应被使用"}],
          "open_tasks": ["补齐伦理披露清单"],
          "needs_synthesis": false
        }
        """
        plan, selected, tasks, needs_synthesis, execution_mode, _, _, _, open_tasks = _parse_host_routing(
            raw_plan=raw,
            panelists=panelists,
            constraints={},
            single_round_mode=True,
        )
        assert plan == "直接固化终稿框架"
        assert execution_mode == "host_only"
        assert selected == []
        assert tasks == {}
        assert needs_synthesis is False
        assert open_tasks == ["补齐伦理披露清单"]


class TestHostPlanningRoute:
    def test_host_only_without_synthesis_stops(self):
        state = _make_state(execution_mode="host_only", needs_synthesis=False)
        assert route_after_host_planning(state) == "stop"

    def test_host_only_with_synthesis_routes_to_synthesis(self):
        state = _make_state(execution_mode="host_only", needs_synthesis=True)
        assert route_after_host_planning(state) == "synthesize"

    def test_panelists_mode_routes_to_panelists(self):
        state = _make_state(execution_mode="panelists", needs_synthesis=True)
        assert route_after_host_planning(state) == "panelists"
