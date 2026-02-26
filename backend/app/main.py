"""FastAPI application entry point."""
import os
from contextlib import asynccontextmanager
from pathlib import Path
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from .database import init_db
from .api.discussions import router as discussions_router
from .api.llm_providers import router as llm_providers_router
from .api.settings import router as settings_router
from .api.materials import router as materials_router
from .api.observer import router as observer_router
from .api.auth import router as auth_router
from .api.share import router as share_router

STATIC_DIR = Path(__file__).parent.parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    yield


app = FastAPI(
    title="Multi-Agent Round Table Discussion",
    description="A multi-agent discussion system using the Intelligent Round Table Host Pattern",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(discussions_router)
app.include_router(llm_providers_router)
app.include_router(settings_router)
app.include_router(materials_router)
app.include_router(observer_router)
app.include_router(auth_router)
app.include_router(share_router)


@app.get("/api/health")
async def health_check():
    return {"status": "ok"}


# Serve built frontend in production (when backend/static/ exists)
if STATIC_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")

    @app.get("/{path:path}")
    async def serve_spa(path: str):
        """SPA fallback — serve index.html for all non-API routes."""
        file_path = STATIC_DIR / path
        if file_path.is_file():
            return FileResponse(file_path)
        return FileResponse(STATIC_DIR / "index.html")
