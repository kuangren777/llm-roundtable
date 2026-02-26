"""Regression tests for strict round flow and post-completion incremental flow."""
import json
import pytest
from sqlalchemy import select

from backend.app.models.models import Discussion, DiscussionStatus
from backend.app.schemas.schemas import DiscussionEvent
from unit_test.conftest import TestSession


async def _collect_sse_events(client, url: str) -> list[dict]:
    events = []
    async with client.stream("POST", url) as res:
        assert res.status_code == 200
        async for line in res.aiter_lines():
            if not line.startswith("data: "):
                continue
            payload = line[len("data: "):].strip()
            if payload:
                events.append(json.loads(payload))
    return events


@pytest.mark.asyncio
async def test_each_run_stops_after_round_summary(client, monkeypatch):
    async def fake_call(agent, messages, phase="", stream_content=False, **kwargs):
        if phase == "planning":
            return json.dumps({
                "intent_judgment": "处理当前用户目标",
                "host_position": "先收敛关键结论",
                "discussion_plan": "按优先级推进本轮",
                "execution_mode": "panelists",
                "selected_panelists": ["ExpertA", "ExpertB"],
                "assignments": [
                    {"panelist": "ExpertA", "task": "给出支持性证据"},
                    {"panelist": "ExpertB", "task": "给出反例与风险"},
                ],
                "open_tasks": ["确认剩余分歧"],
                "needs_synthesis": False,
            })
        if phase == "discussing":
            return f"{agent['name']} 回复"
        if phase == "reflecting":
            return "批评家反馈"
        if phase == "round_summary":
            return "本轮完整总结"
        if phase == "next_step_planning":
            return "下一轮优先处理未解问题"
        if phase == "synthesizing":
            return "最终完整总结"
        return "ok"

    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", fake_call)

    create_payload = {
        "topic": "测试严格轮次流程",
        "max_rounds": 2,
        "mode": "custom",
        "agents": [
            {"name": "Host", "role": "host", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
            {"name": "ExpertA", "role": "panelist", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
            {"name": "ExpertB", "role": "panelist", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
            {"name": "Critic", "role": "critic", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        ],
    }
    create_res = await client.post("/api/discussions/", json=create_payload)
    assert create_res.status_code == 200
    discussion_id = create_res.json()["id"]

    first_events = await _collect_sse_events(client, f"/api/discussions/{discussion_id}/run")
    first_phases = [
        e["phase"] for e in first_events
        if e.get("event_type") == "phase_change" and e.get("phase")
    ]
    assert first_phases == [
        "planning",
        "planning",
        "discussing",
        "reflecting",
        "round_summary",
    ]
    assert "next_step_planning" not in first_phases
    assert "synthesizing" not in first_phases
    assert any(e.get("event_type") == "cycle_complete" for e in first_events)

    detail_res = await client.get(f"/api/discussions/{discussion_id}")
    assert detail_res.status_code == 200
    assert detail_res.json()["status"] == "waiting_input"

    user_input_res = await client.post(
        f"/api/discussions/{discussion_id}/user-input",
        json={"content": "请补充刚才结论的边界条件"},
    )
    assert user_input_res.status_code == 200

    second_events = await _collect_sse_events(client, f"/api/discussions/{discussion_id}/run")
    second_phases = [
        e["phase"] for e in second_events
        if e.get("event_type") == "phase_change" and e.get("phase")
    ]
    assert second_phases == [
        "planning",
        "planning",
        "discussing",
        "reflecting",
        "round_summary",
    ]
    assert "next_step_planning" not in second_phases
    assert "synthesizing" not in second_phases
    assert any(e.get("event_type") == "cycle_complete" for e in second_events)

    detail_res_after = await client.get(f"/api/discussions/{discussion_id}")
    assert detail_res_after.status_code == 200
    assert detail_res_after.json()["status"] == "waiting_input"


@pytest.mark.asyncio
async def test_running_without_local_task_recovers_to_resumable_run(client, monkeypatch):
    from backend.app.services import discussion_service as svc

    class _FakeGraph:
        async def astream(self, initial_state, stream_mode="updates"):
            yield {
                "host_planning": {
                    "phase": "planning",
                    "messages": [],
                    "current_round": 0,
                }
            }

    monkeypatch.setattr(svc, "build_discussion_graph", lambda: _FakeGraph())

    create_payload = {
        "topic": "测试无本地任务时自动恢复",
        "max_rounds": 1,
        "mode": "custom",
        "agents": [
            {"name": "Host", "role": "host", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
            {"name": "ExpertA", "role": "panelist", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
            {"name": "Critic", "role": "critic", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        ],
    }
    create_res = await client.post("/api/discussions/", json=create_payload)
    assert create_res.status_code == 200
    discussion_id = create_res.json()["id"]

    # Force discussion status into a running phase while no in-memory task exists.
    async with TestSession() as db:
        result = await db.execute(select(Discussion).where(Discussion.id == discussion_id))
        discussion = result.scalar_one()
        discussion.status = DiscussionStatus.PLANNING
        await db.commit()

    svc._running_tasks.pop(discussion_id, None)
    svc._drain_tasks.pop(discussion_id, None)

    called = {"reattach_called": False}

    async def fake_stream(_db, _discussion_id, degraded_db_polling=False):
        called["reattach_called"] = True
        if False:
            yield DiscussionEvent(event_type="phase_change", phase="planning", content="reconnected")

    monkeypatch.setattr(svc, "_stream_running_discussion_events", fake_stream)

    events = await _collect_sse_events(client, f"/api/discussions/{discussion_id}/run")

    assert called["reattach_called"] is False
    assert any(e.get("event_type") == "phase_change" and e.get("phase") == "planning" for e in events)
    assert any(e.get("event_type") == "cycle_complete" for e in events)

    detail_res = await client.get(f"/api/discussions/{discussion_id}")
    assert detail_res.status_code == 200
    assert detail_res.json()["status"] == "waiting_input"


@pytest.mark.asyncio
async def test_waiting_input_without_history_still_stops_after_round_summary(client, monkeypatch):
    async def fake_call(agent, messages, phase="", stream_content=False, **kwargs):
        if phase == "planning":
            return json.dumps({
                "intent_judgment": "处理当前用户目标",
                "host_position": "先收敛关键结论",
                "discussion_plan": "按优先级推进本轮",
                "execution_mode": "panelists",
                "selected_panelists": ["ExpertA"],
                "assignments": [
                    {"panelist": "ExpertA", "task": "给出支持性证据"},
                ],
                "open_tasks": ["确认剩余分歧"],
                "needs_synthesis": False,
            })
        if phase == "discussing":
            return f"{agent['name']} 回复"
        if phase == "reflecting":
            return "批评家反馈"
        if phase == "round_summary":
            return "本轮完整总结"
        if phase == "next_step_planning":
            return "下一轮优先处理未解问题"
        if phase == "synthesizing":
            return "最终完整总结"
        return "ok"

    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", fake_call)

    create_payload = {
        "topic": "测试等待输入空历史的首轮保护",
        "max_rounds": 2,
        "mode": "custom",
        "agents": [
            {"name": "Host", "role": "host", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
            {"name": "ExpertA", "role": "panelist", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
            {"name": "Critic", "role": "critic", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        ],
    }
    create_res = await client.post("/api/discussions/", json=create_payload)
    assert create_res.status_code == 200
    discussion_id = create_res.json()["id"]

    # Simulate abnormal state: waiting_input but no non-user history yet.
    async with TestSession() as db:
        result = await db.execute(select(Discussion).where(Discussion.id == discussion_id))
        discussion = result.scalar_one()
        discussion.status = DiscussionStatus.WAITING_INPUT
        await db.commit()

    events = await _collect_sse_events(client, f"/api/discussions/{discussion_id}/run")
    phases = [
        e["phase"] for e in events
        if e.get("event_type") == "phase_change" and e.get("phase")
    ]

    assert phases == [
        "planning",
        "planning",
        "discussing",
        "reflecting",
        "round_summary",
    ]
    assert "next_step_planning" not in phases
    assert "synthesizing" not in phases
    assert any(e.get("event_type") == "cycle_complete" for e in events)
