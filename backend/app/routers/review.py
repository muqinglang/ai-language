"""对话复习 —— /api/review

来源是你和 ChatGPT 聊完之后，让它整理出来的一段 JSON。粘贴进来即可复习，
不需要浏览器扩展、不需要 token、不需要本机 Worker 常驻。

粘贴格式沿用 english-review 的 `english-review-sync`：

    {"space": "English Review", "practiceDate": "2026-08-21",
     "items": [{"normalizedKey": "...", "type": "expression",
                "cue": "中文提示", "answer": "英文答案",
                "example": "使用场景", "priority": "medium",
                "occurrences": 1}]}

刻意不改这个格式：你和 ChatGPT 之间已经磨合好的产出约定，值钱的是那份
约定本身，不是它的字段名。
"""
from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..auth import current_user
from ..db import get_db
from ..models import ReviewAttempt, ReviewItem, User, Vocabulary
from ..services import llm
from ..services.srs import RESULTS, next_schedule
from .user_llm import note_byok_error, require_override

router = APIRouter(prefix="/api/review", tags=["review"])

# 学习和复习都按这个时区切天。用户在中国，用 UTC 切天会让"今天该复习的"
# 在每天早上 8 点才刷新。
_TZ = timezone(timedelta(hours=8))


def _today() -> date:
    return datetime.now(_TZ).date()


# ---------------------------------------------------------------- 导入

class ImportIn(BaseModel):
    # 整段粘贴的原文。可以是纯 JSON，也可以是 ChatGPT 用 ```english-review-sync
    # 包起来的代码块 —— 让用户先手动扒掉围栏是没必要的摩擦。
    raw: str


class ImportOut(BaseModel):
    imported: int
    updated: int
    space: str
    practice_date: str


_FENCE = re.compile(r"```[a-zA-Z-]*\s*(.+?)```", re.S)


def _extract_json(raw: str) -> dict:
    raw = (raw or "").strip()
    if not raw:
        raise HTTPException(400, "Nothing to import.")
    m = _FENCE.search(raw)
    if m:
        raw = m.group(1).strip()
    else:
        # 没有围栏时，从第一个 { 到最后一个 } —— ChatGPT 常在 JSON 前后
        # 附一句说明。
        i, j = raw.find("{"), raw.rfind("}")
        if i >= 0 and j > i:
            raw = raw[i:j + 1]
    try:
        data = json.loads(raw)
    except Exception as e:
        raise HTTPException(400, f"Could not parse that JSON: {e}")
    if not isinstance(data, dict):
        raise HTTPException(400, "Expected a JSON object at the top level.")
    return data


def _norm_key(item: dict) -> str:
    key = str(item.get("normalizedKey") or item.get("normalized_key") or "").strip()
    if key:
        return key[:200]
    # 缺 normalizedKey 时用 cue 兜底，而不是拒收：ChatGPT 偶尔漏字段，
    # 为此丢掉整批内容不值得。
    return str(item.get("cue") or "").strip()[:200]


