"""Tests for Pydantic schemas validation."""
import sys
import os
import pytest
from pydantic import ValidationError

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.app.schemas.schemas import (
    AgentConfigCreate,
    DiscussionCreate,
    DiscussionEvent,
    LLMProviderConfig,
    LLMProviderCreate,
    LLMProviderUpdate,
    LLMProviderResponse,
    LLMModelCreate,
    LLMModelUpdate,
    LLMModelResponse,
)
from backend.app.models.models import AgentRole


class TestAgentConfigCreate:
    def test_valid_minimal(self):
        a = AgentConfigCreate(name="Host", role=AgentRole.HOST)
        assert a.provider == "openai"
        assert a.model == "gpt-4o"
        assert a.api_key is None

    def test_valid_full(self):
        a = AgentConfigCreate(
            name="Expert",
            role=AgentRole.PANELIST,
            persona="ML researcher",
            provider="anthropic",
            model="claude-sonnet-4-5-20250929",
            api_key="sk-test",
            base_url="https://custom.api",
        )
        assert a.persona == "ML researcher"
        assert a.provider == "anthropic"

    def test_missing_name_fails(self):
        with pytest.raises(ValidationError):
            AgentConfigCreate(role=AgentRole.HOST)

    def test_missing_role_fails(self):
        with pytest.raises(ValidationError):
            AgentConfigCreate(name="Host")

    def test_invalid_role_fails(self):
        with pytest.raises(ValidationError):
            AgentConfigCreate(name="Host", role="invalid_role")


class TestDiscussionCreate:
    def test_valid_minimal(self):
        d = DiscussionCreate(topic="Test topic")
        assert d.max_rounds == 3
        assert d.mode.value == "auto"
        assert d.agents is None

    def test_custom_mode_with_agents(self):
        d = DiscussionCreate(
            topic="Test",
            mode="custom",
            agents=[AgentConfigCreate(name="Host", role=AgentRole.HOST)],
        )
        assert d.mode.value == "custom"
        assert len(d.agents) == 1

    def test_max_rounds_bounds(self):
        with pytest.raises(ValidationError):
            DiscussionCreate(topic="Test", max_rounds=0)
        with pytest.raises(ValidationError):
            DiscussionCreate(topic="Test", max_rounds=11)

    def test_missing_topic_fails(self):
        with pytest.raises(ValidationError):
            DiscussionCreate()

    def test_invalid_mode_fails(self):
        with pytest.raises(ValidationError):
            DiscussionCreate(topic="Test", mode="invalid_mode")

    def test_no_llm_configs_field(self):
        """DiscussionCreate no longer has llm_configs — it's read from global settings."""
        d = DiscussionCreate(topic="Test", mode="debate")
        assert not hasattr(d, "llm_configs") or "llm_configs" not in d.model_fields


class TestDiscussionEvent:
    def test_minimal_event(self):
        e = DiscussionEvent(event_type="phase_change")
        assert e.agent_name is None
        assert e.content is None

    def test_message_event(self):
        e = DiscussionEvent(
            event_type="message",
            agent_name="Host",
            agent_role="host",
            content="Hello",
            phase="planning",
            round_number=0,
        )
        assert e.event_type == "message"
        assert e.round_number == 0


class TestLLMProviderConfig:
    def test_defaults(self):
        c = LLMProviderConfig()
        assert c.provider == "openai"
        assert c.model == "gpt-4o"


class TestLLMProviderCreate:
    def test_valid_minimal(self):
        p = LLMProviderCreate(name="My OpenAI", provider="openai")
        assert p.api_key is None
        assert p.base_url is None

    def test_valid_full(self):
        p = LLMProviderCreate(
            name="My Anthropic",
            provider="anthropic",
            api_key="sk-test",
            base_url="https://custom.api",
        )
        assert p.name == "My Anthropic"
        assert p.provider == "anthropic"

    def test_missing_name_fails(self):
        with pytest.raises(ValidationError):
            LLMProviderCreate(provider="openai")

    def test_missing_provider_fails(self):
        with pytest.raises(ValidationError):
            LLMProviderCreate(name="Test")


class TestLLMProviderUpdate:
    def test_all_optional(self):
        u = LLMProviderUpdate()
        assert u.name is None
        assert u.provider is None
        assert u.api_key is None

    def test_partial_update(self):
        u = LLMProviderUpdate(name="New Name")
        assert u.name == "New Name"
        assert u.provider is None


class TestLLMModelCreate:
    def test_valid_minimal(self):
        m = LLMModelCreate(model="gpt-4o")
        assert m.name is None

    def test_valid_with_name(self):
        m = LLMModelCreate(model="gpt-4o", name="GPT-4o")
        assert m.name == "GPT-4o"

    def test_missing_model_fails(self):
        with pytest.raises(ValidationError):
            LLMModelCreate()


class TestLLMModelUpdate:
    def test_all_optional(self):
        u = LLMModelUpdate()
        assert u.model is None
        assert u.name is None

    def test_partial_update(self):
        u = LLMModelUpdate(name="New Name")
        assert u.name == "New Name"
        assert u.model is None
