"""Admin user management.

Only admins touch these routes.  Supports the solo-operator workflow:
Xiaohongshu order comes in → admin creates account with the username/password
the buyer provided → admin can later edit note / role / reset password /
trial expiry.

Self-signup is closed (see routers/auth.py), so this is the ONLY way to
provision non-admin accounts.
"""
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_admin, hash_password
from ..db import get_db
from ..models import AIConversation, Progress, User
from ..schemas import Page

router = APIRouter(prefix="/api/admin/users", tags=["admin-users"])


class AdminUserOut(BaseModel):
    id: int
    username: str
    email: str
    role: str
    admin_note: str
    created_at: datetime
    last_active: datetime | None
    # Trial / time-limited access.  None = permanent.
    expires_at: datetime | None = None

    class Config:
        from_attributes = True


class UserCreateIn(BaseModel):
    username: str
    password: str
    email: str | None = None  # optional — auto-derived if not provided
    role: str = "user"  # "user" | "admin"
    admin_note: str = ""
    # Optional trial expiry at creation.  None = permanent (default).
    expires_at: datetime | None = None


class UserPatchIn(BaseModel):
    password: str | None = None
    email: str | None = None
    role: str | None = None
    admin_note: str | None = None
    # Trial expiry.  None means no change; explicit null can't be sent
    # via PATCH alone — use POST /{id}/extend?days=0&permanent=true to
    # clear, or just send a far-future date.  See PATCH handler below
    # for how we differentiate "don't touch" from "set to permanent".
    expires_at: datetime | None = None
    # Sentinel: when true, set expires_at to NULL (permanent) regardless
    # of the expires_at field.  Lets PATCH clear the column even though
    # `None` already means "don't change" in the rest of this body.
    clear_expiry: bool = False


class UserExtendIn(BaseModel):
    days: int  # number of days to extend; sign matters (negatives shorten)


async def _last_active(db: AsyncSession, user_id: int) -> datetime | None:
    """Best-effort 'last active' — most recent of AI convo created or
    Progress updated.  None for brand-new accounts."""
    try:
        q = select(
            func.greatest(
                select(func.max(AIConversation.created_at))
                .where(AIConversation.user_id == user_id)
                .scalar_subquery(),
                select(func.max(Progress.updated_at))
                .where(Progress.user_id == user_id)
                .scalar_subquery(),
            )
        )
        return (await db.execute(q)).scalar()
    except Exception:
        return None


