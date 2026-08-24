"""对话复习 —— 你和 ChatGPT 聊完整理出来的知识点，按遗忘曲线复现。

和生词本的区别（两者都保留，别合并）：
  生词本   看视频时点出来的**单词**，素材是别人的内容
  这里     和 AI 聊天聊出来的**表达**，素材是你自己的产出，
           形状是「中文提示 → 英文答案 + 使用场景」

同一条曲线、同一个"今日复习"入口，但各存各的表：字段形状差得远，
硬塞一张表要么一半字段常年为空，要么迁移时把现有生词搞坏。
"""
from datetime import date, datetime

from sqlalchemy import (
    JSON, Date, DateTime, ForeignKey, Index, Integer, SmallInteger, String, Text, func,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..db import Base


class ReviewItem(Base):
    """一个待复习的知识点。"""

    __tablename__ = "review_items"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    # 去重键：同一个用户重复导入同一个知识点时更新而不是新建。
    # 由导入方给（ChatGPT 输出里的 normalizedKey），缺了就用 cue 兜底。
    normalized_key: Mapped[str] = mapped_column(String(200))
    # vocabulary | expression | error | pronunciation —— 沿用 english-review
    # 的分类，这样你和 ChatGPT 的现有约定不用改。
    item_type: Mapped[str] = mapped_column(String(24), default="expression")
    cue: Mapped[str] = mapped_column(Text)          # 中文提示（题面）
    answer: Mapped[str] = mapped_column(Text)       # 英文答案
    # 纯文本例句。ChatGPT 有时给字符串，有时给一整个结构 —— 后者进 detail。
    example: Mapped[str] = mapped_column(Text, default="", server_default="")
    # 结构化的讲解：{meaning, explanation, usageTip, examples:[{scenario,
    # english, chinese}]}。字段不固定，所以整块存 JSON 由前端按形状渲染 ——
    # 拆成列的话，ChatGPT 哪天多给一个字段就得改表。
    detail: Mapped[dict] = mapped_column(JSON, default=dict)
    priority: Mapped[str] = mapped_column(String(8), default="medium")
    occurrences: Mapped[int] = mapped_column(Integer, default=1)

    # 这批是哪天、哪个空间导进来的 —— 首页「最近一次对话复习」按它分组。
    space: Mapped[str] = mapped_column(String(80), default="", server_default="")
    practice_date: Mapped[date | None] = mapped_column(Date, nullable=True)

    # ---- 曲线状态 ----
    # stage 0..3，3 = 已掌握。间隔见 services/srs.py。
    stage: Mapped[int] = mapped_column(SmallInteger, default=0)
    correct_streak: Mapped[int] = mapped_column(Integer, default=0)
    attempts: Mapped[int] = mapped_column(Integer, default=0)
    correct: Mapped[int] = mapped_column(Integer, default=0)
    last_result: Mapped[str] = mapped_column(String(12), default="", server_default="")
    # learning | reviewing | mastered
    status: Mapped[str] = mapped_column(String(16), default="learning")
    # 到期日。导入当天不考，次日首次到期 —— 当天刚学完就考等于考短期记忆。
    next_due: Mapped[date] = mapped_column(Date, index=True)
    last_answered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_review_items_user_key", "user_id", "normalized_key", unique=True),
        Index("ix_review_items_user_due", "user_id", "next_due"),
    )


class ReviewAttempt(Base):
    """每次自评的流水。

    存下来不只是为了历史页：曲线是从 stage 推的，只留最终状态的话，一次
    误点就再也查不出当初发生了什么。
    """

    __tablename__ = "review_attempts"

    id: Mapped[int] = mapped_column(primary_key=True)
    user_id: Mapped[int] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    item_id: Mapped[int] = mapped_column(
        ForeignKey("review_items.id", ondelete="CASCADE"), index=True
    )
    # incorrect | partial | correct
    result: Mapped[str] = mapped_column(String(12))
    stage_before: Mapped[int] = mapped_column(SmallInteger, default=0)
    stage_after: Mapped[int] = mapped_column(SmallInteger, default=0)
    next_due: Mapped[date | None] = mapped_column(Date, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), index=True
    )
