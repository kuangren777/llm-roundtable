# Multi-LLM Round Table Discussion

## Project Overview
Multi-agent discussion platform implementing the "Intelligent Round Table Host Pattern" — an orchestrator-workers-critic architecture where multiple LLMs collaborate in structured debates.

**Tech Stack:** FastAPI + LangGraph + LiteLLM (backend), React 18 + Vite (frontend), SQLite/Alembic (DB)

## Architecture Decisions

- **LangGraph** for stateful discussion workflow with conditional loops (host → panelists → critic → iterate/synthesize)
- **LiteLLM** for multi-provider LLM abstraction — supports OpenAI, Anthropic, Gemini, DeepSeek, Groq, Ollama, vLLM, etc.
- **SSE via fetch + ReadableStream** instead of EventSource (EventSource only supports GET; the `/run` endpoint is POST)
- **Pydantic V2 ConfigDict** used throughout — no deprecated `class Config`
- **Async SQLAlchemy + aiosqlite** for non-blocking DB access; Alembic configured for future MySQL/PostgreSQL migration

## Key Files

| File | Purpose |
|------|---------|
| `backend/app/services/discussion_engine.py` | LangGraph workflow (5 nodes: plan → discuss → critic → increment → synthesize) |
| `backend/app/services/llm_service.py` | LiteLLM wrapper with provider-to-model-string mapping |
| `backend/app/services/discussion_service.py` | DB orchestration + mode→agents resolution + SSE streaming |
| `backend/app/services/mode_templates.py` | Predefined agent templates per mode + round-robin LLM assignment |
| `backend/app/services/planner.py` | Auto mode LLM planner — generates optimal agent panel from topic |
| `backend/app/api/discussions.py` | REST endpoints (CRUD + SSE run) |
| `backend/app/schemas/schemas.py` | Pydantic request/response models (mode-aware) |
| `backend/app/models/models.py` | SQLAlchemy ORM (Discussion, AgentConfig, Message, LLMProvider) + enums |
| `backend/app/api/llm_providers.py` | Global LLM provider CRUD endpoints |
| `frontend/src/services/api.js` | API client with POST-based SSE streaming + LLM provider APIs |
| `frontend/src/App.jsx` | Chat-style layout: sidebar + main panel (state-driven, no router) |
| `frontend/src/pages/CreatePage.jsx` | Simplified creation: topic + mode (no LLM config) |
| `frontend/src/pages/DiscussionPage.jsx` | Live streaming discussion view (prop-driven) |
| `frontend/src/pages/SettingsPage.jsx` | Global LLM provider management UI |

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| fastapi | 0.115.6 | Web framework |
| langgraph | 0.2.60 | Discussion workflow graph |
| litellm | 1.55.10 | Multi-provider LLM calls |
| sqlalchemy | 2.0.36 | Async ORM |
| alembic | 1.14.1 | DB migrations |
| pydantic-settings | 2.7.1 | Config management |
| httpx | <0.28.0 | HTTP client (pinned for litellm compat) |

## Test Results
- 90 tests passing, 0 warnings
- Test files: `unit_test/test_api.py`, `test_llm_service.py`, `test_discussion_engine.py`, `test_schemas.py`, `test_mode_templates.py`
- Run: `python -m pytest unit_test/ -v`

## Changes Log

### Session 1 (2026-02-12)
**Goal:** Build complete frontend and test suite for the multi-LLM debate platform

**Changes made:**
- Fixed `frontend/src/services/api.js` — replaced EventSource (GET-only) with fetch+ReadableStream for POST-based SSE
- Created `frontend/src/pages/HomePage.jsx` — discussion list with status badges
- Created `frontend/src/pages/CreatePage.jsx` — form with dynamic agent config, provider presets, validation
- Created `frontend/src/pages/DiscussionPage.jsx` — live streaming view with phase indicators, message bubbles
- Created `frontend/src/styles/index.css` — dark theme, role-colored borders, responsive layout
- Fixed `backend/requirements.txt` — httpx version conflict with litellm (0.28.1 → <0.28.0)
- Fixed `backend/app/schemas/schemas.py` — migrated to Pydantic V2 ConfigDict (eliminated deprecation warnings)
- Fixed `backend/app/config.py` — migrated Settings to SettingsConfigDict
- Created initial Alembic migration (`8991597c1c94_initial_schema`)
- Created 4 test files with 53 tests covering: API endpoints, discussion engine logic, LLM service, schema validation
- Created `unit_test/conftest.py` — shared test fixtures (in-memory DB, async client)
- Added SPA serving to `backend/app/main.py` — serves built frontend from `backend/static/` in production
- Created `config/.env` from `.env.example`
- Created `scripts/setup.sh` — one-command project setup
- Added `backend/static/` to `.gitignore`

