/**
 * AI 朗读声音目录 — ElevenLabs 免费档可用的精选 6 个。
 * 用户在 Me 页选择，写到 localStorage，speakText() 读取后塞进 /api/tts。
 *
 * 默认 Matilda（US 女中音 educator）—— 和老的默认 Alice (UK 女中音 educator)
 * 角色对位但是美音，更贴合应用面向中文用户练 US English 的定位。
 */

export type Voice = {
  id: string;
  name: string;
  accent: "US" | "UK";
  gender: "F" | "M";
  blurb: string;
};

export const VOICES: Voice[] = [
  {
    id: "XrExE9yKIg1WjnnlVkGX",
    name: "Matilda",
    accent: "US",
    gender: "F",
    blurb: "知性女声 · 适合教学",
  },
  {
    id: "hpp4J3VqNfWAUOO0d1Us",
    name: "Bella",
    accent: "US",
    gender: "F",
    blurb: "温暖职业 · 听感舒服",
  },
  {
    id: "EXAVITQu4vr4xnSDxMaL",
    name: "Sarah",
    accent: "US",
    gender: "F",
    blurb: "年轻自信 · 节奏明快",
  },
  {
    id: "pNInz6obpgDQGcFmaJgB",
    name: "Adam",
    accent: "US",
    gender: "M",
    blurb: "沉稳男声 · 经典美音",
  },
  {
    id: "nPczCjzI2devNBz1zQrb",
    name: "Brian",
    accent: "US",
    gender: "M",
    blurb: "深沉浑厚 · 适合长听",
  },
  {
    id: "Xb7hH8MSUJpSbSDYk0k2",
    name: "Alice",
    accent: "UK",
    gender: "F",
    blurb: "英式发音 · 想练 BrE 用",
  },
];

export const DEFAULT_VOICE_ID = "XrExE9yKIg1WjnnlVkGX"; // Matilda

const KEY = "tts-voice-id";

export function getPreferredVoiceId(): string {
  try {
    const v = localStorage.getItem(KEY);
    if (v && VOICES.some((x) => x.id === v)) return v;
  } catch {
    /* private mode → fall through */
  }
  return DEFAULT_VOICE_ID;
}

export function setPreferredVoiceId(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* private mode → silently drop */
  }
}

export function getVoiceById(id: string): Voice | undefined {
  return VOICES.find((v) => v.id === id);
}

/**
 * 头像里显示的两字母简称（Ma / Be / Sa / Ad / Br / Al）。
 * 故意挑两个字母而不是一个，避免 Adam/Alice、Bella/Brian 撞首字母。
 * 未知 id 返回 "AI"，行为退化和老逻辑一致。
 */
export function getVoiceInitials(id: string): string {
  const v = getVoiceById(id);
  return v ? v.name.slice(0, 2) : "AI";
}

/** Sample line tuned to expose accent-distinctive phonemes (/r/, /θ/, /æ/). */
export const PREVIEW_TEXT =
  "Hi! Let's practice some English together. Don't worry about being perfect — just speak.";
