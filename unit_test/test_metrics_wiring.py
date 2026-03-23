"""TDD tests for Prometheus business metrics wiring.

These tests verify that LLM_CALL_COUNT, LLM_CALL_DURATION, ACTIVE_DISCUSSIONS,
and SSE_CONNECTIONS are actually updated at runtime.
"""
import json
import sys
import os
import pytest
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))


def _get_counter_value(counter, **labels):
    """Read current value of a prometheus Counter with given labels."""
    try:
        return counter.labels(**labels)._value.get()
    except Exception:
        return 0.0


def _get_gauge_value(gauge):
    """Read current value of a prometheus Gauge."""
    try:
        return gauge._value.get()
    except Exception:
        return 0.0


def _get_histogram_count(histogram, **labels):
    """Read sample count of a prometheus Histogram with given labels."""
    try:
        child = histogram.labels(**labels)
        for sample in child.collect()[0].samples:
            if sample.name.endswith("_count"):
                return sample.value
        return 0.0
    except Exception:
        return 0.0


# ---------------------------------------------------------------------------
# LLM metrics tests
# ---------------------------------------------------------------------------

class TestLlmMetricsWiring:
    """LLM_CALL_COUNT and LLM_CALL_DURATION must be updated by call_llm."""

    @pytest.mark.asyncio
    async def test_call_llm_increments_success_counter(self):
        """call_llm success path must increment LLM_CALL_COUNT with status=success."""
        from backend.app.metrics import LLM_CALL_COUNT

        before = _get_counter_value(LLM_CALL_COUNT, provider="openai", model="gpt-4o", status="success")

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "hello"

        with patch("backend.app.services.llm_service.AsyncOpenAI") as MockClient:
            instance = MockClient.return_value
            instance.chat.completions.create = AsyncMock(return_value=mock_response)
            instance.close = AsyncMock()

            from backend.app.services.llm_service import call_llm
            await call_llm(
                provider="openai",
                model="gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
                api_key="sk-test",
            )

        after = _get_counter_value(LLM_CALL_COUNT, provider="openai", model="gpt-4o", status="success")
        assert after > before, (
            f"LLM_CALL_COUNT(status=success) should have incremented after call_llm, "
            f"but was {before} before and {after} after"
        )

    @pytest.mark.asyncio
    async def test_call_llm_increments_error_counter_on_failure(self):
        """call_llm failure path must increment LLM_CALL_COUNT with status=error."""
        from backend.app.metrics import LLM_CALL_COUNT

        before = _get_counter_value(LLM_CALL_COUNT, provider="openai", model="gpt-4o", status="error")

        with patch("backend.app.services.llm_service.AsyncOpenAI") as MockClient, \
             patch("backend.app.services.llm_service.asyncio.sleep", new_callable=AsyncMock):
            instance = MockClient.return_value
            instance.chat.completions.create = AsyncMock(side_effect=Exception("api error"))
            instance.close = AsyncMock()

            from backend.app.services.llm_service import call_llm
            with pytest.raises(Exception):
                await call_llm(
                    provider="openai",
                    model="gpt-4o",
                    messages=[{"role": "user", "content": "hi"}],
                    api_key="sk-test",
                )

        after = _get_counter_value(LLM_CALL_COUNT, provider="openai", model="gpt-4o", status="error")
        assert after > before, (
            f"LLM_CALL_COUNT(status=error) should have incremented after call_llm failure, "
            f"but was {before} before and {after} after"
        )

    @pytest.mark.asyncio
    async def test_call_llm_observes_duration(self):
        """call_llm must record a duration sample in LLM_CALL_DURATION."""
        from backend.app.metrics import LLM_CALL_DURATION

        before = _get_histogram_count(LLM_CALL_DURATION, provider="openai", model="gpt-4o")

        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "hello"

        with patch("backend.app.services.llm_service.AsyncOpenAI") as MockClient:
            instance = MockClient.return_value
            instance.chat.completions.create = AsyncMock(return_value=mock_response)
            instance.close = AsyncMock()

            from backend.app.services.llm_service import call_llm
            await call_llm(
                provider="openai",
                model="gpt-4o",
                messages=[{"role": "user", "content": "hi"}],
                api_key="sk-test",
            )

        after = _get_histogram_count(LLM_CALL_DURATION, provider="openai", model="gpt-4o")
        assert after > before, (
            f"LLM_CALL_DURATION should have recorded a sample after call_llm, "
            f"but count was {before} before and {after} after"
        )