### Session 2 (2026-02-12)
**Goal:** Polish UI consistency and fix edge-case bugs

**Changes made:**
- Fixed `frontend/src/App.jsx` — navbar text English → Chinese for UI language consistency
- Fixed `frontend/index.html` — `lang="en"` → `lang="zh-CN"`, title → 多智能体圆桌讨论
- Fixed `frontend/src/pages/DiscussionPage.jsx` — stop button now resets status to "ready" (was stuck in "running" after abort)
- Fixed `backend/app/services/discussion_service.py` — added guard against duplicate runs (reject if status is not created/failed)
- Added DELETE endpoint for discussions (`DELETE /api/discussions/{id}`) with cascade delete of agents and messages
- Removed unused `ROLE_LABELS` constant from `DiscussionPage.jsx`
- Added `backend/__init__.py` and `unit_test/__init__.py` for proper package structure
- Added 2 new tests for delete endpoint (55 total)

### Session 3 (2026-02-14)
**Goal:** Implement simplified UX with orchestration modes (Auto/Debate/Brainstorm/Sequential/Custom)

**Architecture change:** Users now provide topic + LLM list + mode instead of manually configuring each agent. Backend auto-generates agents from mode templates or an LLM planner.

**Changes made:**
- Added `DiscussionMode` enum (auto, debate, brainstorm, sequential, custom) to `backend/app/models/models.py`
- Added `mode` and `llm_configs` (JSON) fields to Discussion model
- Updated `backend/app/schemas/schemas.py` — `DiscussionCreate` now takes `mode + llm_configs` instead of `agents` (agents optional for custom mode)
- Created `backend/app/services/mode_templates.py` — predefined agent templates for Debate/Brainstorm/Sequential + round-robin LLM assignment
- Created `backend/app/services/planner.py` — Auto mode LLM planner with JSON parsing and fallback panel
- Updated `backend/app/services/discussion_service.py` — mode→agents resolution at run time (planner for auto, templates for others)
- Redesigned `frontend/src/pages/CreatePage.jsx` — simplified UX: topic + mode dropdown + LLM provider list; custom mode shows agent config panel
- Updated `frontend/src/pages/HomePage.jsx` — mode badges on discussion cards
- Created Alembic migration `b2a3c4d5e6f7_add_mode_and_llm_configs.py`
- Created `unit_test/test_mode_templates.py` — 14 tests for templates, round-robin, planner parsing
- Updated `unit_test/test_api.py` — 4 new mode-based API tests, fixed existing tests for new schema
- Updated `unit_test/test_schemas.py` — 3 new tests for mode validation
- Total: 79 tests passing

### Session 4 (2026-02-14)
**Goal:** Global LLM settings + chat-style layout refactor

**Architecture changes:**
- LLM provider config moved from per-discussion to global `LLMProvider` table; `discussion.llm_configs` JSON retained as runtime snapshot
- Frontend switched from react-router multi-page to single-page state-driven layout (sidebar + main panel)

**Changes made:**
- Added `LLMProvider` model to `backend/app/models/models.py` — persistent global LLM config table
- Added `LLMProviderCreate`, `LLMProviderResponse` schemas to `backend/app/schemas/schemas.py`
- Removed `llm_configs` field from `DiscussionCreate` schema — backend now reads from DB
- Created `backend/app/api/llm_providers.py` — GET/POST/DELETE for `/api/llm-providers/`
- Registered `llm_providers_router` in `backend/app/main.py`
- Updated `backend/app/services/discussion_service.py` — `create_discussion` snapshots global LLM providers from DB
- Rewrote `frontend/src/App.jsx` — chat-style layout with sidebar (history list + settings) and main content panel
- Simplified `frontend/src/pages/CreatePage.jsx` — removed LLM config section, prop-driven (`onCreated` callback)
- Updated `frontend/src/pages/DiscussionPage.jsx` — accepts `discussionId` prop instead of URL params
- Created `frontend/src/pages/SettingsPage.jsx` — global LLM provider management (add/delete/presets)
- Updated `frontend/src/main.jsx` — removed react-router `BrowserRouter` wrapper
- Added `listLLMProviders`, `addLLMProvider`, `deleteLLMProvider` to `frontend/src/services/api.js`
- Rewrote `frontend/src/styles/index.css` — sidebar layout, settings page styles, removed navbar
- Updated `unit_test/test_api.py` — 7 new LLM provider tests, updated discussion tests (removed llm_configs payloads)
- Updated `unit_test/test_schemas.py` — 5 new tests for LLMProviderCreate + DiscussionCreate changes
- Total: 90 tests passing

