from sqlalchemy import JSON, ForeignKey, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class Chunk(Base):
    __tablename__ = "chunks"
    id: Mapped[int] = mapped_column(primary_key=True)
    episode_id: Mapped[int | None] = mapped_column(ForeignKey("episodes.id", ondelete="CASCADE"), index=True)
    text: Mapped[str] = mapped_column(String(255), index=True)
    chunk_type: Mapped[str] = mapped_column(String(32), default="collocation")
    # idiomatic / collocation / discourse / functional / cultural
    why_explanation: Mapped[str] = mapped_column(Text, default="")
    usage_scenario: Mapped[str] = mapped_column(Text, default="")
    similar_expressions: Mapped[list] = mapped_column(JSON, default=list)
    common_collocations: Mapped[list] = mapped_column(JSON, default=list)
    pronunciation_tip: Mapped[str] = mapped_column(Text, default="")
    difficulty: Mapped[int] = mapped_column(Integer, default=3)
    occurrences: Mapped[list] = mapped_column(JSON, default=list)
