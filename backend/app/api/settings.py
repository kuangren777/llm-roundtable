"""System settings API — key-value store for app-wide configuration."""
import json
from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from ..database import get_db
from ..models.models import SystemSetting, LLMProvider, LLMModel
from ..schemas.schemas import SystemSettingResponse

router = APIRouter(prefix="/api/settings", tags=["settings"])


@router.get("/{key}", response_model=SystemSettingResponse)
async def get_setting(key: str, db: AsyncSession = Depends(get_db)):
    result = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    setting = result.scalar_one_or_none()
    if not setting:
        return SystemSettingResponse(key=key, value=None)
    return SystemSettingResponse(key=setting.key, value=setting.value)


@router.put("/{key}", response_model=SystemSettingResponse)
async def set_setting(key: str, body: dict, db: AsyncSession = Depends(get_db)):
    value = json.dumps(body.get("value")) if body.get("value") is not None else None
    result = await db.execute(select(SystemSetting).where(SystemSetting.key == key))
    setting = result.scalar_one_or_none()
    if setting:
        setting.value = value
    else:
        setting = SystemSetting(key=key, value=value)
        db.add(setting)
    await db.commit()
    return SystemSettingResponse(key=key, value=value)