### Session 5 (2026-02-14)
**Goal:** Provider/Model two-level separation + edit support

**Architecture change:** Flat `LLMProvider` table (one row per provider+model combo, duplicated API keys) split into normalized 1:N structure: `LLMProvider` (supplier-level, holds API key once) → `LLMModel` (model-level, many per provider). Snapshot format (`discussion.llm_configs` JSON) unchanged — downstream code (LangGraph engine, mode templates, planner) required zero changes.

**Changes made:**
- Refactored `backend/app/models/models.py` — removed `model` field from `LLMProvider`, added `updated_at` + `models` relationship; created new `LLMModel` class with FK to `LLMProvider`
- Rewrote `backend/app/schemas/schemas.py` — new schemas: `LLMProviderCreate/Update/Response` (provider-level, no `model` field), `LLMModelCreate/Update/Response`; `LLMProviderResponse` uses `@computed_field` for `has_api_key` bool
- Rewrote `backend/app/api/llm_providers.py` — 7 endpoints: provider CRUD (GET/POST/PUT/DELETE) + nested model CRUD (POST/PUT/DELETE under `/api/llm-providers/{id}/models`)
- Updated `backend/app/services/discussion_service.py` — snapshot logic now joins `LLMProvider` + `LLMModel` via `selectinload`
- Updated `frontend/src/services/api.js` — added `updateLLMProvider`, `addLLMModel`, `updateLLMModel`, `deleteLLMModel`
- Rewrote `frontend/src/pages/SettingsPage.jsx` — two-level UI: provider cards with nested model lists, inline editing for both, preset auto-creates provider + common models
- Updated `frontend/src/styles/index.css` — new provider-card/model-list/model-item nested styles, key-badge indicators
- Rewrote LLM tests in `unit_test/test_api.py` — 17 tests for provider CRUD, model CRUD, cascade delete, snapshot, API key hiding
- Updated `unit_test/test_schemas.py` — new test classes for `LLMProviderUpdate`, `LLMModelCreate`, `LLMModelUpdate`
- Total: 107 tests passing

### Session 6 (2026-02-14)
**Goal:** Discussion page enhancement — agent editing, copy buttons, title generation

**Architecture change:** Added "prepare-agents" endpoint that pre-generates agents before run time, enabling a preview/edit workflow. Previously agents were only resolved inside `run_discussion()`. Also added LLM-powered short title generation for sidebar display.

**Changes made:**
- Added `title` field to `Discussion` model in `backend/app/models/models.py`
- Added `AgentConfigUpdate` schema + `title` to `DiscussionResponse` in `backend/app/schemas/schemas.py`
- Added 3 new endpoints in `backend/app/api/discussions.py`: `PUT /{id}/agents/{agent_id}`, `POST /{id}/prepare-agents`, `POST /{id}/generate-title`
- Added `update_agent()`, `prepare_agents()`, `generate_title()` to `backend/app/services/discussion_service.py`
- Created Alembic migration `c3d4e5f6a7b8_add_title_to_discussions.py`
- Added `updateAgent`, `prepareAgents`, `generateTitle` to `frontend/src/services/api.js`
- Rewrote `frontend/src/pages/DiscussionPage.jsx` — agent editing panel (name/persona/provider/model per agent), `CopyButton` component on persona fields + message bubbles + summary, long topic title styling
- Updated `frontend/src/App.jsx` — sidebar shows `title || topic`, auto-generates title after discussion creation
- Added CSS for agent-edit-panel, copy-btn, topic-long, role-badge in `frontend/src/styles/index.css`
- Total: 95 tests passing (all green)

### Session 7 (2026-02-14)
**Goal:** Discussion materials support + LLM API base_url fix

