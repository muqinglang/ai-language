// Topic + category visual metadata — color dots replace emoji so rendering is
// stable across platforms. Keep slugs in sync with backend services/topics.py.

export type TopicVisual = { name: string; color: string };
export type CategoryVisual = { name: string; lucide: string };

export const TOPIC_META: Record<string, TopicVisual> = {
  ai: { name: "AI", color: "#8b5cf6" },
  tech: { name: "科技编程", color: "#0ea5e9" },
  business: { name: "商业创业", color: "#f59e0b" },
  investing: { name: "投资理财", color: "#10b981" },
  career: { name: "职场成长", color: "#ec4899" },
  lifestyle: { name: "日常生活", color: "#64748b" },
  travel: { name: "旅行文化", color: "#06b6d4" },
  food: { name: "美食烹饪", color: "#ef4444" },
  health: { name: "健康健身", color: "#84cc16" },
  psychology: { name: "心理成长", color: "#a855f7" },
  science: { name: "科学科普", color: "#14b8a6" },
  education: { name: "教育学习", color: "#6366f1" },
  entertainment: { name: "影视娱乐", color: "#d946ef" },
  fashion: { name: "时尚美妆", color: "#f472b6" },
  sports: { name: "体育运动", color: "#22c55e" },
  outdoor: { name: "户外探险", color: "#059669" },
  reading: { name: "阅读书评", color: "#eab308" },
  other: { name: "其他", color: "#94a3b8" },
};

// Category = video format. Map to Lucide icon names.
export const CATEGORY_META: Record<string, CategoryVisual> = {
  talk: { name: "主题演讲", lucide: "mic-2" },
  interview: { name: "访谈对谈", lucide: "messages-square" },
  vlog: { name: "生活 Vlog", lucide: "home" },
  tutorial: { name: "教程教学", lucide: "wrench" },
  creator: { name: "知识博主", lucide: "clapperboard" },
  news: { name: "新闻报道", lucide: "newspaper" },
  documentary: { name: "纪录片", lucide: "film" },
  review: { name: "评测影评", lucide: "star" },
  comedy: { name: "喜剧脱口秀", lucide: "laugh" },
  other: { name: "其他", lucide: "circle" },
};

export function topicColor(slug: string): string {
  return TOPIC_META[slug]?.color ?? TOPIC_META.other.color;
}

export function topicName(slug: string): string {
  return TOPIC_META[slug]?.name ?? slug;
}
