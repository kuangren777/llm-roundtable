"""API routes for global LLM provider and model management."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from sqlalchemy.orm import selectinload

from ..database import get_db
from ..models.models import LLMProvider, LLMModel
from ..schemas.schemas import (
    LLMProviderCreate, LLMProviderUpdate, LLMProviderResponse,
    LLMModelCreate, LLMModelUpdate, LLMModelResponse,
)

router = APIRouter(prefix="/api/llm-providers", tags=["llm-providers"])


# --- Helper ---

async def _get_provider_or_404(db: AsyncSession, provider_id: int) -> LLMProvider:
    result = await db.execute(
        select(LLMProvider)
        .options(selectinload(LLMProvider.models))
        .where(LLMProvider.id == provider_id)
    )
    provider = result.scalar_one_or_none()
    if not provider:
        raise HTTPException(status_code=404, detail="LLM provider not found")
    return provider


# --- Provider CRUD ---

@router.get("/", response_model=list[LLMProviderResponse])
async def list_llm_providers(db: AsyncSession = Depends(get_db)):
    result = await db.execute(
        select(LLMProvider)
        .options(selectinload(LLMProvider.models))
        .order_by(LLMProvider.created_at.desc())
    )
    return list(result.scalars().all())


@router.post("/", response_model=LLMProviderResponse)
async def create_llm_provider(data: LLMProviderCreate, db: AsyncSession = Depends(get_db)):
    provider = LLMProvider(
        name=data.name,
        provider=data.provider,
        api_key=data.api_key,
        base_url=data.base_url,
    )
    db.add(provider)
    await db.commit()
    await db.refresh(provider, ["models"])
    return provider


@router.put("/{provider_id}", response_model=LLMProviderResponse)
async def update_llm_provider(
    provider_id: int, data: LLMProviderUpdate, db: AsyncSession = Depends(get_db)
):
    provider = await _get_provider_or_404(db, provider_id)
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(provider, key, value)
    await db.commit()
    await db.refresh(provider, ["models"])
    return provider


@router.delete("/{provider_id}", status_code=204)
async def delete_llm_provider(provider_id: int, db: AsyncSession = Depends(get_db)):
    provider = await _get_provider_or_404(db, provider_id)
    await db.delete(provider)
    await db.commit()


# --- Model CRUD (nested under provider) ---

@router.post("/{provider_id}/models", response_model=LLMModelResponse)
async def add_model(
    provider_id: int, data: LLMModelCreate, db: AsyncSession = Depends(get_db)
):
    await _get_provider_or_404(db, provider_id)
    model = LLMModel(
        provider_id=provider_id,
        model=data.model,
        name=data.name or data.model,
    )
    db.add(model)
    await db.commit()
    await db.refresh(model)
    return model


@router.put("/{provider_id}/models/{model_id}", response_model=LLMModelResponse)
async def update_model(
    provider_id: int, model_id: int, data: LLMModelUpdate, db: AsyncSession = Depends(get_db)
):
    await _get_provider_or_404(db, provider_id)
    result = await db.execute(
        select(LLMModel).where(LLMModel.id == model_id, LLMModel.provider_id == provider_id)
    )
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    update_data = data.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(model, key, value)
    await db.commit()
    await db.refresh(model)
    return model


@router.delete("/{provider_id}/models/{model_id}", status_code=204)
async def delete_model(
    provider_id: int, model_id: int, db: AsyncSession = Depends(get_db)
):
    await _get_provider_or_404(db, provider_id)
    result = await db.execute(
        select(LLMModel).where(LLMModel.id == model_id, LLMModel.provider_id == provider_id)
    )
    model = result.scalar_one_or_none()
    if not model:
        raise HTTPException(status_code=404, detail="Model not found")
    await db.delete(model)
    await db.commit()
