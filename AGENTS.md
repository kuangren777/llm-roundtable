# Repository Guidelines

## Project Structure & Module Organization
This project is split into a FastAPI backend and a React/Vite frontend.
- `backend/app/`: application code (`api/`, `services/`, `models/`, `schemas/`, `database.py`, `main.py`)
- `backend/alembic/`: database migration config and version scripts
- `frontend/src/`: UI code (`pages/`, `services/`, `styles/`, `App.jsx`, `main.jsx`)
- `unit_test/`: pytest suite for backend APIs, schemas, discussion flow, and LLM service behavior
- `config/`: runtime configuration files (including `.env`)
- `scripts/`: setup and restart helpers

## Build, Test, and Development Commands
Run commands from repository root unless noted.
- `bash scripts/setup.sh`: install backend/frontend dependencies and build frontend assets
- `uvicorn backend.app.main:app --reload`: run backend API on port 8000
- `cd frontend && npm run dev`: run frontend dev server on port 3000
- `cd frontend && npm run build`: create production frontend bundle
- `pytest -q`: run backend/unit tests
- `bash scripts/restart.sh`: restart backend + frontend and write logs to `temp/`

## Coding Style & Naming Conventions
- Python: follow PEP 8, 4-space indentation, `snake_case` for functions/modules, `PascalCase` for classes.
- Keep backend modules focused by layer (API routes in `api/`, orchestration in `services/`).
- React: functional components with `PascalCase` filenames (`CreatePage.jsx`), hooks/state in `camelCase`.
- Match existing frontend style: single quotes, minimal semicolons, and clear prop naming.
- Prefer descriptive endpoint and schema names that mirror discussion-domain concepts.

## Testing Guidelines
- Framework: `pytest` (configured in `pyproject.toml`, tests under `unit_test/`).
- Naming: files `test_*.py`, functions `test_*`, shared fixtures in `unit_test/conftest.py`.
- Add tests for any API/service behavior changes and bug fixes (regression tests required).
- Run targeted tests during iteration, e.g. `pytest unit_test/test_api.py -q`.

## Commit & Pull Request Guidelines
- Use Conventional Commit prefixes seen in history: `feat:`, `fix:` (avoid `WIP` in shared PRs).
- Keep commit messages concise and scoped to one logical change.
- PRs should include: purpose, key changes, test evidence (`pytest -q` output), and UI screenshots for frontend updates.
- Call out migration/config impacts explicitly (e.g., new Alembic revision or `.env` requirement).

## Security & Configuration Tips
- Store secrets in `config/.env`; never commit credentials.
- `debate.db` and `backend/uploads/` may contain local or sensitive content—review before committing.
- Validate external-provider settings and model keys in environment-based config, not hardcoded values.