**Architecture changes:**
- New `DiscussionMaterial` model for file/image uploads, stored in `uploads/{discussion_id}/`
- `_normalize_base_url()` in LLM service auto-appends `/v1` to bare-domain URLs (fixes OneAPI/New API HTML response issue)
- `DiscussionState` gains `materials` field — all 4 LangGraph prompt nodes inject reference materials after topic
- CreatePage redesigned as two-step flow: topic+materials → config modal → create+upload+start

**Changes made:**
- Fixed `backend/app/services/llm_service.py` — added `_normalize_base_url()` (appends `/v1` only when URL has no path), HTML response detection raises `ValueError`
- Added `DiscussionMaterial` model + `materials` relationship on `Discussion` in `backend/app/models/models.py`
- Added `MaterialResponse` schema, updated `DiscussionDetail` with `materials` field in `backend/app/schemas/schemas.py`
- Created Alembic migration `d4e5f6a7b8c9_add_discussion_materials.py`
- Added `upload_materials()`, `list_materials()`, `delete_material()`, `_build_materials_text()` to `backend/app/services/discussion_service.py`
- Updated `get_discussion()` to `selectinload(Discussion.materials)`, `run_discussion()` passes materials text to engine
- Updated `delete_discussion()` to clean up uploaded files on disk
- Added `_format_materials()` helper + injected materials into all 4 prompt nodes in `backend/app/services/discussion_engine.py`
- Added 3 material endpoints (POST/GET/DELETE) in `backend/app/api/discussions.py`
- Added `uploadMaterials`, `listMaterials`, `deleteMaterial` to `frontend/src/services/api.js`
- Rewrote `frontend/src/pages/CreatePage.jsx` — two-step flow: drag-drop upload area + image thumbnails → config modal (mode/rounds/agents)
- Added upload-area, upload-file-list, upload-thumb, modal-overlay/content/header/body/footer CSS in `frontend/src/styles/index.css`
- Updated `unit_test/test_llm_service.py` — adjusted assertions for normalized base_url behavior
- Updated `backend/alembic/env.py` — imported `DiscussionMaterial`
- Fixed SSE disconnect resilience: added `finally` block to `run_discussion()` that resets stuck intermediate statuses (PLANNING/DISCUSSING/REFLECTING/SYNTHESIZING) to FAILED on client disconnect (`GeneratorExit` is `BaseException`, not caught by `except Exception`)
- Added logging + error handling to `event_stream()` wrapper in `backend/app/api/discussions.py`
- Total: 95 tests passing

### Session 8 (2026-02-15)
**Goal:** LLM 调用实时进度可视化 — streaming progress for all LLM calls

**Architecture change:** Unified queue + streaming LLM + progress events. `contextvars.ContextVar` passes an `asyncio.Queue` into LangGraph nodes without polluting the TypedDict state. Graph iteration and LLM streaming progress both flow through the same queue, preserving event order. Frontend displays real-time character counters per agent.

**Changes made:**
- Added `call_llm_stream()` to `backend/app/services/llm_service.py` — streaming LLM call with `on_chunk` async callback, returns `(full_text, total_chars)`
- Added `chars_received` and `llm_status` fields to `DiscussionEvent` in `backend/app/schemas/schemas.py`
- Added `progress_queue_var` (ContextVar) + `_call_with_progress()` helper to `backend/app/services/discussion_engine.py` — throttled progress events (every 5 chunks), falls back to non-streaming when no queue is set (tests)
- Replaced `call_llm()` with `_call_with_progress()` in all 4 engine nodes (host_planning, panelist_discussion, critic, synthesis)
- Refactored `run_discussion()` in `backend/app/services/discussion_service.py` — queue-based dispatch: graph runs in `asyncio.create_task`, progress + node events merged via `asyncio.Queue`, `task.cancel()` on error
- Added `llmProgress` state + `llm_progress` SSE handler + `LLMProgressBar` component to `frontend/src/pages/DiscussionPage.jsx`
- Added `.llm-progress` / `.llm-progress-item` / `.llm-progress-chars` / `progress-pulse` animation CSS to `frontend/src/styles/index.css`
- Total: 95 tests passing

### Session 9 (2026-02-15)
**Goal:** Fix multi-round bug + non-blocking user input during discussions

**Bug fix:** Critic prompt included `VERDICT: SYNTHESIZE` instruction, causing LLMs to short-circuit on round 1. Removed VERDICT mechanism entirely — `should_continue_or_synthesize` now uses pure round counting.

