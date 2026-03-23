"""Shared test fixtures for unit tests."""
import os
import sys
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.app.database import Base, get_db
from backend.app.main import app

TEST_DB_PATH: str | None = None
TEST_DB_URL: str | None = None


class _TestSessionProxy:
    factory: async_sessionmaker[AsyncSession] | None = None

    def __call__(self):
        if self.factory is None:
            raise RuntimeError("TestSession is not initialized")
        return self.factory()


TestSession = _TestSessionProxy()


@asynccontextmanager
async def _test_lifespan(_app):
    yield


# Disable production startup hooks (init_db against real db) in tests.
app.router.lifespan_context = _test_lifespan


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    """Create and tear down test database for each test."""
    global TEST_DB_PATH, TEST_DB_URL

    temp_dir = tempfile.TemporaryDirectory(prefix="multi_llm_debate_test_")
    TEST_DB_PATH = str(Path(temp_dir.name) / "test.db")
    TEST_DB_URL = f"sqlite+aiosqlite:///{TEST_DB_PATH}"

    test_engine = create_async_engine(TEST_DB_URL, echo=False, poolclass=NullPool)
    TestSession.factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)

    async def override_get_db():
        async with TestSession() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db

    sync_engine = create_engine(TEST_DB_URL.replace("sqlite+aiosqlite", "sqlite"), echo=False)
    Base.metadata.create_all(sync_engine)
    sync_engine.dispose()

    yield

    app.dependency_overrides.pop(get_db, None)
    await test_engine.dispose()
    temp_dir.cleanup()


@pytest_asyncio.fixture
async def client():
    """Async HTTP client for testing FastAPI endpoints."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="https://test") as c:
        # Default logged-in user for endpoints requiring auth.
        res = await c.post(
            "/api/auth/register",
            json={"email": "tester@example.com", "password": "TestPass123!"},
        )
        assert res.status_code == 200
        yield c
