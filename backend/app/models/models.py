from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey, Enum as SAEnum, JSON
from sqlalchemy.orm import relationship
from datetime import datetime, timezone
import enum

from ..database import Base


class DiscussionStatus(str, enum.Enum):
    CREATED = "created"
    PLANNING = "planning"
    DISCUSSING = "discussing"
    REFLECTING = "reflecting"
    SYNTHESIZING = "synthesizing"
    WAITING_INPUT = "waiting_input"
    COMPLETED = "completed"
    FAILED = "failed"


class DiscussionMode(str, enum.Enum):
    AUTO = "auto"
    DEBATE = "debate"
    BRAINSTORM = "brainstorm"
    SEQUENTIAL = "sequential"
    CUSTOM = "custom"


class AgentRole(str, enum.Enum):
    HOST = "host"
    PANELIST = "panelist"
    CRITIC = "critic"
    USER = "user"


class Discussion(Base):
    __tablename__ = "discussions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    topic = Column(Text, nullable=False)
    mode = Column(SAEnum(DiscussionMode), default=DiscussionMode.AUTO, nullable=False)
    status = Column(SAEnum(DiscussionStatus), default=DiscussionStatus.CREATED, nullable=False)
    llm_configs = Column(JSON, nullable=False, default=list)
    current_round = Column(Integer, default=0)
    max_rounds = Column(Integer, default=3)
    title = Column(String(200), nullable=True)
    final_summary = Column(Text, nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    agents = relationship("AgentConfig", back_populates="discussion", cascade="all, delete-orphan")
    messages = relationship("Message", back_populates="discussion", cascade="all, delete-orphan", order_by="Message.created_at")
    materials = relationship("DiscussionMaterial", back_populates="discussion", cascade="all, delete-orphan")
    observer_messages = relationship("ObserverMessage", back_populates="discussion", cascade="all, delete-orphan", order_by="ObserverMessage.created_at")


class AgentConfig(Base):
    __tablename__ = "agent_configs"

    id = Column(Integer, primary_key=True, autoincrement=True)
    discussion_id = Column(Integer, ForeignKey("discussions.id"), nullable=False)
    name = Column(String(100), nullable=False)
    role = Column(SAEnum(AgentRole), nullable=False)
    persona = Column(Text, nullable=True)
    provider = Column(String(50), nullable=False, default="openai")
    model = Column(String(100), nullable=False, default="gpt-4o")
    api_key = Column(String(500), nullable=True)
    base_url = Column(String(500), nullable=True)

    discussion = relationship("Discussion", back_populates="agents")


class LLMProvider(Base):
    __tablename__ = "llm_providers"

    id = Column(Integer, primary_key=True, autoincrement=True)
    name = Column(String(100), nullable=False)
    provider = Column(String(50), nullable=False)
    api_key = Column(String(500), nullable=True)
    base_url = Column(String(500), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))

    models = relationship("LLMModel", back_populates="provider_rel", cascade="all, delete-orphan")


class LLMModel(Base):
    __tablename__ = "llm_models"

    id = Column(Integer, primary_key=True, autoincrement=True)
    provider_id = Column(Integer, ForeignKey("llm_providers.id"), nullable=False)
    model = Column(String(100), nullable=False)
    name = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    provider_rel = relationship("LLMProvider", back_populates="models")


class DiscussionMaterial(Base):
    __tablename__ = "discussion_materials"

    id = Column(Integer, primary_key=True, autoincrement=True)
    discussion_id = Column(Integer, ForeignKey("discussions.id"), nullable=True)  # NULL = library item
    filename = Column(String(255), nullable=False)
    filepath = Column(String(500), nullable=False)
    file_type = Column(String(20), nullable=False)  # "file" | "image"
    mime_type = Column(String(100), nullable=True)
    file_size = Column(Integer, nullable=True)
    text_content = Column(Text, nullable=True)
    status = Column(String(20), default="ready", nullable=False)  # "processing" | "ready" | "failed"
    meta_info = Column(JSON, nullable=True)  # LLM-generated metadata (summary, keywords, type)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    discussion = relationship("Discussion", back_populates="materials")


class Message(Base):
    __tablename__ = "messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    discussion_id = Column(Integer, ForeignKey("discussions.id"), nullable=False)
    agent_name = Column(String(100), nullable=False)
    agent_role = Column(SAEnum(AgentRole), nullable=False)
    content = Column(Text, nullable=False)
    summary = Column(Text, nullable=True)
    round_number = Column(Integer, default=0)
    cycle_index = Column(Integer, default=0, nullable=False)
    phase = Column(String(50), nullable=True)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    discussion = relationship("Discussion", back_populates="messages")


class SystemSetting(Base):
    __tablename__ = "system_settings"

    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=True)
    updated_at = Column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class ObserverMessage(Base):
    __tablename__ = "observer_messages"

    id = Column(Integer, primary_key=True, autoincrement=True)
    discussion_id = Column(Integer, ForeignKey("discussions.id"), nullable=False)
    role = Column(String(20), nullable=False)  # "user" | "observer"
    content = Column(Text, nullable=False)
    created_at = Column(DateTime, default=lambda: datetime.now(timezone.utc))

    discussion = relationship("Discussion", back_populates="observer_messages")