**Architecture change:** Non-blocking user message injection. Module-level `_pending_user_messages` dict (keyed by discussion_id) holds queued messages. `host_planning_node` consumes all pending messages at the start of each round, injecting them into `state.messages`. Frontend shows a persistent input bar during running discussions with optimistic updates.

**Changes made:**
- Fixed `backend/app/services/discussion_engine.py` — removed VERDICT from critic prompt, removed VERDICT check from `should_continue_or_synthesize`, added `_pending_user_messages` dict, added `discussion_id` to `DiscussionState`, `host_planning_node` consumes pending user messages and emits `user_message_consumed` events
- Added `USER = "user"` to `AgentRole` enum in `backend/app/models/models.py`
- Added `UserInputRequest` schema to `backend/app/schemas/schemas.py`
- Added `submit_user_input()` to `backend/app/services/discussion_service.py` — saves to DB + queues for engine; cleanup in finally block
- Updated `run_discussion()` — passes `discussion_id` in initial state, handles `user_message_consumed` queue events
- Added `POST /{id}/user-input` endpoint in `backend/app/api/discussions.py`
- Added `submitUserInput()` to `frontend/src/services/api.js`
- Updated `frontend/src/pages/DiscussionPage.jsx` — user input bar (Ctrl+Enter), optimistic message display, `MessageBubble` supports `role-user` with 👤 icon
- Added `.user-input-bar`, `.message-bubble.role-user` CSS in `frontend/src/styles/index.css`
- Updated `unit_test/test_discussion_engine.py` — replaced VERDICT tests with pure round-counting tests (ignores_verdict, multi_round_continues, single_round)
- Added `TestUserInputRequest` (3 tests) to `unit_test/test_schemas.py`
- Total: 100 tests passing

### Session 10 (2026-02-16)
**Goal:** Text paste material + global material library

**Architecture change:** `DiscussionMaterial.discussion_id` made nullable — `NULL` = library item, `int` = discussion-scoped. No new tables. Library items stored in `uploads/library/`, survive discussion deletion. When files are uploaded to a discussion, library copies are auto-created. Pasted text calls LLM to generate a short Chinese filename, saved as `.md`.

**Changes made:**
- Made `discussion_id` nullable in `backend/app/models/models.py` — library items have `discussion_id=NULL`
- Created Alembic migration `f6a7b8c9d0e1_material_library.py` — `batch_alter_table` for SQLite compat
- Added `TextPasteRequest`, `AttachMaterialsRequest`, `text_preview` field to `MaterialResponse` in `backend/app/schemas/schemas.py`
- Added 6 service functions to `backend/app/services/discussion_service.py`: `generate_material_filename()`, `save_text_material()`, `list_library_materials()`, `delete_library_material()`, `attach_library_materials()`, `upload_to_library()`
- Modified `upload_materials()` to auto-create library copies (best-effort)
- Created `backend/app/api/materials.py` — 4 endpoints: `GET /api/materials/`, `POST /api/materials/paste`, `POST /api/materials/upload`, `DELETE /api/materials/{id}`
- Added `POST /api/discussions/{id}/attach-materials` endpoint in `backend/app/api/discussions.py`
- Registered `materials_router` in `backend/app/main.py`
- Added 5 API functions to `frontend/src/services/api.js`: `listLibraryMaterials`, `pasteTextMaterial`, `uploadToLibrary`, `deleteLibraryMaterial`, `attachMaterialsToDiscussion`
- Rewrote `frontend/src/pages/CreatePage.jsx` — tabbed material section (上传文件 | 粘贴文本 | 素材库) with search, checkbox selection, auto-attach on submit
- Added material-tabs, paste-section, library-list/item/search CSS to `frontend/src/styles/index.css`
- Total: 100 tests passing

### Session 11 (2026-02-16)
**Goal:** Auto-summarize with progress display — batch summarize unsummarized messages via SSE

**Bug fix:** Ran `alembic upgrade head` to apply the `e5f6a7b8c9d0` migration that added `summary` column to Message table (was causing `no such column: messages.summary` error).

**Changes made:**
- Added `summarize_discussion_messages()` async generator to `backend/app/services/discussion_service.py` — queries unsummarized long messages, calls `call_llm()` sequentially with progress events (`summary_progress`, `summary_done`, `summary_complete`)
- Added `POST /api/discussions/{id}/summarize` SSE endpoint to `backend/app/api/discussions.py`
- Added `streamSummarize()` to `frontend/src/services/api.js` — POST-based SSE via fetch+ReadableStream (same pattern as `streamDiscussion`)
- Updated `frontend/src/pages/DiscussionPage.jsx` — `summarizing`/`summaryProgress` state, `unsummarizedCount` derived from messages, "生成总结 (N条)" button in header controls (visible when completed/waiting_input), progress text during summarization, message state updates on `summary_done` events
- Added `.summary-btn` and `.summary-progress` CSS to `frontend/src/styles/index.css`
- Total: 100 tests passing

