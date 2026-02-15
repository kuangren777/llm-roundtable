from pydantic import BaseModel, ConfigDict, Field, computed_field
from typing import Optional
from datetime import datetime
from ..models.models import DiscussionStatus, DiscussionMode, AgentRole


class LLMProviderConfig(BaseModel):
    provider: str = "openai"
    model: str = "gpt-4o"
    api_key: Optional[str] = None
    base_url: Optional[str] = None


class AgentConfigCreate(BaseModel):
    name: str
    role: AgentRole
    persona: Optional[str] = None
    provider: str = "openai"
    model: str = "gpt-4o"
    api_key: Optional[str] = None
    base_url: Optional[str] = None


class AgentConfigResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    role: AgentRole
    persona: Optional[str]
    provider: str
    model: str
    base_url: Optional[str]


# --- LLM Model schemas ---

class LLMModelCreate(BaseModel):
    model: str
    name: Optional[str] = None


class LLMModelUpdate(BaseModel):
    model: Optional[str] = None
    name: Optional[str] = None


class LLMModelResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    model: str
    name: Optional[str]
    provider_id: int
    created_at: datetime


# --- LLM Provider schemas ---

class LLMProviderCreate(BaseModel):
    name: str
    provider: str
    api_key: Optional[str] = None
    base_url: Optional[str] = None


class LLMProviderUpdate(BaseModel):
    name: Optional[str] = None
    provider: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None


class LLMProviderResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    name: str
    provider: str
    base_url: Optional[str]
    created_at: datetime
    models: list[LLMModelResponse] = []

    # Expose whether an API key is set, without leaking the actual value
    api_key: Optional[str] = Field(exclude=True, default=None)

    @computed_field
    @property
    def has_api_key(self) -> bool:
        return bool(self.api_key)


# --- Material schemas ---

class MaterialResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    filename: str
    file_type: str
    mime_type: Optional[str]
    file_size: Optional[int]
    created_at: datetime


class AgentConfigUpdate(BaseModel):
    name: Optional[str] = None
    persona: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None


class DiscussionCreate(BaseModel):
    topic: str
    mode: DiscussionMode = DiscussionMode.AUTO
    max_rounds: int = Field(default=3, ge=1, le=10)
    agents: Optional[list[AgentConfigCreate]] = None  # Only used in Custom mode


class MessageResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    agent_name: str
    agent_role: AgentRole
    content: str
    round_number: int
    phase: Optional[str]
    created_at: datetime


class DiscussionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    topic: str
    title: Optional[str] = None
    mode: DiscussionMode
    status: DiscussionStatus
    current_round: int
    max_rounds: int
    final_summary: Optional[str]
    created_at: datetime
    updated_at: datetime
    agents: list[AgentConfigResponse] = []


class DiscussionDetail(DiscussionResponse):
    messages: list[MessageResponse] = []
    materials: list[MaterialResponse] = []


class DiscussionEvent(BaseModel):
    """SSE event sent to frontend during discussion."""
    event_type: str  # "phase_change", "message", "llm_progress", "error", "complete"
    agent_name: Optional[str] = None
    agent_role: Optional[str] = None
    content: Optional[str] = None
    phase: Optional[str] = None
    round_number: Optional[int] = None
    # LLM streaming progress fields
    chars_received: Optional[int] = None
    llm_status: Optional[str] = None  # "streaming" | "done"
