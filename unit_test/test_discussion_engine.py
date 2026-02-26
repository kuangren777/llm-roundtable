"""Tests for discussion engine helper functions and graph structure."""
import asyncio
import json
import os
import sys
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.app.services.discussion_engine import (
    _pending_user_messages,
    _call_with_progress,
    _get_agent_by_role,
    _get_agents_by_role,
    _format_history,
    _parse_host_routing,
    build_discussion_graph,
    panelist_discussion_node,
    host_next_step_planning_node,
    progress_queue_var,
    route_after_host_planning,
    route_after_panelist_discussion,
    route_after_round_summary,
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
        "next_step_plan": "",
        "round_summaries": [],
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
    def test_always_routes_to_panelists(self):
        state = _make_state(execution_mode="host_only", needs_synthesis=True)
        assert route_after_host_planning(state) == "panelists"
        state = _make_state(execution_mode="panelists", needs_synthesis=False)
        assert route_after_host_planning(state) == "panelists"


class TestRoundRoutes:
    def test_incremental_mode_goes_to_critic(self):
        state = _make_state(single_round_mode=True)
        assert route_after_panelist_discussion(state) == "critic"

    def test_multi_round_goes_to_critic(self):
        state = _make_state(single_round_mode=False)
        assert route_after_panelist_discussion(state) == "critic"

    def test_incremental_mode_stops_after_round_summary(self):
        state = _make_state(single_round_mode=True)
        assert route_after_round_summary(state) == "stop"

    def test_multi_round_also_stops_after_round_summary(self):
        state = _make_state(single_round_mode=False)
        assert route_after_round_summary(state) == "stop"


@pytest.mark.asyncio
async def test_call_with_progress_can_disable_streaming(monkeypatch):
    captured = {"call_llm": 0, "call_llm_stream": 0}

    async def fake_call_llm(**kwargs):
        captured["call_llm"] += 1
        return "non-stream-result"

    async def fake_call_llm_stream(**kwargs):
        captured["call_llm_stream"] += 1
        return ("stream-result", 12)

    monkeypatch.setattr("backend.app.services.discussion_engine.call_llm", fake_call_llm)
    monkeypatch.setattr("backend.app.services.discussion_engine.call_llm_stream", fake_call_llm_stream)

    queue = asyncio.Queue()
    token = progress_queue_var.set(queue)
    try:
        result = await _call_with_progress(
            _make_agent("Host", "host"),
            messages=[{"role": "user", "content": "test"}],
            phase="round_summary",
            use_stream=False,
        )
    finally:
        progress_queue_var.reset(token)

    assert result == "non-stream-result"
    assert captured["call_llm"] == 1
    assert captured["call_llm_stream"] == 0

    events = []
    while not queue.empty():
        events.append(await queue.get())
    assert events[0][0] == "progress_event"
    assert events[0][1]["status"] == "waiting"
    assert events[-1][0] == "progress_event"
    assert events[-1][1]["status"] == "done"


@pytest.mark.asyncio
async def test_graph_stops_after_round_summary(monkeypatch):
    async def fake_call(agent, messages, phase="", stream_content=False, **kwargs):
        if phase == "planning":
            return json.dumps({
                "intent_judgment": "测试意图",
                "host_position": "测试观点",
                "discussion_plan": "测试主线",
                "execution_mode": "panelists",
                "selected_panelists": ["A", "B"],
                "assignments": [{"panelist": "A", "task": "A任务"}, {"panelist": "B", "task": "B任务"}],
                "open_tasks": ["校验关键假设"],
                "needs_synthesis": False,
            })
        if phase == "discussing":
            return f"{agent['name']} 观点"
        if phase == "reflecting":
            return "批评家反馈"
        if phase == "round_summary":
            return "本轮总结"
        if phase == "next_step_planning":
            return "下一步规划"
        if phase == "synthesizing":
            return "最终完整总结"
        return "ok"

    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", fake_call)
    _pending_user_messages.clear()

    state = _make_state(
        agents=[
            _make_agent("Host", "host"),
            _make_agent("A", "panelist"),
            _make_agent("B", "panelist"),
            _make_agent("Critic", "critic"),
        ],
        max_rounds=2,
        single_round_mode=False,
        discussion_id=10,
    )

    graph = build_discussion_graph()
    executed_nodes = []
    async for update in graph.astream(state, stream_mode="updates"):
        executed_nodes.extend(update.keys())

    assert executed_nodes == [
        "host_planning",
        "panelist_discussion",
        "critic_review",
        "host_round_summary",
    ]
    assert executed_nodes.count("host_round_summary") == 1
    assert executed_nodes.count("critic_review") == 1


@pytest.mark.asyncio
async def test_incremental_graph_is_single_round_with_critic(monkeypatch):
    async def fake_call(agent, messages, phase="", stream_content=False, **kwargs):
        if phase == "planning":
            return json.dumps({
                "discussion_plan": "增量问题处理",
                "execution_mode": "panelists",
                "selected_panelists": ["A"],
                "assignments": [{"panelist": "A", "task": "回答用户追问"}],
                "open_tasks": ["确认是否继续"],
                "needs_synthesis": False,
            })
        if phase == "discussing":
            return "A 的增量回答"
        if phase == "round_summary":
            return "增量轮次总结"
        return "ok"

    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", fake_call)
    _pending_user_messages.clear()

    state = _make_state(
        agents=[
            _make_agent("Host", "host"),
            _make_agent("A", "panelist"),
            _make_agent("Critic", "critic"),
        ],
        max_rounds=3,
        single_round_mode=True,
        discussion_id=11,
    )

    graph = build_discussion_graph()
    executed_nodes = []
    async for update in graph.astream(state, stream_mode="updates"):
        executed_nodes.extend(update.keys())

    assert executed_nodes == [
        "host_planning",
        "panelist_discussion",
        "critic_review",
        "host_round_summary",
    ]
    assert "host_next_step_planning" not in executed_nodes
    assert "synthesis" not in executed_nodes


@pytest.mark.asyncio
async def test_next_step_planning_consumes_previous_round_user_questions(monkeypatch):
    captured_prompt = {"text": ""}

    async def fake_call(agent, messages, phase="", stream_content=False, **kwargs):
        if phase == "next_step_planning":
            captured_prompt["text"] = messages[1]["content"]
            return "下一轮先处理用户插问"
        return "ok"

    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", fake_call)
    _pending_user_messages.clear()
    _pending_user_messages[99] = [{
        "agent_name": "用户",
        "content": "请补充风险边界定义",
        "round_number": 0,
        "cycle_index": 3,
    }]

    queue = asyncio.Queue()
    token = progress_queue_var.set(queue)
    try:
        state = _make_state(
            discussion_id=99,
            current_round=0,
            agents=[_make_agent("Host", "host"), _make_agent("A", "panelist"), _make_agent("Critic", "critic")],
            round_summaries=[{"round": 0, "summary": "本轮已经发现边界不清"}],
            critic_feedback="边界定义不足",
        )
        output = await host_next_step_planning_node(state)
    finally:
        progress_queue_var.reset(token)

    assert output["phase"] == "next_step_planning"
    assert output["next_step_plan"] == "下一轮先处理用户插问"
    assert any(m.get("phase") == "user_input" and m.get("content") == "请补充风险边界定义" for m in output["messages"])
    assert 99 not in _pending_user_messages
    assert "请补充风险边界定义" in captured_prompt["text"]
    evt_type, evt_payload = await queue.get()
    assert evt_type == "user_message_consumed"
    assert evt_payload["content"] == "请补充风险边界定义"


@pytest.mark.asyncio
async def test_panelists_emit_messages_as_they_finish(monkeypatch):
    async def fake_call(agent, messages, phase="", stream_content=False, **kwargs):
        if agent["name"] == "A":
            await asyncio.sleep(0.03)
        if agent["name"] == "B":
            await asyncio.sleep(0.01)
        return f"{agent['name']} 完成"

    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", fake_call)
    queue = asyncio.Queue()
    token = progress_queue_var.set(queue)
    try:
        state = _make_state(
            agents=[
                _make_agent("Host", "host"),
                _make_agent("A", "panelist"),
                _make_agent("B", "panelist"),
            ],
            selected_panelists=["A", "B"],
            panelist_tasks={"A": "A任务", "B": "B任务"},
        )
        output = await panelist_discussion_node(state)
    finally:
        progress_queue_var.reset(token)

    events = []
    while not queue.empty():
        events.append(await queue.get())

    node_events = [e for e in events if e[0] == "node_message"]
    assert len(node_events) == 2
    assert node_events[0][1]["agent_name"] == "B"
    assert node_events[1][1]["agent_name"] == "A"
    assert all(node_events[i][1].get("message_uid") for i in range(2))
    assert len(output["messages"]) == 2
