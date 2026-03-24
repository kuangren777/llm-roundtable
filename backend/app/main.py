"""FastAPI application entry point."""
import time
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from starlette.requests import Request as StarletteRequest
from prometheus_client import generate_latest, CONTENT_TYPE_LATEST

from .api.auth import router as auth_router
from .api.discussions import router as discussions_router
from .api.llm_providers import router as llm_providers_router
from .api.materials import router as materials_router
from .api.observer import router as observer_router
from .api.settings import router as settings_router
from .api.share import router as share_router
from .config import DEFAULT_JWT_SECRET, get_settings
from .database import init_db
from .logging_config import setup_logging
from .metrics import HTTP_REQUEST_COUNT, HTTP_REQUEST_DURATION

STATIC_DIR = Path(__file__).parent.parent / "static"
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.jwt_secret_key == DEFAULT_JWT_SECRET:
        raise RuntimeError(
            "JWT_SECRET_KEY is using the default insecure value. "
            "Set JWT_SECRET_KEY to a secure random string before starting the server."
        )
    setup_logging()
    await init_db()
    yield


app = FastAPI(
    title="Multi-Agent Round Table Discussion",
    description="A multi-agent discussion system using the Intelligent Round Table Host Pattern",
    version="1.0.0",
    lifespan=lifespan,
)


@app.middleware("http")
async def metrics_middleware(request: StarletteRequest, call_next):
    start = time.time()
    response = await call_next(request)
    duration = time.time() - start
    endpoint = request.url.path
    if not endpoint.startswith("/metrics"):
        HTTP_REQUEST_COUNT.labels(
            method=request.method,
            endpoint=endpoint,
            status_code=response.status_code,
        ).inc()
        HTTP_REQUEST_DURATION.labels(
            method=request.method,
            endpoint=endpoint,
        ).observe(duration)
    return response


app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_allowed_origins_list,
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


@app.get("/metrics")
async def metrics():
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


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
