"""Authentication API routes."""
from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from ..database import get_db
from ..schemas.schemas import UserRegisterRequest, UserLoginRequest, AuthStatusResponse
from ..services.auth_service import (
    get_user_by_email,
    create_user,
    authenticate_user,
    create_access_token,
    set_auth_cookie,
    clear_auth_cookie,
    get_current_user,
)
from ..models.models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/register", response_model=AuthStatusResponse)
async def register(data: UserRegisterRequest, response: Response, db: AsyncSession = Depends(get_db)):
    existing = await get_user_by_email(db, data.email)
    if existing:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Email already registered")
    user = await create_user(db, data.email, data.password, is_admin=False)
    token = create_access_token({"sub": str(user.id), "email": user.email})
    set_auth_cookie(response, token)
    return {"user": user}


@router.post("/login", response_model=AuthStatusResponse)
async def login(data: UserLoginRequest, response: Response, db: AsyncSession = Depends(get_db)):
    user = await authenticate_user(db, data.email, data.password)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid email or password")
    token = create_access_token({"sub": str(user.id), "email": user.email})
    set_auth_cookie(response, token)
    return {"user": user}


@router.post("/logout")
async def logout(response: Response):
    clear_auth_cookie(response)
    return {"ok": True}


@router.get("/me", response_model=AuthStatusResponse)
async def me(current_user: User = Depends(get_current_user)):
    return {"user": current_user}

