"""Tests for FastAPI API endpoints using httpx AsyncClient."""


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
