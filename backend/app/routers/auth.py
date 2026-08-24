import re
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import create_token, hash_password, verify_password
from ..config import settings
from ..db import get_db
from ..models import User
from ..schemas import (
    AuthConfigOut,
    GoogleAuthIn,
    TokenOut,
    UserLogin,
    UserOut,
    UserRegister,
)
from ..services.google_auth import GoogleAuthError, verify_id_token

router = APIRouter(prefix="/api/auth", tags=["auth"])

_USERNAME_SAFE = re.compile(r"[^a-z0-9_.-]+")


def _trial_expiry() -> datetime | None:
    """When a newly self-created account should stop working.

    None when AUTH_NEW_USER_TRIAL_DAYS is 0 — i.e. signup grants
    permanent accounts.  Anything else is now + N days, stored UTC.
    """
    days = settings.auth_new_user_trial_days
    if days <= 0:
        return None
    return datetime.now(timezone.utc) + timedelta(days=days)


async def _unique_username(db: AsyncSession, seed: str) -> str:
    """Derive a free username from an email local part.

    Users who sign up never type a username, but the column is unique and
    non-null, so we make one.  Collisions get a numeric suffix rather
    than an error — two people with the same gmail local part on
    different domains is completely normal.
    """
    base = _USERNAME_SAFE.sub("", (seed or "").strip().lower()).strip("._-")
    if len(base) < 3:
        base = f"user{base}" if base else "user"
    base = base[:48]
    candidate = base
    n = 1
    while await db.scalar(select(User.id).where(User.username == candidate)):
        n += 1
        candidate = f"{base}{n}"
        if n > 9999:  # pathological; fall back to something certainly free
            candidate = f"{base}{datetime.now(timezone.utc).timestamp():.0f}"
            break
    return candidate


def _expired_detail(user: User) -> dict:
    return {
        "code": "trial_expired",
        "expired_at": user.expires_at.isoformat(),
        "message": "Trial period has ended. Contact admin to extend.",
    }


def _is_expired(user: User) -> bool:
    # Admins are exempt — they shouldn't be able to lock themselves out.
    if user.role == "admin" or user.expires_at is None:
        return False
    return user.expires_at <= datetime.now(timezone.utc)


@router.get("/config", response_model=AuthConfigOut)
async def auth_config() -> AuthConfigOut:
    """Public — the login page fetches this before rendering."""
    return AuthConfigOut(
        self_signup=settings.auth_self_signup,
        trial_days=settings.auth_new_user_trial_days,
        google_client_id=settings.google_client_id,
    )


@router.post("/register", response_model=TokenOut)
async def register(body: UserRegister, db: AsyncSession = Depends(get_db)) -> TokenOut:
    """Self-serve signup — email + password, instant AUTH_NEW_USER_TRIAL_DAYS access.

    Email is the account key.  An address that already exists is refused
    rather than silently logged in: we can't tell a returning user from
    someone guessing at another person's address, and answering "that
    email is taken" only to the right password would be a login endpoint,
    which we already have.
    """
    if not settings.auth_self_signup:
        raise HTTPException(
            403,
            "registration closed - contact admin via Xiaohongshu for an account",
        )

    email = body.email.strip().lower()
    if await db.scalar(select(User.id).where(User.email == email)):
        raise HTTPException(409, "该邮箱已注册，请直接登录")

    username = body.username.strip().lower() if body.username.strip() else ""
    if username:
        if await db.scalar(select(User.id).where(User.username == username)):
            raise HTTPException(409, "该用户名已被占用")
    else:
        username = await _unique_username(db, email.split("@", 1)[0])

    user = User(
        username=username,
        email=email,
        password_hash=hash_password(body.password),
        role="user",
        auth_provider="local",
        expires_at=_trial_expiry(),
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return TokenOut(
        access_token=create_token(user.id, user.role),
        user=UserOut.model_validate(user),
    )


@router.post("/google", response_model=TokenOut)
async def google_login(body: GoogleAuthIn, db: AsyncSession = Depends(get_db)) -> TokenOut:
    """Sign in with Google — creates the account on first use.

    A verified Google email that matches an existing account signs into
    that account.  It does NOT reset the account's expiry: re-signing in
    through Google must not be a way to farm fresh trials.
    """
    try:
        info = await verify_id_token(body.credential, settings.google_client_id)
    except GoogleAuthError as e:
        # 503 rather than 401 when the server simply can't do Google auth
        # (unconfigured, or Google unreachable) — it's our problem, not a
        # bad credential, and the frontend shows a different message.
        if not settings.google_client_id or "cannot reach Google" in str(e):
            raise HTTPException(503, str(e))
        raise HTTPException(401, str(e))

    email = info["email"]
    user = await db.scalar(select(User).where(User.email == email))

    if user is None:
        if not settings.auth_self_signup:
            raise HTTPException(
                403,
                "registration closed - contact admin via Xiaohongshu for an account",
            )
        user = User(
            username=await _unique_username(db, email.split("@", 1)[0]),
            email=email,
            # No password — this account signs in through Google only.
            password_hash="",
            role="user",
            auth_provider="google",
            google_sub=info["sub"],
            expires_at=_trial_expiry(),
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)
    else:
        # Existing account: only backfill the Google id, never touch
        # expires_at or role.
        if info["sub"] and user.google_sub != info["sub"]:
            user.google_sub = info["sub"]
            await db.commit()
            await db.refresh(user)
        if _is_expired(user):
            raise HTTPException(403, detail=_expired_detail(user))

    return TokenOut(
        access_token=create_token(user.id, user.role),
        user=UserOut.model_validate(user),
    )


@router.post("/login", response_model=TokenOut)
async def login(body: UserLogin, db: AsyncSession = Depends(get_db)) -> TokenOut:
    ident = body.username.strip()
    # Signup users only ever see their email, so accept either identifier.
    user = await db.scalar(
        select(User).where(
            (User.username == ident) | (User.email == ident.lower())
        )
    )
    # An empty hash means a Google-only account; passlib would raise on it,
    # and there is no password that should ever match.
    if not user or not user.password_hash or not verify_password(body.password, user.password_hash):
        if user is not None and not user.password_hash:
            raise HTTPException(401, "该邮箱通过 Google 注册，请用 Google 登录")
        raise HTTPException(401, "invalid credentials")
    # Refuse to issue a token if the trial has already lapsed.  We use
    # the same {code, expired_at} shape as auth.current_user so the
    # frontend can render one consistent "联系管理员延期" message
    # regardless of whether expiry was caught at login or mid-session.
    if _is_expired(user):
        raise HTTPException(403, detail=_expired_detail(user))
    return TokenOut(access_token=create_token(user.id, user.role), user=UserOut.model_validate(user))
