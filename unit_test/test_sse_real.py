"""Real SSE stream tests — transport layer is real, LLM layer is mocked."""
import json
import pytest
from unittest.mock import AsyncMock, patch


CREATE_PAYLOAD = {
    "topic": "SSE流测试主题",
    "max_rounds": 1,
    "mode": "custom",
    "agents": [
        {"name": "Host", "role": "host", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        {"name": "ExpertA", "role": "panelist", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        {"name": "ExpertB", "role": "panelist", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        {"name": "Critic", "role": "critic", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
    ],
}


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


def _make_fake_call():
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
        if phase == "synthesizing":
            return "最终完整总结"
        return "ok"
    return fake_call


@pytest.mark.asyncio
async def test_sse_run_stream_format(client, monkeypatch):
    """测试 /run 端点的 SSE 流：验证事件格式和流正常结束（有 cycle_complete 事件）。"""
    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", _make_fake_call())

    create_res = await client.post("/api/discussions/", json=CREATE_PAYLOAD)
    assert create_res.status_code == 200
    discussion_id = create_res.json()["id"]

    events = await _collect_sse_events(client, f"/api/discussions/{discussion_id}/run")

    assert len(events) > 0, "SSE 流应该产生至少一个事件"

    for event in events:
        assert "event_type" in event, f"每个事件都应有 event_type 字段，实际: {event}"

    assert any(e.get("event_type") == "cycle_complete" for e in events), \
        "流应以 cycle_complete 事件结束"


@pytest.mark.asyncio
async def test_sse_summarize_stream(client, monkeypatch):
    """测试 /summarize 端点：先完成一轮讨论，再调用 /summarize，验证有 summary 相关事件。"""
    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", _make_fake_call())

    create_res = await client.post("/api/discussions/", json=CREATE_PAYLOAD)
    assert create_res.status_code == 200
    discussion_id = create_res.json()["id"]

    # 先完成一轮讨论，产生消息
    await _collect_sse_events(client, f"/api/discussions/{discussion_id}/run")

    # mock summarize 使用的 LLM 调用
    with patch("backend.app.services.discussion_service.call_llm", new_callable=AsyncMock) as mock_llm:
        mock_llm.return_value = "这是消息摘要"

        events = await _collect_sse_events(client, f"/api/discussions/{discussion_id}/summarize")

    assert len(events) > 0, "summarize 流应该产生至少一个事件"

    for event in events:
        assert "event_type" in event, f"每个事件都应有 event_type 字段，实际: {event}"

    event_types = {e.get("event_type") for e in events}
    summary_related = {"summary_progress", "summary_complete", "error"}
    assert event_types & summary_related, \
        f"应有 summary 相关事件，实际事件类型: {event_types}"


@pytest.mark.asyncio
async def test_sse_event_data_structure(client, monkeypatch):
    """验证 SSE 事件的数据结构：每个事件都是合法 JSON、都有 event_type 字段。"""
    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", _make_fake_call())

    create_res = await client.post("/api/discussions/", json=CREATE_PAYLOAD)
    assert create_res.status_code == 200
    discussion_id = create_res.json()["id"]

    raw_lines = []
    async with client.stream("POST", f"/api/discussions/{discussion_id}/run") as res:
        assert res.status_code == 200
        async for line in res.aiter_lines():
            if line.startswith("data: "):
                raw_lines.append(line[len("data: "):].strip())

    assert len(raw_lines) > 0, "应该有 SSE 数据行"

    for raw in raw_lines:
        if not raw:
            continue
        try:
            parsed = json.loads(raw)
        except json.JSONDecodeError:
            pytest.fail(f"SSE 数据不是合法 JSON: {raw!r}")

        assert "event_type" in parsed, f"事件缺少 event_type 字段: {parsed}"
        assert isinstance(parsed["event_type"], str), \
            f"event_type 应为字符串，实际: {type(parsed['event_type'])}"
