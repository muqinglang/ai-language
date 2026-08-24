from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    # Empty string for accounts created through Google sign-in — they have
    # no password to verify.  routers/auth.login refuses to run the bcrypt
    # check against an empty hash, so such an account can only sign in
    # through Google (until it sets a password).
    password_hash: Mapped[str] = mapped_column(String(255))
    role: Mapped[str] = mapped_column(String(16), default="user")  # user | admin
    # How the account was created: "local" (password) | "google".  Only
    # affects messaging — the Google path stays usable for a local account
    # with a matching email, and vice versa once a password is set.
    auth_provider: Mapped[str] = mapped_column(
        String(16), default="local", server_default="local"
    )
    # Google's stable user id (the `sub` claim).  Recorded on first Google
    # sign-in for auditing and so a future email change on the Google side
    # can still be matched back to this account.  Empty for local accounts.
    google_sub: Mapped[str] = mapped_column(
        String(64), default="", server_default="", index=True
    )
    # Free-form admin note — used to record which Xiaohongshu
    # order / payment screenshot this user corresponds to, so the
    # admin can correlate accounts with sales.  Never shown to the
    # end user.
    admin_note: Mapped[str] = mapped_column(Text, default="", server_default="")
    # Trial / time-limited access.  NULL = permanent (no expiry).  When
    # set, auth.current_user refuses requests after this timestamp with
    # HTTP 403 {code: "trial_expired"}.  Admin role is always exempt
    # — admins never expire regardless of this column's value.  Stored
    # in UTC; rendered in the user's local TZ on the frontend.
    expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    # True when the learner explicitly opted out of the topic-anchor
    # onboarding ("先随便看 →"). Home then renders RecentView (continue-
    # learning + collection ToC) instead of the topic picker. Reversible
    # via PATCH /me/preferences from the RecentView header link.
    onboarding_dismissed: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default="false"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
