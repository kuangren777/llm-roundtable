"""Public share endpoints (read-only, no login required)."""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..schemas.schemas import DiscussionDetail
from ..services.discussion_service import get_discussion_by_share_code

router = APIRouter(prefix="/api/share", tags=["share"])


@router.get("/{share_code}", response_model=DiscussionDetail)
async def get_shared_discussion(share_code: str, db: AsyncSession = Depends(get_db)):
    discussion = await get_discussion_by_share_code(db, share_code)
    if not discussion:
        raise HTTPException(status_code=404, detail="Shared discussion not found")
    return discussion

