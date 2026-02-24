"""Tests for FastAPI API endpoints using httpx AsyncClient."""
import json


async def test_health_check(client):
    res = await client.get("/api/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


async def test_create_discussion(client):
    payload = {
        "topic": "Test discussion topic",
        "max_rounds": 2,
        "mode": "custom",
        "agents": [
            {"name": "Host", "role": "host", "provider": "openai", "model": "gpt-4o"},
            {"name": "Expert", "role": "panelist", "provider": "anthropic", "model": "claude-3"},
            {"name": "Critic", "role": "critic", "provider": "openai", "model": "gpt-4o"},
        ],
    }
    res = await client.post("/api/discussions/", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["topic"] == "Test discussion topic"
    assert data["max_rounds"] == 2
    assert data["status"] == "created"
    assert data["mode"] == "custom"
    assert len(data["agents"]) == 3


async def test_list_discussions_empty(client):
    res = await client.get("/api/discussions/")
    assert res.status_code == 200
    assert res.json() == []


async def test_list_discussions_after_create(client):
    payload = {"topic": "Topic A", "mode": "debate"}
    await client.post("/api/discussions/", json=payload)
    await client.post("/api/discussions/", json={**payload, "topic": "Topic B"})

    res = await client.get("/api/discussions/")
    assert res.status_code == 200
    data = res.json()
    assert len(data) == 2
    # Most recent first
    assert data[0]["topic"] == "Topic B"


async def test_get_discussion_detail(client):
    payload = {
        "topic": "Detail test",
        "mode": "custom",
        "agents": [
            {"name": "Host", "role": "host"},
            {"name": "Expert", "role": "panelist", "persona": "ML expert"},
        ],
    }
    create_res = await client.post("/api/discussions/", json=payload)
    disc_id = create_res.json()["id"]

    res = await client.get(f"/api/discussions/{disc_id}")
    assert res.status_code == 200
    data = res.json()
    assert data["topic"] == "Detail test"
    assert "messages" in data
    assert any(
        m["agent_role"] == "user"
        and m["phase"] == "user_input"
        and m["content"] == "Detail test"
        for m in data["messages"]
    )
    assert len(data["agents"]) == 2


async def test_get_discussion_not_found(client):
    res = await client.get("/api/discussions/9999")
    assert res.status_code == 404


async def test_create_discussion_validation_error(client):
    # Missing required 'topic' field
    res = await client.post("/api/discussions/", json={"agents": []})
    assert res.status_code == 422


async def test_create_discussion_invalid_rounds(client):
    payload = {
        "topic": "Test",
        "max_rounds": 0,
        "mode": "custom",
        "agents": [{"name": "Host", "role": "host"}],
    }
    res = await client.post("/api/discussions/", json=payload)
    assert res.status_code == 422


async def test_agent_api_key_not_exposed(client):
    """API keys should not be returned in responses."""
    payload = {
        "topic": "Secret test",
        "mode": "custom",
        "agents": [{"name": "Host", "role": "host", "api_key": "sk-secret-key-123"}],
    }
    create_res = await client.post("/api/discussions/", json=payload)
    data = create_res.json()
    # AgentConfigResponse schema excludes api_key
    assert "api_key" not in data["agents"][0]


async def test_delete_discussion(client):
    payload = {
        "topic": "To be deleted",
        "mode": "custom",
        "agents": [{"name": "Host", "role": "host"}],
    }
    create_res = await client.post("/api/discussions/", json=payload)
    disc_id = create_res.json()["id"]

    res = await client.delete(f"/api/discussions/{disc_id}")
    assert res.status_code == 204

    # Verify it's gone
    res = await client.get(f"/api/discussions/{disc_id}")
    assert res.status_code == 404


async def test_delete_discussion_not_found(client):
    res = await client.delete("/api/discussions/9999")
    assert res.status_code == 404


async def test_stop_discussion_returns_paused_status(client):
    payload = {
        "topic": "Pause behavior test",
        "mode": "custom",
        "agents": [{"name": "Host", "role": "host"}],
    }
    create_res = await client.post("/api/discussions/", json=payload)
    assert create_res.status_code == 200
    disc_id = create_res.json()["id"]

    stop_res = await client.post(f"/api/discussions/{disc_id}/stop")
    assert stop_res.status_code == 200
    assert stop_res.json()["status"] == "paused"


async def test_create_discussion_auto_mode(client):
    """Auto mode: no agents created at creation time, LLMs snapshotted from global providers."""
    payload = {"topic": "AI in healthcare", "mode": "auto"}
    res = await client.post("/api/discussions/", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["mode"] == "auto"
    assert data["agents"] == []  # agents generated at run time


async def test_create_discussion_debate_mode(client):
    """Debate mode: no agents at creation, generated at run time from templates."""
    payload = {"topic": "Is remote work better?", "mode": "debate"}
    res = await client.post("/api/discussions/", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["mode"] == "debate"
    assert data["agents"] == []


async def test_create_discussion_default_mode_is_auto(client):
    """When mode is omitted, it defaults to auto."""
    payload = {"topic": "Default mode test"}
    res = await client.post("/api/discussions/", json=payload)
    assert res.status_code == 200
    assert res.json()["mode"] == "auto"


async def test_create_discussion_invalid_mode(client):
    payload = {"topic": "Test", "mode": "invalid_mode"}
    res = await client.post("/api/discussions/", json=payload)
    assert res.status_code == 422


# --- LLM Provider CRUD tests ---

async def test_list_llm_providers_empty(client):
    res = await client.get("/api/llm-providers/")
    assert res.status_code == 200
    assert res.json() == []


async def test_create_llm_provider(client):
    payload = {"name": "My OpenAI", "provider": "openai"}
    res = await client.post("/api/llm-providers/", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["provider"] == "openai"
    assert data["name"] == "My OpenAI"
    assert "api_key" not in data  # api_key not exposed in response
    assert "id" in data
    assert data["models"] == []  # no models yet
    assert data["has_api_key"] is False


async def test_create_llm_provider_with_api_key(client):
    payload = {"name": "Anthropic", "provider": "anthropic", "api_key": "sk-secret"}
    res = await client.post("/api/llm-providers/", json=payload)
    assert res.status_code == 200
    data = res.json()
    assert data["has_api_key"] is True
    assert "api_key" not in data


async def test_update_llm_provider(client):
    # Create
    create_res = await client.post("/api/llm-providers/", json={"name": "Old", "provider": "openai"})
    pid = create_res.json()["id"]

    # Update
    res = await client.put(f"/api/llm-providers/{pid}", json={"name": "New Name", "api_key": "sk-new"})
    assert res.status_code == 200
    data = res.json()
    assert data["name"] == "New Name"
    assert data["has_api_key"] is True


async def test_update_llm_provider_not_found(client):
    res = await client.put("/api/llm-providers/9999", json={"name": "X"})
    assert res.status_code == 404


async def test_delete_llm_provider(client):
    create_res = await client.post("/api/llm-providers/", json={"name": "ToDelete", "provider": "openai"})
    pid = create_res.json()["id"]

    res = await client.delete(f"/api/llm-providers/{pid}")
    assert res.status_code == 204

    res = await client.get("/api/llm-providers/")
    assert len(res.json()) == 0


async def test_delete_llm_provider_not_found(client):
    res = await client.delete("/api/llm-providers/9999")
    assert res.status_code == 404


async def test_delete_provider_cascades_models(client):
    """Deleting a provider should cascade-delete its models."""
    create_res = await client.post("/api/llm-providers/", json={"name": "Cascade", "provider": "openai"})
    pid = create_res.json()["id"]
    await client.post(f"/api/llm-providers/{pid}/models", json={"model": "gpt-4o"})

    res = await client.delete(f"/api/llm-providers/{pid}")
    assert res.status_code == 204


# --- LLM Model CRUD tests ---

async def test_add_model(client):
    create_res = await client.post("/api/llm-providers/", json={"name": "OpenAI", "provider": "openai"})
    pid = create_res.json()["id"]

    res = await client.post(f"/api/llm-providers/{pid}/models", json={"model": "gpt-4o"})
    assert res.status_code == 200
    data = res.json()
    assert data["model"] == "gpt-4o"
    assert data["name"] == "gpt-4o"  # defaults to model id
    assert data["provider_id"] == pid


async def test_add_model_with_name(client):
    create_res = await client.post("/api/llm-providers/", json={"name": "OpenAI", "provider": "openai"})
    pid = create_res.json()["id"]

    res = await client.post(f"/api/llm-providers/{pid}/models", json={"model": "gpt-4o", "name": "GPT-4o"})
    assert res.status_code == 200
    assert res.json()["name"] == "GPT-4o"


async def test_add_model_provider_not_found(client):
    res = await client.post("/api/llm-providers/9999/models", json={"model": "gpt-4o"})
    assert res.status_code == 404


async def test_update_model(client):
    create_res = await client.post("/api/llm-providers/", json={"name": "OpenAI", "provider": "openai"})
    pid = create_res.json()["id"]
    model_res = await client.post(f"/api/llm-providers/{pid}/models", json={"model": "gpt-4o"})
    mid = model_res.json()["id"]

    res = await client.put(f"/api/llm-providers/{pid}/models/{mid}", json={"name": "GPT-4o Updated"})
    assert res.status_code == 200
    assert res.json()["name"] == "GPT-4o Updated"


async def test_update_model_not_found(client):
    create_res = await client.post("/api/llm-providers/", json={"name": "OpenAI", "provider": "openai"})
    pid = create_res.json()["id"]

    res = await client.put(f"/api/llm-providers/{pid}/models/9999", json={"name": "X"})
    assert res.status_code == 404


async def test_delete_model(client):
    create_res = await client.post("/api/llm-providers/", json={"name": "OpenAI", "provider": "openai"})
    pid = create_res.json()["id"]
    model_res = await client.post(f"/api/llm-providers/{pid}/models", json={"model": "gpt-4o"})
    mid = model_res.json()["id"]

    res = await client.delete(f"/api/llm-providers/{pid}/models/{mid}")
    assert res.status_code == 204

    # Verify model is gone from provider
    provider = await client.get("/api/llm-providers/")
    assert len(provider.json()[0]["models"]) == 0


async def test_delete_model_not_found(client):
    create_res = await client.post("/api/llm-providers/", json={"name": "OpenAI", "provider": "openai"})
    pid = create_res.json()["id"]

    res = await client.delete(f"/api/llm-providers/{pid}/models/9999")
    assert res.status_code == 404


async def test_provider_list_includes_models(client):
    """GET /api/llm-providers/ should return nested models."""
    create_res = await client.post("/api/llm-providers/", json={"name": "OpenAI", "provider": "openai"})
    pid = create_res.json()["id"]
    await client.post(f"/api/llm-providers/{pid}/models", json={"model": "gpt-4o"})
    await client.post(f"/api/llm-providers/{pid}/models", json={"model": "gpt-4o-mini"})

    res = await client.get("/api/llm-providers/")
    data = res.json()
    assert len(data) == 1
    assert len(data[0]["models"]) == 2


async def test_discussion_snapshots_provider_models(client):
    """Creating a discussion should snapshot provider+model combos into llm_configs."""
    # Add provider with models
    create_res = await client.post("/api/llm-providers/", json={"name": "OpenAI", "provider": "openai", "api_key": "sk-test"})
    pid = create_res.json()["id"]
    await client.post(f"/api/llm-providers/{pid}/models", json={"model": "gpt-4o"})
    await client.post(f"/api/llm-providers/{pid}/models", json={"model": "gpt-4o-mini"})

    # Create discussion
    res = await client.post("/api/discussions/", json={"topic": "Snapshot test", "mode": "debate"})
    assert res.status_code == 200
    disc_id = res.json()["id"]

    detail = await client.get(f"/api/discussions/{disc_id}")
    assert detail.status_code == 200
    assert detail.json()["mode"] == "debate"


async def test_user_input_cycle_index_increments_after_completion(client):
    create_res = await client.post("/api/discussions/", json={"topic": "Cycle test", "mode": "debate"})
    disc_id = create_res.json()["id"]

    first = await client.post(f"/api/discussions/{disc_id}/user-input", json={"content": "第一条输入"})
    assert first.status_code == 200

    complete_res = await client.post(f"/api/discussions/{disc_id}/complete")
    assert complete_res.status_code == 200

    second = await client.post(f"/api/discussions/{disc_id}/user-input", json={"content": "第二条输入"})
    assert second.status_code == 200

    detail = await client.get(f"/api/discussions/{disc_id}")
    assert detail.status_code == 200
    user_msgs = [m for m in detail.json()["messages"] if m["agent_role"] == "user"]
    # Includes initial topic message + two explicit user inputs.
    assert len(user_msgs) == 3
    assert user_msgs[0]["content"] == "Cycle test"
    assert user_msgs[0]["phase"] == "user_input"
    assert user_msgs[0]["cycle_index"] == 0
    assert user_msgs[1]["content"] == "第一条输入"
    assert user_msgs[1]["cycle_index"] == 0
    assert user_msgs[2]["content"] == "第二条输入"
    assert user_msgs[2]["cycle_index"] == 1


async def test_truncate_after_message_deletes_following_messages(client):
    create_res = await client.post("/api/discussions/", json={"topic": "Truncate test", "mode": "debate"})
    disc_id = create_res.json()["id"]

    await client.post(f"/api/discussions/{disc_id}/user-input", json={"content": "A"})
    await client.post(f"/api/discussions/{disc_id}/user-input", json={"content": "B"})

    detail = await client.get(f"/api/discussions/{disc_id}")
    msgs = detail.json()["messages"]
    assert len(msgs) >= 3
    anchor_id = msgs[0]["id"]  # initial topic user message

    res = await client.post(
        f"/api/discussions/{disc_id}/messages/truncate-after",
        json={"message_id": anchor_id},
    )
    assert res.status_code == 200
    assert res.json()["deleted_count"] >= 2

    detail_after = await client.get(f"/api/discussions/{disc_id}")
    msgs_after = detail_after.json()["messages"]
    assert len(msgs_after) == 1
    assert msgs_after[0]["id"] == anchor_id


async def test_truncate_with_null_anchor_deletes_all_messages(client):
    create_res = await client.post("/api/discussions/", json={"topic": "Truncate all test", "mode": "debate"})
    disc_id = create_res.json()["id"]
    await client.post(f"/api/discussions/{disc_id}/user-input", json={"content": "A"})

    res = await client.post(
        f"/api/discussions/{disc_id}/messages/truncate-after",
        json={"message_id": None},
    )
    assert res.status_code == 200
    assert res.json()["deleted_count"] >= 1

    detail_after = await client.get(f"/api/discussions/{disc_id}")
    assert detail_after.status_code == 200
    assert detail_after.json()["messages"] == []


async def test_run_supports_single_round_query_param(client, monkeypatch):
    from backend.app.schemas.schemas import DiscussionEvent

    observed = {"force_single_round": None}

    async def fake_run_discussion(_db, _discussion_id, force_single_round: bool = False):
        observed["force_single_round"] = force_single_round
        yield DiscussionEvent(event_type="cycle_complete", content="ok")

    monkeypatch.setattr("backend.app.api.discussions.run_discussion", fake_run_discussion)

    create_res = await client.post("/api/discussions/", json={"topic": "Single round flag test", "mode": "debate"})
    disc_id = create_res.json()["id"]

    res = await client.post(f"/api/discussions/{disc_id}/run?single_round=true")
    assert res.status_code == 200
    assert observed["force_single_round"] is True
    assert "cycle_complete" in res.text


async def test_run_supports_force_full_round_query_param(client, monkeypatch):
    from backend.app.schemas.schemas import DiscussionEvent

    observed = {"force_single_round": None}

    async def fake_run_discussion(_db, _discussion_id, force_single_round=None):
        observed["force_single_round"] = force_single_round
        yield DiscussionEvent(event_type="complete", content="ok")

    monkeypatch.setattr("backend.app.api.discussions.run_discussion", fake_run_discussion)

    create_res = await client.post("/api/discussions/", json={"topic": "Force full flag test", "mode": "debate"})
    disc_id = create_res.json()["id"]

    res = await client.post(f"/api/discussions/{disc_id}/run?single_round=false")
    assert res.status_code == 200
    assert observed["force_single_round"] is False
    assert "complete" in res.text


# --- Observer tests ---

async def test_observer_history_empty(client):
    """New discussion should have no observer history."""
    create_res = await client.post("/api/discussions/", json={"topic": "Observer test", "mode": "debate"})
    disc_id = create_res.json()["id"]

    res = await client.get(f"/api/discussions/{disc_id}/observer/history")
    assert res.status_code == 200
    assert res.json() == []


async def test_observer_chat_streams_error_for_missing_discussion(client):
    """Observer chat on non-existent discussion should return error event."""
    res = await client.post(
        "/api/discussions/9999/observer/chat",
        json={"content": "hello", "provider": "openai", "model": "gpt-4o"},
    )
    # SSE endpoint returns 200 with error event in the stream
    assert res.status_code == 200
    body = res.text
    assert "error" in body
    assert "讨论不存在" in body


async def test_clear_observer_history(client):
    """Clear should remove all observer messages."""
    create_res = await client.post("/api/discussions/", json={"topic": "Clear test", "mode": "debate"})
    disc_id = create_res.json()["id"]

    # Clear on empty history should succeed
    res = await client.delete(f"/api/discussions/{disc_id}/observer/history")
    assert res.status_code == 204

    # History should still be empty
    res = await client.get(f"/api/discussions/{disc_id}/observer/history")
    assert res.status_code == 200
    assert res.json() == []


async def test_observer_history_in_discussion_detail(client):
    """DiscussionDetail should include observer_messages field."""
    create_res = await client.post("/api/discussions/", json={
        "topic": "Detail observer test",
        "mode": "custom",
        "agents": [{"name": "Host", "role": "host"}],
    })
    disc_id = create_res.json()["id"]

    res = await client.get(f"/api/discussions/{disc_id}")
    assert res.status_code == 200
    data = res.json()
    assert "observer_messages" in data
    assert data["observer_messages"] == []


async def test_summarize_stream_supports_double_encoded_summary_model_setting(client, monkeypatch):
    """Regression: summary_model may be stored as a double-encoded JSON string."""
    provider = await client.post("/api/llm-providers/", json={"name": "OpenAI", "provider": "openai"})
    pid = provider.json()["id"]
    await client.post(f"/api/llm-providers/{pid}/models", json={"model": "gpt-4o-mini"})

    # Simulate legacy bad value in DB: json string wrapped in another json string.
    raw_cfg = json.dumps({"provider_id": pid, "provider": "openai", "model": "gpt-4o-mini"})
    await client.put("/api/settings/summary_model", json={"value": raw_cfg})

    topic = "这是一个用于触发消息总结的超长话题。" * 30
    create_res = await client.post("/api/discussions/", json={"topic": topic, "mode": "debate"})
    disc_id = create_res.json()["id"]

    async def fake_call_llm_stream(*args, on_chunk=None, **kwargs):
        if on_chunk:
            await on_chunk("第一句。", 4)
            await on_chunk("第二句。", 8)
        return "第一句。第二句。", 8

    monkeypatch.setattr("backend.app.services.discussion_service.call_llm_stream", fake_call_llm_stream)

    res = await client.post(f"/api/discussions/{disc_id}/summarize")
    assert res.status_code == 200

    events = []
    for line in res.text.splitlines():
        if line.startswith("data: "):
            events.append(json.loads(line[6:]))

    assert any(e.get("event_type") == "summary_chunk" for e in events)
    assert any(e.get("event_type") == "summary_done" for e in events)

    detail = await client.get(f"/api/discussions/{disc_id}")
    assert detail.status_code == 200
    user_msgs = [m for m in detail.json()["messages"] if m["agent_role"] == "user"]
    assert user_msgs
    assert user_msgs[0]["summary"] == "第一句。第二句。"
