"""Single source of truth for the two orthogonal episode taxonomies.

CATEGORY = the video FORMAT (TED talk vs. interview vs. vlog vs. ...).
TOPIC    = the SUBJECT (AI, investing, travel, ...).

A learner uses TOPIC for narrow-listening study (one subject at a time so
vocabulary repeats).  CATEGORY filters by listening style.
"""

CATEGORIES: list[dict] = [
    {"slug": "talk",         "name": "主题演讲",            "icon": "🎤", "sort": 1},
    {"slug": "interview",    "name": "访谈对谈",            "icon": "🎙", "sort": 2},
    {"slug": "vlog",         "name": "生活 Vlog",           "icon": "🏡", "sort": 3},
    {"slug": "tutorial",     "name": "教程教学",            "icon": "🛠", "sort": 4},
    {"slug": "creator",      "name": "知识博主",            "icon": "🎬", "sort": 5},
    {"slug": "news",         "name": "新闻报道",            "icon": "📰", "sort": 6},
    {"slug": "documentary",  "name": "纪录片",              "icon": "🎞", "sort": 7},
    {"slug": "review",       "name": "评测影评",            "icon": "⭐", "sort": 8},
    {"slug": "comedy",       "name": "喜剧脱口秀",          "icon": "😂", "sort": 9},
    {"slug": "other",        "name": "其他",                "icon": "🌀", "sort": 99},
]

TOPICS: list[dict] = [
    {"slug": "ai",            "name": "AI 与大模型",         "icon": "🤖"},
    {"slug": "tech",          "name": "科技编程",            "icon": "💻"},
    {"slug": "business",      "name": "商业创业",            "icon": "💼"},
    {"slug": "investing",     "name": "投资理财",            "icon": "📈"},
    {"slug": "career",        "name": "职场成长",            "icon": "🚀"},
    {"slug": "lifestyle",     "name": "日常生活",            "icon": "☕"},
    {"slug": "travel",        "name": "旅行文化",            "icon": "✈"},
    {"slug": "food",          "name": "美食烹饪",            "icon": "🍜"},
    {"slug": "health",        "name": "健康健身",            "icon": "💪"},
    {"slug": "psychology",    "name": "心理成长",            "icon": "🧠"},
    {"slug": "science",       "name": "科学科普",            "icon": "🔬"},
    {"slug": "education",     "name": "教育学习",            "icon": "📚"},
    {"slug": "entertainment", "name": "影视娱乐",            "icon": "🎭"},
    {"slug": "fashion",       "name": "时尚美妆",            "icon": "👗"},
    {"slug": "sports",        "name": "体育运动",            "icon": "⚽"},
    {"slug": "outdoor",       "name": "户外探险",            "icon": "🏕"},
    {"slug": "reading",       "name": "阅读书评",            "icon": "📖"},
    {"slug": "other",         "name": "其他",                "icon": "🌐"},
]

CATEGORY_SLUGS: set[str] = {c["slug"] for c in CATEGORIES}
TOPIC_SLUGS: set[str] = {t["slug"] for t in TOPICS}


def topic_dict() -> dict[str, dict]:
    return {t["slug"]: t for t in TOPICS}


def category_dict() -> dict[str, dict]:
    return {c["slug"]: c for c in CATEGORIES}
