from datetime import datetime, timedelta, timezone

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .db import get_db
from .models import User

pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login", auto_error=False)


def hash_password(raw: str) -> str:
    return pwd_ctx.hash(raw)


def verify_password(raw: str, hashed: str) -> bool:
    return pwd_ctx.verify(raw, hashed)


def create_token(user_id: int, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {"sub": str(user_id), "role": role, "exp": expire}
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


async def current_user(
    token: str | None = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User:
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing token")
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        uid = int(payload["sub"])
    except (JWTError, KeyError, ValueError) as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"bad token: {e}")

    user = await db.get(User, uid)
    if not user:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "user not found")
    # Trial / time-limited account check.  Admins never expire — they're
    # the ones provisioning trials, locking themselves out would be bad.
    # Frontend reads `code: trial_expired` and ISO `expired_at` from
    # detail to show "联系管理员延期" UX and force-logout cached tokens
    # that outlived their account window.
    if user.role != "admin" and user.expires_at is not None:
        if user.expires_at <= datetime.now(timezone.utc):
            raise HTTPException(
                status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "trial_expired",
                    "expired_at": user.expires_at.isoformat(),
                    "message": "Trial period has ended. Contact admin to extend.",
                },
            )
    return user


async def current_admin(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin required")
    return user


async def current_user_optional(
    token: str | None = Depends(oauth2_scheme),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    """Resolve User when a token is present; return None otherwise.

    Used by endpoints that personalize their response for logged-in
    users but should still work for anonymous visitors (e.g. the home
    feed's "continue learning" rail).  Bad / expired tokens silently
    resolve to None so the page doesn't 401-bounce a stale-cookie
    visitor — they just see the unauthenticated view.  Real
    authenticated routes keep using `current_user` which still 401s."""
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
        uid = int(payload["sub"])
    except (JWTError, KeyError, ValueError):
        return None
    user = await db.get(User, uid)
    if not user:
        return None
    if user.role != "admin" and user.expires_at is not None:
        if user.expires_at <= datetime.now(timezone.utc):
            return None
    return user