@router.post("/import", response_model=ImportOut)
async def import_items(
    body: ImportIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    data = _extract_json(body.raw)
    items = data.get("items")
    if not isinstance(items, list) or not items:
        raise HTTPException(400, "items is empty.")

    space = str(data.get("space") or "").strip()[:80]
    pd_raw = str(data.get("practiceDate") or data.get("practice_date") or "").strip()
    try:
        practice_date = date.fromisoformat(pd_raw) if pd_raw else _today()
    except ValueError:
        raise HTTPException(400, f"practiceDate is not a valid date: {pd_raw}")

    # 首次到期 = 练习日的**次日**。刚聊完就考等于考短期记忆，那不是这套
    # 曲线要测的东西。
    #
    # 注意是 practice_date + 1 而不是 max(practice_date, today) + 1：补录
    # 前几天的内容时，它本来就该立刻到期（甚至已经逾期），而不是再等一天。
    first_due = practice_date + timedelta(days=1)

    existing = {
        r.normalized_key: r
        for r in (await db.execute(
            select(ReviewItem).where(ReviewItem.user_id == user.id)
        )).scalars().all()
    }

    imported = updated = 0
    for raw_item in items:
        if not isinstance(raw_item, dict):
            continue
        key = _norm_key(raw_item)
        cue = str(raw_item.get("cue") or "").strip()
        answer = str(raw_item.get("answer") or "").strip()
        if not key or not cue or not answer:
            continue  # 三个必填字段缺一就跳过这条，不拖垮整批

        # example 可能是一句话，也可能是一整块讲解（meaning / explanation /
        # usageTip / examples[]）。后者不能 str() —— 那会把 Python 的 repr
        # 直接怼到页面上（实测过，出来一屏 {'meaning': '...', ...}）。
        raw_example = raw_item.get("example")
        if isinstance(raw_example, (dict, list)):
            example_text, detail = "", raw_example
        else:
            example_text, detail = str(raw_example or "")[:4000], {}

        fields = dict(
            item_type=str(raw_item.get("type") or "expression")[:24],
            cue=cue,
            answer=answer,
            example=example_text,
            detail=detail,
            priority=str(raw_item.get("priority") or "medium")[:8],
            space=space,
            practice_date=practice_date,
        )
        row = existing.get(key)
        if row is not None:
            # 重复导入同一个知识点：更新内容和出现次数，但**不碰曲线状态** ——
            # 你已经复习到 stage 2 的词，不该因为又聊到一次就退回从头。
            for k, v in fields.items():
                setattr(row, k, v)
            row.occurrences = (row.occurrences or 1) + 1
            updated += 1
            continue
        db.add(ReviewItem(
            user_id=user.id,
            normalized_key=key,
            occurrences=int(raw_item.get("occurrences") or 1),
            next_due=first_due,
            **fields,
        ))
        imported += 1

    if not imported and not updated:
        raise HTTPException(400, "No usable items — each one needs at least a cue and an answer.")
    await db.commit()
    return ImportOut(
        imported=imported, updated=updated,
        space=space, practice_date=practice_date.isoformat(),
    )


# ---------------------------------------------------------------- 队列

class DueItem(BaseModel):
    # 两种素材共用一个队列，靠 kind 区分渲染方式。
    kind: str            # expression | vocab
    id: int
    cue: str
    answer: str
    example: str = ""
    # 结构化讲解，形状由 ChatGPT 决定，前端按 shape 渲染。
    detail: dict | list = {}
    item_type: str = ""
    stage: int = 0
    status: str = ""
    next_due: str = ""
    overdue_days: int = 0


class DueOut(BaseModel):
    today: str
    total: int
    items: list[DueItem]
    # 最近一次导入的那批，整批返回、不管到不到期。
    #
    # 必须有这块：导入当天的内容次日才首次到期，所以刚粘完的东西不会出现
    # 在上面的队列里 —— 没有这一节的话，用户看到"导入成功 4 条"然后什么
    # 都没有，等于内容凭空消失。
    latest_space: str = ""
    latest_practice_date: str = ""
    latest_count: int = 0
    latest_items: list[DueItem] = []


def _to_due(r: ReviewItem, today: date) -> DueItem:
    return DueItem(
        kind="expression", id=r.id, cue=r.cue, answer=r.answer,
        example=r.example or "", detail=r.detail or {},
        item_type=r.item_type, stage=r.stage, status=r.status,
        next_due=r.next_due.isoformat() if r.next_due else "",
        overdue_days=max(0, (today - r.next_due).days) if r.next_due else 0,
    )


@router.get("/due", response_model=DueOut)
async def due(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = 60,
):
    """今天该复习的一切 —— 导入的知识点 + 生词本到期的词，一个队列。

    合并发生在这里而不是存储层：两种素材的字段形状差得远，但"今天要复习
    什么"对学习者来说就是一件事，不该逼他去两个页面各刷一遍。
    """
    today = _today()

    rows = (await db.execute(
        select(ReviewItem)
        # 不排除 mastered。它是标签不是墓地 —— 间隔已经拉到半年一年，
        # 但到期照样要考。九十天没复习的东西大概率已经忘了。
        .where(ReviewItem.user_id == user.id, ReviewItem.next_due <= today)
        .order_by(ReviewItem.next_due.asc(), ReviewItem.id.asc())
        .limit(limit)
    )).scalars().all()

    items = [_to_due(r, today) for r in rows]

    # 生词本：沿用它自己的 next_review_at / mastery，不改那张表。
    remaining = max(0, limit - len(items))
    if remaining:
        vocab = (await db.execute(
            select(Vocabulary)
            .where(
                Vocabulary.user_id == user.id,
                Vocabulary.mastery < 3,
                (Vocabulary.next_review_at.is_(None))
                | (Vocabulary.next_review_at <= datetime.now(timezone.utc)),
            )
            .order_by(Vocabulary.next_review_at.asc().nulls_first())
            .limit(remaining)
        )).scalars().all()
        items.extend(
            DueItem(
                kind="vocab", id=v.id, cue=v.word,
                answer=v.definition_zh or v.definition_en or "",
                example=v.example or "", item_type="vocabulary",
                stage=v.mastery or 0, status="",
                next_due=v.next_review_at.date().isoformat() if v.next_review_at else "",
            )
            for v in vocab
        )

    latest_date = (await db.execute(
        select(func.max(ReviewItem.practice_date))
        .where(ReviewItem.user_id == user.id)
    )).scalar()

    latest_rows = []
    if latest_date is not None:
        latest_rows = (await db.execute(
            select(ReviewItem)
            .where(
                ReviewItem.user_id == user.id,
                ReviewItem.practice_date == latest_date,
            )
            .order_by(ReviewItem.id.asc())
        )).scalars().all()

    return DueOut(
        today=today.isoformat(),
        total=len(items),
        items=items,
        latest_space=(latest_rows[0].space if latest_rows else "") or "",
        latest_practice_date=(latest_date.isoformat() if latest_date else ""),
        latest_count=len(latest_rows),
        latest_items=[_to_due(r, today) for r in latest_rows],
    )


# ---------------------------------------------------------------- 自评

class GradeIn(BaseModel):
    result: str  # incorrect | partial | correct


class GradeOut(BaseModel):
    stage: int
    status: str
    next_due: str


@router.post("/items/{item_id}/grade", response_model=GradeOut)
async def grade(
    item_id: int,
    body: GradeIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    if body.result not in RESULTS:
        raise HTTPException(400, f"result must be one of {'/'.join(RESULTS)}")
    row = await db.get(ReviewItem, item_id)
    if not row or row.user_id != user.id:
        raise HTTPException(404, "not found")

    today = _today()
    sched = next_schedule(body.result, row.stage or 0, row.correct_streak or 0, today)

    db.add(ReviewAttempt(
        user_id=user.id, item_id=row.id, result=body.result,
        stage_before=row.stage or 0, stage_after=sched.stage,
        next_due=sched.next_due,
    ))
    row.stage = sched.stage
    row.correct_streak = sched.correct_streak
    row.status = sched.status
    row.next_due = sched.next_due
    row.attempts = (row.attempts or 0) + 1
    if body.result == "correct":
        row.correct = (row.correct or 0) + 1
    row.last_result = body.result
    row.last_answered_at = datetime.now(timezone.utc)
    await db.commit()
    return GradeOut(
        stage=sched.stage, status=sched.status, next_due=sched.next_due.isoformat(),
    )


# ---------------------------------------------------------------- 历史

class HistoryRow(BaseModel):
    id: int
    cue: str
    answer: str
    example: str = ""
    detail: dict | list = {}
    item_type: str
    stage: int
    status: str
    attempts: int
    correct: int
    last_result: str = ""
    next_due: str = ""
    practice_date: str = ""


@router.get("/history", response_model=list[HistoryRow])
async def history(
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
    limit: int = 200,
):
    rows = (await db.execute(
        select(ReviewItem)
        .where(ReviewItem.user_id == user.id)
        .order_by(ReviewItem.next_due.asc(), ReviewItem.id.asc())
        .limit(limit)
    )).scalars().all()
    return [
        HistoryRow(
            id=r.id, cue=r.cue, answer=r.answer,
            example=r.example or "", detail=r.detail or {},
            item_type=r.item_type,
            stage=r.stage or 0, status=r.status or "",
            attempts=r.attempts or 0, correct=r.correct or 0,
            last_result=r.last_result or "",
            next_due=r.next_due.isoformat() if r.next_due else "",
            practice_date=r.practice_date.isoformat() if r.practice_date else "",
        )
        for r in rows
    ]


async def _todays_material(db: AsyncSession, user_id: int) -> list[ReviewItem]:
    """今天该练听力的素材。

    不能只取"今天到期"的：刚导入的内容次日才首次到期，打过分的又被推到
    未来 —— 两头一夹，今天刚学完的东西反而永远编不成故事。所以按这个
    顺序找第一个非空的：

      1. 今天到期的（正经的复习材料）
      2. 最近导入的那一批（刚学完，正该趁热听）
      3. 最近碰过的任意条目（兜底，总比"没有素材"强）
    """
    today = _today()
    due = (await db.execute(
        select(ReviewItem)
        .where(ReviewItem.user_id == user_id, ReviewItem.next_due <= today)
        .order_by(ReviewItem.next_due.asc()).limit(12)
    )).scalars().all()
    if due:
        return list(due)

    latest_date = (await db.execute(
        select(func.max(ReviewItem.practice_date)).where(ReviewItem.user_id == user_id)
    )).scalar()
    if latest_date is not None:
        batch = (await db.execute(
            select(ReviewItem)
            .where(
                ReviewItem.user_id == user_id,
                ReviewItem.practice_date == latest_date,
            ).limit(12)
        )).scalars().all()
        if batch:
            return list(batch)

    return list((await db.execute(
        select(ReviewItem).where(ReviewItem.user_id == user_id)
        .order_by(ReviewItem.id.desc()).limit(12)
    )).scalars().all())


# ---------------------------------------------------------------- 听力

_STORY_SYS = """You write a short, natural listening-practice story for a Chinese learner of English.

The target expressions below come from today's review and may be about COMPLETELY
UNRELATED things. Do NOT force them into a single event — that produces a jarring,
nonsensical story. Instead write it as ONE person casually recounting their day or
week (a diary / voice-note feel), so different topics can show up as different
moments or passing thoughts.

Rules:
- 110-160 words. One or two short paragraphs.
- Use EVERY target expression, the way a native actually would.
- Coherence and natural flow come FIRST. Link the moments with real spoken
  transitions ("Oh, and earlier…", "By the way…", "Anyway…") — never a mechanical
  list of unrelated sentences, and never a forced cause-and-effect between things
  that aren't related.
- If two expressions don't belong to the same moment, just move on to the next
  moment naturally; the narrator's day is the thread that holds it together.
- Keep the words AROUND the targets simple, so the target is what the listener has
  to catch — not the words around it.
- No title, no translation, no explanation. Output the story text only."""


class StoryIn(BaseModel):
    # 不传就用今天到期的知识点。
    item_ids: list[int] = []


class StoryOut(BaseModel):
    story: str
    expressions: list[str]


@router.post("/listening/story", response_model=StoryOut)
async def listening_story(
    body: StoryIn,
    user: User = Depends(current_user),
    db: AsyncSession = Depends(get_db),
):
    """把今天要复习的表达织进一个小故事，用来练听力。

    这是学员点出来的模型调用 —— 走学员自己的 key（见 docs/BYOK.md）。
    朗读那一步不在这里：前端拿到文本后走 /api/tts，那条路已经用的是学员
    配好的 CosyVoice。
    """
    if body.item_ids:
        rows = (await db.execute(
            select(ReviewItem).where(
                ReviewItem.user_id == user.id,
                ReviewItem.id.in_(body.item_ids[:12]),
            ).limit(12)
        )).scalars().all()
    else:
        rows = await _todays_material(db, user.id)
    targets = [r.answer.strip() for r in rows if r.answer.strip()][:5]
    if not targets:
        raise HTTPException(400, "No expressions yet — import a batch first.")

    override = await require_override(db, user)
    user_msg = "Target expressions:\n" + "\n".join(f"- {t}" for t in targets)
    try:
        story = await _story_call(_STORY_SYS, user_msg, override)
    except llm.BYOKCallFailed as e:
        await note_byok_error(db, user.id, str(e))
        raise HTTPException(502, str(e)) from e
    if not story:
        why = llm.last_provider_error()
        raise HTTPException(502, f"Could not generate: {why}" if why else "Could not generate. Try again.")
    return StoryOut(story=story.strip(), expressions=targets)


async def _story_call(system: str, user_msg: str, override):
    """写故事这一步为什么要 no_think。

    deepseek-v4-pro 是推理模型，思考 token 和答案共用 max_tokens。「把 5 个
    指定表达自然地织进 100 词」是个约束满足题，它能思考很久 —— 实测把
    2224 的预算（600 经 _reasoning_budget 放宽后）全花在思考上，content
    返回空字符串。前端看到的就是"模型返回了空内容"。

    这跟 pick_sentence_pattern（Rephrase）踩的是同一颗雷，那边已经用
    no_think 解决了，这里当初漏了。放宽预算不是可靠的解法 —— 之前实测过
    1624 空、4000 还是空，思考能填满你给的任何数字；关掉思考才是。
    一段 100 词的听力小故事本来也不需要链式推理。

    改成关键字传参：原来是 7 个位置参数，`True, "reply"` 各是什么全靠数
    位置，往中间加一个参数就会静默错位。
    """
    import asyncio
    return await asyncio.to_thread(
        lambda: llm._chat(
            system, user_msg,
            max_tokens=900, timeout=90,
            task="reply", override=override,
            no_think=llm._WHOLE_TRANSCRIPT_NO_THINK,
        )
    )
