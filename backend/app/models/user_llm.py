from datetime import datetime

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class UserLLMConfig(Base):
    """A learner's own LLM provider + API key, used for their AI chat.

    One row per user (user_id is unique) — a learner picks one provider,
    not a chain.  When absent or unusable, the AI tab falls back to the
    server's own keys exactly as before, so this is purely additive.

    Scope is deliberately narrow: conversation-side calls only.  The
    import pipeline (transcript selection, translation, chunk extraction)
    keeps using the server keys — a single import would otherwise burn a
    large chunk of the learner's quota on work they didn't ask for.
    """

    __tablename__ = "user_llm_configs"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True, index=True
    )
    # openai | deepseek | anthropic | custom.  "custom" is any other
    # OpenAI-compatible endpoint, which is why base_url is free-form.
    provider: Mapped[str] = mapped_column(String(24), default="openai")
    # Fernet ciphertext — never the raw key.  See services/secrets.py.
    api_key_enc: Mapped[str] = mapped_column(Text, default="")
    # Empty → the provider's default endpoint.
    base_url: Mapped[str] = mapped_column(String(255), default="", server_default="")
    model: Mapped[str] = mapped_column(String(96), default="")
    # When the key last passed a real round trip to the provider.  We only
    # store a config that verified at save time, so this is really "when
    # we last proved it worked".
    verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    # Last failure seen while actually serving a chat with this key —
    # written by the chat path, shown in settings so a key that lapsed
    # after being saved doesn't just look mysteriously ignored.
    last_error: Mapped[str] = mapped_column(Text, default="", server_default="")

    # ---- TTS (CosyVoice via Alibaba Model Studio) ----
    # Same row, separate credential: the chat model and the voice are
    # bought from different vendors, and a learner may well configure one
    # without the other. Empty tts_api_key_enc = no TTS of their own, and
    # /api/tts falls through to the platform's ElevenLabs (if enabled) or
    # 503 → the browser's free Web Speech. See services/tts_providers.py.
    # cosyvoice | minimax。两个并列而不是替换：学员已经配好、验证过、
    # 正在用的凭据，不该因为我们加了个新选项就作废。
    tts_provider: Mapped[str] = mapped_column(
        String(16), default="cosyvoice", server_default="cosyvoice"
    )
    tts_api_key_enc: Mapped[str] = mapped_column(Text, default="", server_default="")
    # 部分 MiniMax 国内账号要求带 GroupId；CosyVoice 不用。
    tts_group_id: Mapped[str] = mapped_column(String(64), default="", server_default="")
    tts_voice: Mapped[str] = mapped_column(String(64), default="", server_default="")
    tts_model: Mapped[str] = mapped_column(String(64), default="", server_default="")
    tts_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True, default=None
    )
    tts_last_error: Mapped[str] = mapped_column(Text, default="", server_default="")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )
