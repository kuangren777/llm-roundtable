"""Error scenario tests — covering 404, invalid payload, LLM timeout, etc."""
import json
import pytest
from unittest.mock import AsyncMock, patch


CREATE_PAYLOAD = {
    "topic": "异常场景测试主题",
    "max_rounds": 1,
    "mode": "custom",
    "agents": [
        {"name": "Host", "role": "host", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        {"name": "ExpertA", "role": "panelist", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        {"name": "Critic", "role": "critic", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
    ],
}


@pytest.mark.asyncio
async def test_invalid_discussion_id_returns_404(client):
    """请求不存在的 discussion_id 的各端点返回 404。"""
    nonexistent_id = 99999

    res_get = await client.get(f"/api/discussions/{nonexistent_id}")
    assert res_get.status_code == 404

    res_delete = await client.delete(f"/api/discussions/{nonexistent_id}")
    assert res_delete.status_code == 404

    res_complete = await client.post(f"/api/discussions/{nonexistent_id}/complete")
    assert res_complete.status_code == 404


@pytest.mark.asyncio
async def test_llm_timeout_error_handling(client, monkeypatch):
    """mock LLM 抛出 TimeoutError，验证系统降级并回到 waiting_input。"""
    async def fake_call_timeout(agent, messages, phase="", stream_content=False, **kwargs):
        raise TimeoutError("LLM request timed out")

    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", fake_call_timeout)

    create_res = await client.post("/api/discussions/", json=CREATE_PAYLOAD)
    assert create_res.status_code == 200
    discussion_id = create_res.json()["id"]

    events = []
    async with client.stream("POST", f"/api/discussions/{discussion_id}/run") as res:
        assert res.status_code == 200
        async for line in res.aiter_lines():
            if not line.startswith("data: "):
                continue
            payload = line[len("data: "):].strip()
            if payload:
                events.append(json.loads(payload))

    assert any(
        e.get("event_type") == "message" and "[Error: LLM request timed out]" in e.get("content", "")
        for e in events
    )
    assert any(e.get("event_type") == "cycle_complete" for e in events)

    detail_res = await client.get(f"/api/discussions/{discussion_id}")
    assert detail_res.status_code == 200
    assert detail_res.json()["status"] == "waiting_input"


@pytest.mark.asyncio
async def test_create_discussion_invalid_payload(client):
    """发送无效 payload（缺少必填字段）返回 422。"""
    # 缺少 topic 字段
    res = await client.post("/api/discussions/", json={"max_rounds": 1})
    assert res.status_code == 422

    # 完全空 payload
    res2 = await client.post("/api/discussions/", json={})
    assert res2.status_code == 422


@pytest.mark.asyncio
async def test_run_already_completed_discussion(client, monkeypatch):
    """已完成的讨论再次 /run 应返回适当响应（继续运行或错误事件）。"""
    async def fake_call(agent, messages, phase="", stream_content=False, **kwargs):
        if phase == "planning":
            return json.dumps({
                "intent_judgment": "处理当前用户目标",
                "host_position": "先收敛关键结论",
                "discussion_plan": "按优先级推进本轮",
                "execution_mode": "panelists",
                "selected_panelists": ["ExpertA"],
                "assignments": [{"panelist": "ExpertA", "task": "给出支持性证据"}],
                "open_tasks": [],
                "needs_synthesis": False,
            })
        if phase == "discussing":
            return f"{agent['name']} 回复"
        if phase == "reflecting":
            return "批评家反馈"
        if phase == "round_summary":
            return "本轮完整总结"
        return "ok"

    monkeypatch.setattr("backend.app.services.discussion_engine._call_with_progress", fake_call)

    create_res = await client.post("/api/discussions/", json=CREATE_PAYLOAD)
    assert create_res.status_code == 200
    discussion_id = create_res.json()["id"]

    # 手动标记为 completed
    complete_res = await client.post(f"/api/discussions/{discussion_id}/complete")
    assert complete_res.status_code == 200

    # 对已完成的讨论再次 /run，应该返回 200（SSE 流），不应崩溃
    events = []
    async with client.stream("POST", f"/api/discussions/{discussion_id}/run") as res:
        assert res.status_code == 200
        async for line in res.aiter_lines():
            if not line.startswith("data: "):
                continue
            payload = line[len("data: "):].strip()
            if payload:
                events.append(json.loads(payload))

    # 流应该正常结束（有事件产生，且每个事件都有 event_type）
    assert len(events) > 0, "已完成讨论的 /run 应产生至少一个事件"
    for event in events:
        assert "event_type" in event


@pytest.mark.asyncio
async def test_delete_nonexistent_discussion(client):
    """删除不存在的讨论返回 404。"""
    res = await client.delete("/api/discussions/99999")
    assert res.status_code == 404
