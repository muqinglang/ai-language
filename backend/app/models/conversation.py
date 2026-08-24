from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class AIConversation(Base):
    __tablename__ = "ai_conversations"
    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    episode_id: Mapped[int] = mapped_column(ForeignKey("episodes.id", ondelete="CASCADE"), index=True)
    scenario: Mapped[str] = mapped_column(Text, default="")
    target_chunks: Mapped[list] = mapped_column(JSON, default=list)  # chunk ids
    messages: Mapped[list] = mapped_column(JSON, default=list)  # [{role,content,ts}]
    chunks_used: Mapped[list] = mapped_column(JSON, default=list)
    summary: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(16), default="active")  # active | finished
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
