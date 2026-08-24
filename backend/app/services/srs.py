"""遗忘曲线 —— 全站唯一一套间隔规则。

刻意做成纯函数（不碰 DB、不碰时钟以外的东西），因为这是整个复习功能里
唯一"算错了要很多天以后才发现"的部分：排错一次间隔，你要到 30 天后才
察觉某个词再也没出现过。

三档自评而不是「记得/忘了」两档：真实的复习里"想起来一半"是最常见的
状态，把它并进任何一边都会让曲线失真 —— 并进"忘了"会让已经半熟的词
一直在低阶打转，并进"记得"会把它推到 30 天后再见。
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta

RESULTS = ("incorrect", "partial", "correct")

MAX_STAGE = 4

# 答对时的间隔阶梯，索引 = 答对**之前**的 stage。
# 错 1 天 / 半对 3 天 / 对 7 → 30 → 90 → 180 → 365。
#
# **没有"毕业"这一档**。间隔重复的全部意义就是"隔得越来越久但永远还会
# 再见"。之前 stage 3 标成 mastered 之后 /due 直接把它排除掉了，等于
# 答对三次就再也不出现 —— 那是一次性通关，不是复习。九十天不复习的东西
# 大概率已经忘了，正是最该考的时候。
_CORRECT_DAYS = {0: 7, 1: 30, 2: 90, 3: 180, 4: 365}
_INCORRECT_DAYS = 1
_PARTIAL_DAYS = 3


@dataclass(frozen=True)
class Schedule:
    stage: int
    correct_streak: int
    next_due: date
    status: str  # learning | reviewing | mastered


def next_schedule(
    result: str, stage: int, correct_streak: int, today: date,
) -> Schedule:
    """算出这次自评之后的下一档。

    `stage` 是本次作答**之前**的档位。答错直接回 0（而不是减一）：一个
    想不起来的词，无论之前爬到多高，都得从头再来 —— 这正是间隔重复相对
    于"背了就算会"的核心。
    """
    if result not in RESULTS:
        raise ValueError(f"unknown result: {result}")
    stage = max(0, min(int(stage), MAX_STAGE))

    if result == "incorrect":
        return Schedule(0, 0, today + timedelta(days=_INCORRECT_DAYS), "learning")

    if result == "partial":
        new_stage = max(stage - 1, 0)
        return Schedule(
            new_stage,
            0,
            today + timedelta(days=_PARTIAL_DAYS),
            "learning" if new_stage == 0 else "reviewing",
        )

    new_stage = min(stage + 1, MAX_STAGE)
    return Schedule(
        new_stage,
        correct_streak + 1,
        today + timedelta(days=_CORRECT_DAYS[stage]),
        # mastered 是一个**标签**，不是墓地：它照样有 next_due，到期照样
        # 进队列。区别只是间隔已经拉到一年。
        "mastered" if new_stage == MAX_STAGE else "reviewing",
    )
