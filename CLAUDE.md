# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Backend dev server (from project root)
uvicorn backend.app.main:app --reload

# Frontend dev server (port 3000, proxies /api → localhost:8000)
cd frontend && npm run dev

# Run all tests
python -m pytest unit_test/ -v

# Run single test file
python -m pytest unit_test/test_api.py -v

# Run single test
python -m pytest unit_test/test_api.py::TestDiscussionEndpoints::test_create_discussion -v

# Database migrations (must cd into backend/)
cd backend && alembic upgrade head
cd backend && alembic revision --autogenerate -m "description"

# Full setup (install deps + build frontend)
bash scripts/setup.sh

# Production frontend build → backend/static/
cd frontend && npm run build
```

## Architecture

Multi-agent discussion platform: multiple LLMs debate topics in structured rounds via an orchestrator-workers-critic pattern.

**Tech stack:** FastAPI + LangGraph + LiteLLM (backend), React 18 + Vite (frontend), SQLite/aiosqlite + Alembic (DB)

### Backend (`backend/app/`)

**Request flow:** API routes → `discussion_service.py` (DB + orchestration) → `discussion_engine.py` (LangGraph workflow) → `llm_service.py` (LiteLLM calls)

**LangGraph workflow** (5 nodes in `discussion_engine.py`):
`host_planning` → `panelist_discussion` → `critic` → `should_continue_or_synthesize` (conditional: loop back or → `synthesis`)

- `progress_queue_var` (ContextVar) passes an `asyncio.Queue` into LangGraph nodes for streaming progress events without polluting the TypedDict state
- `_pending_user_messages` dict enables non-blocking user message injection mid-discussion
- Round counting controls iteration (no VERDICT mechanism)

**Discussion modes** (in `mode_templates.py`): Auto (LLM planner generates agents), Debate, Brainstorm, Sequential, Custom. Non-custom modes auto-generate agents from templates with round-robin LLM assignment.

**SSE streaming:** `run_discussion()` runs the graph in `asyncio.create_task`, merges progress + node events via `asyncio.Queue`, yields SSE events. Frontend uses `fetch + ReadableStream` (not EventSource — POST endpoint).

**Data model:** `LLMProvider` (1) → `LLMModel` (N) normalized structure. `discussion.llm_configs` JSON is a runtime snapshot. `DiscussionMaterial.discussion_id` nullable: NULL = library item, int = discussion-scoped.

### Frontend (`frontend/src/`)

- State-driven SPA (no router used despite react-router-dom being installed)
- `App.jsx`: sidebar (history + settings) + main panel
- `api.js`: all API calls + POST-based SSE via `fetch + ReadableStream`
- Vite dev server on port 3000 proxies `/api` to `http://localhost:8000`

## Key Conventions

- **Pydantic V2** — use `model_config = ConfigDict(...)`, never `class Config`
- **Async SQLAlchemy** — all DB access via `async_session`, use `selectinload()` for relationships
- **SQLAlchemy reserved names** — `metadata` is reserved on `DeclarativeBase`; the project uses `meta_info` instead
- **LLM base_url** — `_normalize_base_url()` in `llm_service.py` auto-appends `/v1` to bare-domain URLs
- **SSE disconnect** — `run_discussion()` has a `finally` block resetting stuck statuses to FAILED (`GeneratorExit` is `BaseException`)
- **Tests** — all under `unit_test/`, shared fixtures in `conftest.py` (in-memory SQLite), `asyncio_mode = "auto"` in `pyproject.toml`
- **UI language** — Chinese (zh-CN)
- **Alembic migrations** — run from `backend/` dir; `env.py` imports all models explicitly and overrides URL from settings
- **Config** — `config/.env` (not project root), DB file `debate.db` at project root
- **Uploads** — `backend/uploads/{discussion_id}/` for discussion files, `backend/uploads/library/` for library items
