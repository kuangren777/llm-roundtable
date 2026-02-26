"""Shared test fixtures for unit tests."""
import sys
import os
from contextlib import asynccontextmanager
import pytest
import pytest_asyncio
from httpx import AsyncClient, ASGITransport
from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession
from sqlalchemy.pool import NullPool

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from backend.app.database import Base, get_db
from backend.app.main import app

TEST_DB_URL = "sqlite+aiosqlite:////tmp/multi_llm_debate_test.db"
TEST_DB_PATH = "/tmp/multi_llm_debate_test.db"
test_engine = create_async_engine(TEST_DB_URL, echo=False, poolclass=NullPool)
TestSession = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


async def override_get_db():
    async with TestSession() as session:
        yield session


app.dependency_overrides[get_db] = override_get_db


@asynccontextmanager
async def _test_lifespan(_app):
    yield


# Disable production startup hooks (init_db against real db) in tests.
app.router.lifespan_context = _test_lifespan


@pytest_asyncio.fixture(autouse=True)
async def setup_db():
    """Create and tear down test database for each test."""
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)
    sync_engine = create_engine(TEST_DB_URL.replace("sqlite+aiosqlite", "sqlite"), echo=False)
    Base.metadata.create_all(sync_engine)
    sync_engine.dispose()
    yield
    sync_engine = create_engine(TEST_DB_URL.replace("sqlite+aiosqlite", "sqlite"), echo=False)
    Base.metadata.drop_all(sync_engine)
    sync_engine.dispose()
    if os.path.exists(TEST_DB_PATH):
        os.remove(TEST_DB_PATH)


@pytest_asyncio.fixture
async def client():
    """Async HTTP client for testing FastAPI endpoints."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        # Default logged-in user for endpoints requiring auth.
        res = await c.post(
            "/api/auth/register",
            json={"email": "tester@example.com", "password": "TestPass123!"},
        )
        assert res.status_code == 200
        yield c
