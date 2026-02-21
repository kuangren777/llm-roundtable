"""API routes for the global material library."""
import os

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..models.models import DiscussionMaterial
from ..schemas.schemas import MaterialResponse, TextPasteRequest
from ..services.discussion_service import (
    list_library_materials,
    save_text_material,
    upload_to_library,
    delete_library_material,
)

router = APIRouter(prefix="/api/materials", tags=["materials"])


@router.get("/", response_model=list[MaterialResponse])
async def list_library_endpoint(db: AsyncSession = Depends(get_db)):
    items = await list_library_materials(db)
    results = []
    for m in items:
        resp = MaterialResponse.model_validate(m)
        # Add text preview for browsing
        if m.text_content:
            resp.text_preview = m.text_content[:200]
        results.append(resp)
    return results


@router.post("/paste", response_model=MaterialResponse)
async def paste_text_endpoint(data: TextPasteRequest, db: AsyncSession = Depends(get_db)):
    if not data.content.strip():
        raise HTTPException(status_code=400, detail="Content cannot be empty")
    material = await save_text_material(db, data.content)
    resp = MaterialResponse.model_validate(material)
    if material.text_content:
        resp.text_preview = material.text_content[:200]
    return resp


@router.post("/upload", response_model=list[MaterialResponse])
async def upload_to_library_endpoint(
    files: list[UploadFile] = File(...),
    db: AsyncSession = Depends(get_db),
):
    materials = await upload_to_library(db, files)
    return materials


@router.delete("/{material_id}", status_code=204)
async def delete_library_endpoint(material_id: int, db: AsyncSession = Depends(get_db)):
    deleted = await delete_library_material(db, material_id)
    if not deleted:
        raise HTTPException(status_code=404, detail="Library material not found")


_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))


def _resolve_filepath(stored_path: str) -> str | None:
    """Resolve stored filepath, handling machine migration."""
    if os.path.isfile(stored_path):
        return stored_path
    # Try extracting relative path from 'backend/uploads/...'
    idx = stored_path.find("backend/uploads/")
    if idx >= 0:
        candidate = os.path.join(_PROJECT_ROOT, stored_path[idx:])
        if os.path.isfile(candidate):
            return candidate
    return None


@router.get("/{material_id}/download")
async def download_material(material_id: int, db: AsyncSession = Depends(get_db)):
    """Download/view a material file by ID (works for both library and discussion materials)."""
    result = await db.execute(
        select(DiscussionMaterial).where(DiscussionMaterial.id == material_id)
    )
    material = result.scalar_one_or_none()
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    resolved = _resolve_filepath(material.filepath)
    if not resolved:
        raise HTTPException(status_code=404, detail="File not found on disk")
    return FileResponse(
        resolved,
        filename=material.filename,
        media_type=material.mime_type or "application/octet-stream",
    )


@router.get("/{material_id}/content")
async def material_content(material_id: int, db: AsyncSession = Depends(get_db)):
    """Return material text content for in-page preview."""
    result = await db.execute(
        select(DiscussionMaterial).where(DiscussionMaterial.id == material_id)
    )
    material = result.scalar_one_or_none()
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    if material.text_content:
        return {"content": material.text_content, "filename": material.filename, "mime_type": material.mime_type}
    # For non-text files, try reading from disk
    resolved = _resolve_filepath(material.filepath)
    if not resolved:
        raise HTTPException(status_code=404, detail="File not found on disk")
    try:
        with open(resolved, "r", encoding="utf-8") as f:
            return {"content": f.read(), "filename": material.filename, "mime_type": material.mime_type}
    except (UnicodeDecodeError, OSError):
        raise HTTPException(status_code=400, detail="Binary file cannot be previewed")