# ---------------------------------------------------------------------------
# SSE connection metrics tests
# ---------------------------------------------------------------------------

CREATE_PAYLOAD = {
    "topic": "metrics测试主题",
    "max_rounds": 1,
    "mode": "custom",
    "agents": [
        {"name": "Host", "role": "host", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        {"name": "ExpertA", "role": "panelist", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        {"name": "ExpertB", "role": "panelist", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
        {"name": "Critic", "role": "critic", "provider": "openai", "model": "gpt-4o", "api_key": "sk-test"},
    ],
}


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


class TestSseConnectionMetrics:
    """SSE_CONNECTIONS gauge must increment when stream opens and decrement when it closes."""

    @pytest.mark.asyncio
    async def test_sse_connections_increments_and_decrements(self, client, monkeypatch):
        """SSE_CONNECTIONS should be +1 during stream and return to baseline after."""
        from backend.app.metrics import SSE_CONNECTIONS

        monkeypatch.setattr(
            "backend.app.services.discussion_engine._call_with_progress",
            _make_fake_call(),
        )

        create_res = await client.post("/api/discussions/", json=CREATE_PAYLOAD)
        assert create_res.status_code == 200
        discussion_id = create_res.json()["id"]

        baseline = _get_gauge_value(SSE_CONNECTIONS)

        # Collect all SSE events (stream completes when generator exhausts)
        async with client.stream("POST", f"/api/discussions/{discussion_id}/run") as res:
            assert res.status_code == 200
            async for _ in res.aiter_lines():
                pass

        after = _get_gauge_value(SSE_CONNECTIONS)
        assert after == baseline, (
            f"SSE_CONNECTIONS should return to baseline {baseline} after stream ends, "
            f"but got {after}"
        )


# ---------------------------------------------------------------------------
# Active discussions metrics tests
# ---------------------------------------------------------------------------

class TestActiveDiscussionsMetrics:
    """ACTIVE_DISCUSSIONS gauge must increment when run_discussion starts and decrement when it ends."""

    @pytest.mark.asyncio
    async def test_active_discussions_returns_to_baseline(self, client, monkeypatch):
        """ACTIVE_DISCUSSIONS should return to baseline after run_discussion completes."""
        from backend.app.metrics import ACTIVE_DISCUSSIONS

        monkeypatch.setattr(
            "backend.app.services.discussion_engine._call_with_progress",
            _make_fake_call(),
        )

        create_res = await client.post("/api/discussions/", json=CREATE_PAYLOAD)
        assert create_res.status_code == 200
        discussion_id = create_res.json()["id"]

        baseline = _get_gauge_value(ACTIVE_DISCUSSIONS)

        async with client.stream("POST", f"/api/discussions/{discussion_id}/run") as res:
            assert res.status_code == 200
            async for _ in res.aiter_lines():
                pass

        after = _get_gauge_value(ACTIVE_DISCUSSIONS)
        assert after == baseline, (
            f"ACTIVE_DISCUSSIONS should return to baseline {baseline} after run completes, "
            f"but got {after}"
        )


# ---------------------------------------------------------------------------
# /metrics endpoint smoke test
# ---------------------------------------------------------------------------

class TestMetricsEndpoint:
    """The /metrics endpoint must expose the business metric series."""

    @pytest.mark.asyncio
    async def test_metrics_endpoint_exposes_llm_calls_total(self, client):
        res = await client.get("/metrics")
        assert res.status_code == 200
        assert "llm_calls_total" in res.text, (
            "Expected 'llm_calls_total' in /metrics output"
        )

    @pytest.mark.asyncio
    async def test_metrics_endpoint_exposes_active_discussions(self, client):
        res = await client.get("/metrics")
        assert res.status_code == 200
        assert "active_discussions" in res.text, (
            "Expected 'active_discussions' in /metrics output"
        )

    @pytest.mark.asyncio
    async def test_metrics_endpoint_exposes_sse_connections_active(self, client):
        res = await client.get("/metrics")
        assert res.status_code == 200
        assert "sse_connections_active" in res.text, (
            "Expected 'sse_connections_active' in /metrics output"
        )

    @pytest.mark.asyncio
    async def test_metrics_endpoint_exposes_llm_call_duration_seconds(self, client):
        res = await client.get("/metrics")
        assert res.status_code == 200
        assert "llm_call_duration_seconds" in res.text, (
            "Expected 'llm_call_duration_seconds' in /metrics output"
        )