### Session 12 (2026-02-16)
**Goal:** Fix paste material 500 error + async processing with metadata

**Bug fix:** `save_text_material()` used `datetime.now(timezone.utc)` but never imported `datetime`/`timezone` → `NameError` → 500. Added `from datetime import datetime, timezone` to `discussion_service.py`.

**Architecture change:** Paste-to-library is now async. `save_text_material()` returns immediately with `status="processing"` and a placeholder filename. A background `asyncio.create_task` generates the LLM filename + metadata, then updates the DB row to `status="ready"`. Frontend polls every 2s while items are processing, and shows a metadata tooltip on hover.

**SQLAlchemy gotcha:** `metadata` is a reserved attribute name on `DeclarativeBase` — renamed to `meta_info` across all layers.

**Changes made:**
- Fixed missing `from datetime import datetime, timezone` import in `backend/app/services/discussion_service.py`
- Added `status` (String, default "ready") and `meta_info` (JSON, nullable) columns to `DiscussionMaterial` in `backend/app/models/models.py`
- Added `status`, `meta_info` fields to `MaterialResponse` in `backend/app/schemas/schemas.py`
- Created Alembic migration `g7b8c9d0e1f2_material_status_metadata.py`
- Rewrote `save_text_material()` — saves placeholder immediately, spawns `_process_material_bg()` background task
- Added `generate_material_metadata()` — LLM generates summary/keywords/type JSON
- Added `_process_material_bg()` — background task: generates filename + metadata, renames file, updates DB; sets `status="failed"` on error
- Updated `frontend/src/pages/CreatePage.jsx` — polling `useEffect` while items are processing, processing/failed indicators in library list, metadata tooltip on hover
- Added `.processing-indicator`, `.failed-indicator`, `.library-item-tooltip` CSS to `frontend/src/styles/index.css`
- Total: 100 tests passing

### Session 13 (2026-02-16)
**Goal:** Independent observer chat panel — a side panel where an LLM observes the full discussion and answers user questions in real time

**Architecture change:** New `ObserverMessage` table (separate from `Message` — no agent_name/round_number/phase fields). Observer chat uses the same `asyncio.Queue` + `create_task` streaming pattern as `run_discussion`, with `call_llm_stream` pushing chunks into the queue. The observer's system prompt includes the full discussion context (all messages + final summary) so it can analyze the debate.

**Changes made:**
- Added `ObserverMessage` model to `backend/app/models/models.py` — id, discussion_id FK, role ("user"|"observer"), content, created_at
- Added `observer_messages` relationship on `Discussion` with cascade delete
- Created Alembic migration `i9d0e1f2a3b4_add_observer_messages.py`
- Updated `backend/alembic/env.py` — imported `ObserverMessage`
- Added `ObserverChatRequest`, `ObserverMessageResponse`, `ObserverEvent` schemas to `backend/app/schemas/schemas.py`
- Added `observer_messages` field to `DiscussionDetail` schema
- Created `backend/app/services/observer_service.py` — `get_observer_history()`, `clear_observer_history()`, `chat_with_observer()` (streaming async generator)
- Created `backend/app/api/observer.py` — 3 endpoints: GET/DELETE history, POST chat (SSE)
- Registered `observer_router` in `backend/app/main.py`
- Updated `get_discussion()` in `discussion_service.py` — added `selectinload(Discussion.observer_messages)`
- Added `getObserverHistory`, `clearObserverHistory`, `streamObserverChat` to `frontend/src/services/api.js`
- Added `ObserverPanel` component to `frontend/src/pages/DiscussionPage.jsx` — collapsible right panel (360px), provider/model selector, streaming chat with typing cursor animation
- Wrapped discussion page in `discussion-page-wrapper` flex container for side-by-side layout
- Added observer CSS styles (panel, messages, config, input bar, typing cursor) to `frontend/src/styles/index.css`
- Added 4 observer tests to `unit_test/test_api.py`: empty history, error for missing discussion, clear history, observer_messages in detail
- Total: 113 tests passing