@router.get("", response_model=Page[AdminUserOut])
async def list_users(
    limit: int = 50,
    offset: int = 0,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    limit = max(1, min(limit, 200))
    total = int(await db.scalar(select(func.count(User.id))) or 0)
    rows = (await db.execute(
        select(User).order_by(User.created_at.desc()).limit(limit).offset(offset)
    )).scalars().all()
    out: list[AdminUserOut] = []
    for u in rows:
        out.append(AdminUserOut(
            id=u.id,
            username=u.username,
            email=u.email,
            role=u.role,
            admin_note=u.admin_note or "",
            created_at=u.created_at,
            last_active=await _last_active(db, u.id),
            expires_at=u.expires_at,
        ))
    return Page(items=out, total=total, has_more=offset + len(out) < total)


@router.post("", response_model=AdminUserOut)
async def create_user(
    body: UserCreateIn,
    _: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    username = (body.username or "").strip()
    password = (body.password or "").strip()
    if not username or not password:
        raise HTTPException(400, "username and password required")
    if len(password) < 4:
        raise HTTPException(400, "password too short (min 4 chars)")
    if body.role not in ("user", "admin"):
        raise HTTPException(400, "role must be 'user' or 'admin'")

    email = (body.email or f"{username}@justspeak.local").strip()
    dup = await db.scalar(
        select(User).where((User.username == username) | (User.email == email))
    )
    if dup:
        raise HTTPException(409, "username or email already taken")

    # Admins are exempt from expiry — silently force null even if the
    # caller passed expires_at.  Prevents accidentally locking an admin
    # out via the same form.
    expires_at = None if body.role == "admin" else body.expires_at
    user = User(
        username=username,
        email=email,
        password_hash=hash_password(password),
        role=body.role,
        admin_note=body.admin_note or "",
        expires_at=expires_at,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return AdminUserOut(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role,
        admin_note=user.admin_note or "",
        created_at=user.created_at,
        last_active=None,
        expires_at=user.expires_at,
    )


@router.patch("/{user_id}", response_model=AdminUserOut)
async def patch_user(
    user_id: int,
    body: UserPatchIn,
    admin: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "user not found")
    if body.password is not None:
        pw = body.password.strip()
        if len(pw) < 4:
            raise HTTPException(400, "password too short")
        user.password_hash = hash_password(pw)
    if body.email is not None:
        email = body.email.strip()
        if email and email != user.email:
            dup = await db.scalar(select(User).where(User.email == email, User.id != user_id))
            if dup:
                raise HTTPException(409, "email already taken")
            user.email = email
    if body.role is not None:
        if body.role not in ("user", "admin"):
            raise HTTPException(400, "role must be 'user' or 'admin'")
        # Safety: don't let an admin demote themselves (locks self out).
        if user.id == admin.id and body.role != "admin":
            raise HTTPException(400, "can't demote yourself")
        user.role = body.role
    if body.admin_note is not None:
        user.admin_note = body.admin_note
    # Trial expiry: clear_expiry takes precedence over expires_at so the
    # admin can flip "永久" without sending a fake date.  Admins can't
    # have an expiry — promotion to admin auto-clears it; demotion
    # leaves it whatever the caller set this round.
    if body.clear_expiry:
        user.expires_at = None
    elif body.expires_at is not None:
        user.expires_at = body.expires_at
    if user.role == "admin":
        user.expires_at = None
    await db.commit()
    await db.refresh(user)
    return AdminUserOut(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role,
        admin_note=user.admin_note or "",
        created_at=user.created_at,
        last_active=await _last_active(db, user.id),
        expires_at=user.expires_at,
    )


@router.post("/{user_id}/extend", response_model=AdminUserOut)
async def extend_user(
    user_id: int,
    body: UserExtendIn,
    admin: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Extend (or shorten) a user's trial expiry by N days.

    Anchor: max(now, current expires_at).  Reasoning:
    - If the trial has already lapsed, "+3 days" should give them 3 fresh
      days from today, not 3 days from the past expiry.
    - If still active, "+3 days" should add to the existing window so
      multiple extensions stack correctly.

    Negative days shorten — useful to revoke without flipping to permanent.
    Admins are no-op (their expires_at is always null).
    """
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "user not found")
    if user.role == "admin":
        # Admins don't expire — silently keep null.
        return AdminUserOut(
            id=user.id, username=user.username, email=user.email,
            role=user.role, admin_note=user.admin_note or "",
            created_at=user.created_at,
            last_active=await _last_active(db, user.id),
            expires_at=None,
        )
    now = datetime.now(timezone.utc)
    anchor = user.expires_at if user.expires_at and user.expires_at > now else now
    user.expires_at = anchor + timedelta(days=body.days)
    await db.commit()
    await db.refresh(user)
    return AdminUserOut(
        id=user.id,
        username=user.username,
        email=user.email,
        role=user.role,
        admin_note=user.admin_note or "",
        created_at=user.created_at,
        last_active=await _last_active(db, user.id),
        expires_at=user.expires_at,
    )


@router.delete("/{user_id}")
async def delete_user(
    user_id: int,
    admin: User = Depends(current_admin),
    db: AsyncSession = Depends(get_db),
):
    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(404, "user not found")
    if user.id == admin.id:
        raise HTTPException(400, "can't delete yourself")
    await db.delete(user)
    await db.commit()
    return {"ok": True}
