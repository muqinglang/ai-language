const BASE = "/api";

export type TokenPayload = {
  access_token: string;
  token_type: string;
  user: {
    id: number;
    username: string;
    email: string;
    role: string;
    /** Trial expiry, ISO 8601. null = permanent. */
    expires_at?: string | null;
    /** Learner opted out of the topic-anchor onboarding —
     * Home then renders RecentView. Reversible via PATCH /me/preferences. */
    onboarding_dismissed?: boolean;
  };
};

/** register() returns a usable token when no verification is required, or a
 *  {needs_verification, email} marker when a 6-digit email code must be
 *  confirmed first (AUTH_REQUIRE_EMAIL_VERIFICATION on). */
export type RegisterResult =
  | ({ needs_verification: false } & TokenPayload)
  | { needs_verification: true; email: string };

function getToken(): string | null {
  return localStorage.getItem("justspeak_token");
}

export function setSession(p: TokenPayload) {
  localStorage.setItem("justspeak_token", p.access_token);
  localStorage.setItem("justspeak_user", JSON.stringify(p.user));
}

export function clearSession() {
  localStorage.removeItem("justspeak_token");
  localStorage.removeItem("justspeak_user");
}

export function currentUser(): TokenPayload["user"] | null {
  const raw = localStorage.getItem("justspeak_user");
  return raw ? JSON.parse(raw) : null;
}

/** Patch the cached user payload in localStorage. Used after PATCH
 * /me/preferences so the Home routing (which reads currentUser()) flips
 * without waiting for a re-login. */
export function patchCurrentUser(patch: Partial<TokenPayload["user"]>) {
  const cur = currentUser();
  if (!cur) return;
  localStorage.setItem("justspeak_user", JSON.stringify({ ...cur, ...patch }));
}

/** Thrown when the backend says the user's trial has lapsed.  Distinct
 * type so callers can differentiate from generic API failures and
 * trigger a force-logout + redirect to /login?expired=1. */
export class TrialExpiredError extends Error {
  expiredAt: string;
  constructor(expiredAt: string, msg = "trial expired") {
    super(msg);
    this.name = "TrialExpiredError";
    this.expiredAt = expiredAt;
  }
}

/** 428 — 这个功能要用学员自己的 API key，而 TA 还没配（或配的已失效）。
 *
 * 单独立一个类型是因为它不是"出错了"，是"少了一步设置"：调用方要渲染的
 * 是一个指向 /me#api-key 的入口，不是一个红色报错框。 */
export class ByokRequiredError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "ByokRequiredError";
  }
}

export function isByokRequired(e: unknown): e is ByokRequiredError {
  return e instanceof ByokRequiredError;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(BASE + path, { ...init, headers });
  if (!res.ok) {
    const text = await res.text();
    // 401 = token expired / invalid. Clear the stale client session and
    // bounce to /login. Without this every page reads `user` from
    // localStorage as still-valid (Shell shows the username, the bottom
    // tab bar renders) but every API call silently 401s — landing the
    // user on an empty Onboarding / blank Library with no clue why.
    // Media files at /media/... are static and don't need auth, which
    // is why videos kept playing despite the token being dead.
    // Skip on /auth/login itself (it's how the user enters credentials;
    // a 401 there is "wrong password", not "session expired").
    if (res.status === 401 && !path.startsWith("/auth/login")) {
      clearSession();
      window.location.replace("/login?expired=1");
      // Throw so React Query doesn't try to render with stale data
      // before the navigation kicks in.
      throw new Error("401 session expired");
    }
    // 403 with FastAPI's structured detail = trial_expired.  Bubble it
    // up as a typed error so a top-level boundary can clear the session
    // and bounce to /login?expired=1 without each caller handling it.
    if (res.status === 403) {
      try {
        const parsed = JSON.parse(text);
        const detail = parsed?.detail;
        if (detail && typeof detail === "object" && detail.code === "trial_expired") {
          // Skip the auto-logout for the login route itself — caller
          // wants to read expired_at and show the error inline.
          if (!path.startsWith("/auth/login")) {
            clearSession();
            // Use replace so the back button doesn't return to a 403.
            window.location.replace(`/login?expired=1&at=${encodeURIComponent(detail.expired_at)}`);
          }
          throw new TrialExpiredError(detail.expired_at, detail.message ?? "trial expired");
        }
      } catch (e) {
        if (e instanceof TrialExpiredError) throw e;
        // fallthrough to generic error
      }
    }
    // 428 = 还没配自己的 API key。和 trial_expired 一样做成有类型的错误，
    // 免得每个调用方各自去 JSON.parse 那个 detail。
    if (res.status === 428) {
      try {
        const detail = JSON.parse(text)?.detail;
        if (detail?.code === "byok_required") {
          throw new ByokRequiredError(detail.message ?? "需要先配置 API key");
        }
      } catch (e) {
        if (e instanceof ByokRequiredError) throw e;
        /* not JSON — fall through */
      }
    }
    throw new Error(`${res.status} ${text}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/** Pull the human-readable reason out of an error thrown by request().
 *
 * request() throws `Error("400 {\"detail\":\"key 无效或已撤销\"}")`.  The
 * BYOK settings page shows the backend's Chinese explanation verbatim
 * (it is the only thing that says *why* a key was rejected), so it needs
 * the detail rather than the raw status+body string. */
export function errorDetail(e: unknown, fallback = "操作失败，请重试"): string {
  const msg = e instanceof Error ? e.message : String(e ?? "");
  const body = msg.replace(/^\d{3}\s*/, "");
  try {
    const parsed = JSON.parse(body);
    const detail = parsed?.detail;
    if (typeof detail === "string" && detail) return detail;
    if (detail && typeof detail === "object" && typeof detail.message === "string") {
      return detail.message;
    }
  } catch {
    /* not JSON — fall through */
  }
  return body.trim() || fallback;
}

// ============ Types ============
export type Category = { id: number; name: string; slug: string; icon: string };
export type Topic = { slug: string; name: string; icon: string };
// Standard paginated list envelope (matches backend schemas.Page).
export type Paged<T> = { items: T[]; total: number; has_more: boolean };

// One Discover grid card: a standalone episode OR a folded collection
// of same-source segments. Backend paginates by this unit.
export type DiscoverItem = {
  kind: "episode" | "collection";
  episode: EpisodeCard | null;
  youtube_id: string;
  title: string;
  thumbnail_url: string;
  topic: string;
  segment_count: number;
  total_duration_sec: number;
  creator: string;
};
// "锚" (anchor) is a TOPIC the learner commits to for ~2 weeks
// (narrow listening). The path is derived live from published episodes
// sharing that topic — creator may vary, that's intentional.
export type TopicCard = {
  slug: string; name: string; icon: string; episode_count: number;
};
export type AnchorPathItem = {
  episode_id: number; title: string;
  thumbnail_url: string; duration_sec: number; difficulty: number;
  creator: string; done: boolean; locked: boolean; current: boolean;
};
export type MyAnchor = {
  topic: TopicCard; day: number;
  done_count: number; total: number; path: AnchorPathItem[];
  page: number; page_size: number; current_page: number;
};
export type Speaker = { id: number; handle: string; name: string; default_accent: string };

export type CreatorRow = {
  id: number;
  name: string;
  handle: string;
  avatar: string;
  youtube_url: string;
  description: string;
  default_accent: string;
  episode_count: number;
  top_topic: string | null;
};

export type CreatorDetail = CreatorRow & {
  total_duration_sec: number;
  total_chunks: number;
  total_featured_words: number;
  topics: string[];
};

export type FeaturedWord = {
  id: number;
  word: string;
  ipa: string;
  pos: string;
  cefr: string;
  definition_en: string;
  definition_zh: string;
  example: string;
  context_subtitle_id: number | null;
  context_text: string;
  importance: number;
};

export type GlobalFeaturedWord = {
  word: string;
  ipa: string;
  pos: string;
  cefr: string;
  definition_en: string;
  definition_zh: string;
  example: string;
  episode_count: number;
  top_episode_id: number;
};

export type EpisodeCard = {
  id: number;
  title: string;
  summary: string;
  summary_zh?: string;
  thumbnail_url: string;
  duration_sec: number;
  difficulty: number;
  accent: string;
  chunks_count: number;
  subtitles_count: number;
  status: string;
  category: Category | null;
  speaker: Speaker | null;
  topic: string;
  // Free-text sub-tag within the topic; empty when LLM couldn't tell.
  subtopic?: string;
  // Collection grouping. "full" = part of a full-video Collection;
  // null = legacy / highlight (single-Episode) imports.
  collection_kind?: string | null;
  segment_index?: number | null;
  // Import strategy. "segment" (default) = 2-3 min highlight clip;
  // "chapters" = whole video kept intact with episode_chapters nav
  // markers. Drives whether Learn fetches api.episodeChapters().
  import_mode?: string;
  youtube_url?: string;
};

export type EpisodeChapter = {
  id: number;
  order_idx: number;
  start_ms: number;
  end_ms: number;
  title_en: string;
  title_zh: string;
  summary_zh: string;
};

export type CollectionRow = {
  youtube_id: string;
  title: string;
  thumbnail_url: string;
  creator_name: string;
  segment_count: number;
  published_count: number;
  total_duration_sec: number;
  first_episode_id: number;
};

export type AdminCollectionRow = CollectionRow & {
  reviewing_count: number;
};

export type CollectionSegment = {
  id: number;
  title: string;
  segment_index: number;
  thumbnail_url: string;
  duration_sec: number;
  chunks_count: number;
  summary_zh: string;
  topic_zh: string;
  status: string;
};

export type CollectionDetail = CollectionRow & {
  segments: CollectionSegment[];
};

export type Note = {
  id: number;
  episode_id: number;
  episode_title: string;
  subtitle_id: number | null;
  content: string;
  created_at: string | null;
};

export type FavChunk = {
  fav_id: number;
  chunk_id: number;
  episode_id: number;
  episode_title: string;
  text: string;
  chunk_type: string;
  why_explanation: string;
  note: string;
};

export type WordSense = { pos: string; zh: string; en: string };

export type Vocabulary = {
  id: number;
  word: string;
  ipa?: string;
  ipa_uk?: string;
  ipa_us?: string;
  inflections?: string;
  senses?: WordSense[];
  definition_en: string;
  definition_zh: string;
  example: string;
  context_episode_id: number | null;
  context_subtitle_id: number | null;
  context_text: string;
  mastery: number;
  next_review_at?: string | null;
  last_reviewed_at?: string | null;
  review_count?: number;
};

export type Subtitle = {
  id: number;
  seq: number;
  start_ms: number;
  end_ms: number;
  text_en: string;
  text_zh: string;
  chunk_refs: number[];
  word_timings?: [string, number][];
};

export type Chunk = {
  id: number;
  text: string;
  chunk_type: string;
  why_explanation: string;
  usage_scenario: string;
  similar_expressions: string[];
  common_collocations: string[];
  pronunciation_tip: string;
  difficulty: number;
};

/** A phrase the learner highlighted themselves inside a subtitle line.
 * Rendered like an AI chunk; matched back onto the line by text. */
export type UserChunk = {
  id: number;
  episode_id: number;
  subtitle_id: number;
  text: string;
};

export type AISegment = {
  // Position of the picked clip inside the ORIGINAL full-length source video
  // (display-only, e.g. "0:55–3:03 of a 3.5h podcast"). The clip we actually
  // serve in `video_url` is rebased to 0, so DO NOT use these for player seek
  // or subtitle filtering.
  source_start?: number;
  source_end?: number;
  reason?: string;
  source?: string;
  full_duration?: number;
};
export type LessonBriefPoint = { en: string; zh: string };
export type LessonBriefChunkHint = { text: string; zh: string };
export type LessonBrief = {
  core_points: LessonBriefPoint[];
  target_chunks_hint: LessonBriefChunkHint[];
  speaking_prompts: string[];
  discussion_question: LessonBriefPoint | null;
};
// Patterns-tab sentence lesson — one anchor sentence + perspective-shifted
// variants. Lives in ai_metadata.sentence_pattern; older episodes generate
// it on demand via api.generateSentencePattern.
export type SentencePattern = {
  original: string;
  subtitle_idx: number;
  variants: { text: string; mental_trigger?: string; subject_type?: string; focus: string }[];
  commentary_zh: string;
};
export type EpisodeDetail = EpisodeCard & {
  video_url: string;
  youtube_url: string;
  ai_metadata: { segment?: AISegment | null; scenario?: string;[k: string]: unknown };
  // Pre-generated study card surfaced above the AI chat.  Null for
  // episodes imported before this feature shipped — frontend hides the
  // card when null (admin can backfill via regenerate-lesson-brief).
  lesson_brief: LessonBrief | null;
  subtitles: Subtitle[];
  chunks: Chunk[];
};

export type Conversation = {
  id: number;
  episode_id: number;
  scenario: string;
  target_chunks: number[];
  messages: { role: string; content: string; ts: number }[];
  chunks_used: number[];
  summary: string;
  status: string;
};

export type ImportTask = {
  id: number;
  youtube_url: string;
  status: string;
  stage: number;
  progress: number;
  log: unknown[];
  ai_segments: unknown[];
  selected_segment: Record<string, unknown>;
  episode_id: number | null;
  error: string;
  created_at: string;
  updated_at: string;
  /** Measured off the file growing on disk, present only while a download is
   *  actually in flight. ffmpeg does the transfer for ranged downloads and
   *  reports nothing to yt-dlp until it exits, so this is the only real
   *  signal — everything else on this row is a stage weight. */
  download?: DownloadProgress | null;
};

export type AuthConfig = {
  self_signup: boolean;
  /** Days a new self-created account gets. 0 = permanent. */
  trial_days: number;
  /** Empty when Google sign-in isn't configured — hide the button. */
  google_client_id: string;
};

export type DownloadProgress = {
  label: string;
  bytes: number;
  rate_bps: number;
  elapsed_sec: number;
  stalled_sec: number;
  deadline_sec: number;
  remaining_sec: number;
};

// Bring-your-own-key settings.  `available` is false when the server has
// no CREDENTIAL_ENC_KEY — the UI hides the whole section rather than
// offering a form that can only 503.  The key itself never comes back;
// `key_mask` ("sk-pro…4f2a") is all the browser ever sees.
export type LLMProviderInfo = {
  id: string;
  label: string;
  base_url: string;
  default_model: string;
  models: string[];
  /** 申请 key 的页面 */
  key_url: string;
  /** 一句话说明这家适合谁 */
  hint: string;
  /** model → 一句话说明。挑模型是学员最容易踩坑的一步 */
  notes: Record<string, string>;
};
export type LLMSettings = {
  available: boolean;
  configured: boolean;
  provider: string;
  model: string;
  base_url: string;
  key_mask: string;
  verified_at: string | null;
  last_error: string;
  providers: LLMProviderInfo[];
  // TTS half — a separate credential (CosyVoice via 阿里云百炼) stored on
  // the same row. Independent of the chat key: either can be set alone.
  tts_configured: boolean;
  /** minimax | cosyvoice —— 决定表单长什么样、音色清单从哪来。 */
  tts_provider: string;
  tts_group_id: string;
  tts_providers: Record<string, TTSProviderMeta>;
  /** 平台自己的 ElevenLabs 有没有配。没有的话那 6 个音色点了也没用。 */
  tts_platform_available: boolean;
  tts_voice: string;
  tts_model: string;
  tts_key_mask: string;
  tts_verified_at: string | null;
  tts_last_error: string;
  tts_suggested_voices: string[];
  // 音色名是分模型版本的：v2 的名字以 _v2 结尾，v3 是另一套，混用必然 418。
  tts_voices_by_model: Record<string, string[]>;
  tts_models: { id: string; label: string }[];
  tts_default_voice: string;
  tts_default_model: string;
  tts_voice_list_url: string;
  tts_key_url: string;
};

export type TTSProviderMeta = {
  label: string;
  hint: string;
  key_url: string;
  voice_list_url: string;
  models: { id: string; label: string }[];
  voices: string[];
  voices_by_model?: Record<string, string[]>;
  default_model: string;
  default_voice: string;
  needs_group_id: boolean;
};

export type ReviewResult = "incorrect" | "partial" | "correct";
export type ReviewExample = { scenario?: string; english?: string; chinese?: string };
export type ReviewDetail = {
  meaning?: string;
  explanation?: string;
  usageTip?: string;
  examples?: ReviewExample[];
} | ReviewExample[] | Record<string, unknown>;
export type ReviewDueItem = {
  /** expression = 从对话导入的知识点；vocab = 看视频攒的生词。同一个队列里两种都有。 */
  kind: "expression" | "vocab";
  id: number;
  cue: string;
  answer: string;
  example: string;
  /** ChatGPT 给的结构化讲解，形状不固定（meaning / explanation / usageTip /
   *  examples[]）。按 shape 渲染，不要假设字段一定存在。 */
  detail?: ReviewDetail;
  item_type: string;
  stage: number;
  status: string;
  next_due: string;
  overdue_days: number;
};
export type ReviewHistoryRow = {
  id: number; cue: string; answer: string; example: string;
  detail?: ReviewDetail; item_type: string;
  stage: number; status: string; attempts: number; correct: number;
  last_result: string; next_due: string; practice_date: string;
};

// ============ API ============
export const api = {
  // auth
  /** What the login page needs before it renders: whether signup is open
   *  and whether to draw the Google button. Public, no token required. */
  authConfig: () => request<AuthConfig>("/auth/config"),
  /** Self-serve signup. Username is derived from the email server-side.
   *  Returns a token directly, OR {needs_verification:true, email} when a
   *  6-digit email code is required (then call verifyEmail). */
  register: (email: string, password: string) =>
    request<RegisterResult>("/auth/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  /** Confirm the 6-digit signup code → logs the user in (returns a token). */
  verifyEmail: (email: string, code: string) =>
    request<TokenPayload>("/auth/verify-email", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    }),
  /** Re-send the signup code (rate-limited server-side to once per minute). */
  resendCode: (email: string) =>
    request<{ status: string }>("/auth/resend-code", {
      method: "POST",
      body: JSON.stringify({ email }),
    }),
  /** `credential` is the ID token from Google Identity Services. */
  googleLogin: (credential: string) =>
    request<TokenPayload>("/auth/google", {
      method: "POST",
      body: JSON.stringify({ credential }),
    }),
  /** `username` accepts the username OR the email address. */
  login: (username: string, password: string) =>
    request<TokenPayload>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  /** Logged-in user changes their own password. Verifies the old one
   *  server-side; returns 204. The settings page is the only caller. */
  changePassword: (old_password: string, new_password: string) =>
    request<void>("/auth/change-password", {
      method: "POST",
      body: JSON.stringify({ old_password, new_password }),
    }),

  // episodes
  categories: () => request<Category[]>("/episodes/categories"),
  topics: () => request<Topic[]>("/episodes/topics"),
  feed: () =>
    request<{
      // Episodes the current user spent ≥5s on, sorted by most recent visit.
      // Empty for anon visitors and brand-new users.
      continue: EpisodeCard[];
      // Most recent published episodes; used as the source for the
      // "推荐给你" rail when continue is empty.
      latest: EpisodeCard[];
    }>("/episodes/feed"),
  // Fired by the Learn page after the user has been on /learn/:id for
  // ~5s.  Backend upserts a row in episode_visits keyed by (user, ep)
  // and refreshes last_visited_at — that's the source of truth for
  // the home page's "继续学习" rail.  Anon users skip this entirely.
  recordEpisodeVisit: (epId: number) =>
    request<void>(`/episodes/${epId}/visit`, { method: "POST" }),
  episodes: (q: {
    category?: string;
    topic?: string;
    difficulty?: number;
    accent?: string;
    creator?: number;
    sort?: string;
    page?: number;
    size?: number;
  }) => {
    const p = new URLSearchParams();
    Object.entries(q).forEach(([k, v]) => v != null && p.set(k, String(v)));
    return request<Paged<DiscoverItem>>(`/episodes?${p}`);
  },
  episode: (id: number) => request<EpisodeDetail>(`/episodes/${id}`),
  // Chapter nav markers — [] for segment-mode episodes. Learn only
  // calls this when ep.import_mode === "chapters".
  episodeChapters: (id: number) =>
    request<EpisodeChapter[]>(`/episodes/${id}/chapters`),
  // Learner-triggered generation of the Patterns-tab sentence lesson for
  // older episodes that predate the feature. POSTs an optional freeform
  // steer; the backend caches the result into ai_metadata.
  generateSentencePattern: (id: number, extra_instruction = "") =>
    request<{ sentence_pattern: SentencePattern | null }>(
      `/episodes/${id}/sentence-pattern`,
      { method: "POST", body: JSON.stringify({ extra_instruction }) },
    ),

  // creators
  creators: () => request<CreatorRow[]>("/creators"),
  creator: (id: number) => request<CreatorDetail>(`/creators/${id}`),
  creatorEpisodes: (id: number, limit = 30, offset = 0) =>
    request<Paged<EpisodeCard>>(`/creators/${id}/episodes?limit=${limit}&offset=${offset}`),

  // collections (full-video imports)
  collections: (limit = 50, offset = 0) =>
    request<Paged<CollectionRow>>(`/collections?limit=${limit}&offset=${offset}`),
  collection: (youtubeId: string) =>
    request<CollectionDetail>(`/collections/${youtubeId}`),

  // admin collection management
  adminCollections: (limit = 50, offset = 0) =>
    request<Paged<AdminCollectionRow>>(`/admin/collections?limit=${limit}&offset=${offset}`),
  adminCollection: (youtubeId: string) =>
    request<CollectionDetail>(`/admin/collections/${youtubeId}`),
  adminPublishCollection: (youtubeId: string) =>
    request<{ ok: boolean; updated: number; status: string }>(
      `/admin/collections/${youtubeId}/publish`,
      { method: "POST" },
    ),
  adminUnpublishCollection: (youtubeId: string) =>
    request<{ ok: boolean; updated: number; status: string }>(
      `/admin/collections/${youtubeId}/unpublish`,
      { method: "POST" },
    ),

  // ---- 对话复习（/review）----
  reviewImport: (raw: string) =>
    request<{ imported: number; updated: number; space: string; practice_date: string }>(
      "/review/import", { method: "POST", body: JSON.stringify({ raw }) },
    ),
  reviewDue: () =>
    request<{
      today: string;
      total: number;
      items: ReviewDueItem[];
      latest_space: string;
      latest_practice_date: string;
      latest_count: number;
      latest_items: ReviewDueItem[];
    }>("/review/due"),
  reviewGrade: (id: number, result: ReviewResult) =>
    request<{ stage: number; status: string; next_due: string }>(
      `/review/items/${id}/grade`, { method: "POST", body: JSON.stringify({ result }) },
    ),
  reviewHistory: () => request<ReviewHistoryRow[]>("/review/history"),
  reviewStory: (itemIds: number[] = []) =>
    request<{ story: string; expressions: string[] }>(
      "/review/listening/story",
      { method: "POST", body: JSON.stringify({ item_ids: itemIds }) },
    ),

  /** 连播队列：这一集之后放什么。合集 → 话题主线 → 全部已发布。 */
  playQueue: (fromEpisodeId: number) =>
    request<{
      source: "collection" | "anchor" | "all";
      topic: string;
      current_index: number;
      items: {
        id: number;
        title: string;
        video_url: string;
        thumbnail_url: string;
        duration_sec: number;
        creator: string;
      }[];
    }>(`/me/play-queue?from_episode=${fromEpisodeId}`),

  // featured words
  episodeFeaturedWords: (id: number) =>
    request<FeaturedWord[]>(`/episodes/${id}/featured_words`),
  regenerateFeaturedWords: (id: number) =>
    request<FeaturedWord[]>(`/admin/episodes/${id}/featured_words/regenerate`, {
      method: "POST",
    }),
  globalFeaturedWords: (cefr?: string, limit = 100) => {
    const p = new URLSearchParams();
    if (cefr) p.set("cefr", cefr);
    p.set("limit", String(limit));
    return request<GlobalFeaturedWord[]>(`/featured_words?${p}`);
  },

  // ai
  startConversation: (episode_id: number) =>
    request<Conversation>("/ai/conversations", {
      method: "POST",
      body: JSON.stringify({ episode_id }),
    }),
  sendMessage: (cid: number, content: string) =>
    request<Conversation>(`/ai/conversations/${cid}/messages`, {
      method: "POST",
      body: JSON.stringify({ content }),
    }),
  redoLastTurn: (cid: number) =>
    request<Conversation>(`/ai/conversations/${cid}/messages/last-turn`, {
      method: "DELETE",
    }),
  resetConversation: (cid: number) =>
    request<Conversation>(`/ai/conversations/${cid}/reset`, {
      method: "POST",
    }),
  messageFeedback: (cid: number, msgIdx: number) =>
    request<{
      praise: string;
      errors: { original: string; suggestion: string; why: string }[];
      alternatives: string[];
      score: number;
    }>(`/ai/conversations/${cid}/messages/${msgIdx}/feedback`, {
      method: "POST",
    }),
  messageHint: (cid: number) =>
    request<{ hint: string }>(`/ai/conversations/${cid}/hint`, {
      method: "POST",
    }),
  teachbackQuestion: (cid: number) =>
    request<{ question: string; key_ideas: string }>(
      `/ai/conversations/${cid}/teachback/question`,
    ),
  teachbackReview: (cid: number, answer: string) =>
    request<{
      verdict: string;
      strengths: string[];
      missed_points: string[];
      suggestion: string;
    }>(`/ai/conversations/${cid}/teachback/review`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    }),
  translate: (text: string) =>
    request<{ text_zh: string }>("/translate", {
      method: "POST",
      body: JSON.stringify({ text }),
      // Mobile networks can stall a request indefinitely (no response,
      // no error) — the LLM call is slow enough that the user just sees
      // an endless spinner. Bound it so a stall surfaces as a real,
      // retryable error instead of hanging forever.
      signal: AbortSignal.timeout(45000),
    }),
  evalFullRecord: (
    epId: number,
    body: {
      transcript: string;
      duration_sec: number;
      wpm: number;
      chunks_hit: string[];
      chunks_missed: string[];
    },
  ) =>
    request<{
      score: number;
      summary_zh: string;
      fluency_zh: string;
      accuracy_zh: string;
      chunk_zh: string;
      next_step_zh: string;
    }>(`/ai/episodes/${epId}/full-record-eval`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  // Stream an AI reply.  onDelta fires for each token as it arrives; the
  // promise resolves to the final Conversation after the "done" event.
  sendMessageStream: async (
    cid: number,
    content: string,
    onDelta: (piece: string) => void,
  ): Promise<Conversation> => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const token = getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${BASE}/ai/conversations/${cid}/messages/stream`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`${res.status} ${await res.text().catch(() => "")}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let finalConvo: Conversation | null = null;
    // Parse text/event-stream frames (blank line delimited).
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let event = "message";
        let dataLine = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
        }
        if (!dataLine) continue;
        if (event === "done") {
          try { finalConvo = JSON.parse(dataLine) as Conversation; } catch { /* ignore bad final frame */ }
        } else {
          try {
            const payload = JSON.parse(dataLine) as { delta?: string };
            if (payload.delta) onDelta(payload.delta);
          } catch { /* skip malformed frame */ }
        }
      }
    }
    if (!finalConvo) throw new Error("stream ended without final payload");
    return finalConvo;
  },

  // favorites
  addFavorite: (target_type: "episode" | "subtitle" | "chunk", target_id: number, note = "") =>
    request<{ id: number; target_type: string; target_id: number; note: string }>("/favorites", {
      method: "POST",
      body: JSON.stringify({ target_type, target_id, note }),
    }),
  userChunks: (episodeId: number) =>
    request<UserChunk[]>(`/episodes/${episodeId}/user-chunks`),
  addUserChunk: (episode_id: number, subtitle_id: number, text: string) =>
    request<UserChunk>("/user-chunks", {
      method: "POST",
      body: JSON.stringify({ episode_id, subtitle_id, text }),
    }),
  removeUserChunk: (id: number) =>
    request<void>(`/user-chunks/${id}`, { method: "DELETE" }),
  removeFavorite: (target_type: string, target_id: number) =>
    request<void>(`/favorites?target_type=${target_type}&target_id=${target_id}`, {
      method: "DELETE",
    }),
  listFavorites: (target_type?: string) =>
    request<Array<{ id: number; target_type: string; target_id: number; note: string }>>(
      "/favorites" + (target_type ? `?target_type=${target_type}` : ""),
    ),

  // notes
  addNote: (episode_id: number, content: string, subtitle_id?: number) =>
    request<Note>(
      "/notes",
      { method: "POST", body: JSON.stringify({ episode_id, subtitle_id, content }) },
    ),
  // List notes. With no opts → all notes for the user (capped at 100).
  // Pass `episode_id` for the Learn-page Notes tab; pass `q` + `limit` +
  // `offset` for the Library Notes tab's search + infinite scroll.
  listNotes: (opts?: { episode_id?: number; q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (opts?.episode_id != null) p.set("episode_id", String(opts.episode_id));
    if (opts?.q) p.set("q", opts.q);
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    const qs = p.toString();
    return request<Paged<Note>>(`/notes${qs ? `?${qs}` : ""}`);
  },
  deleteNote: (id: number) => request<void>(`/notes/${id}`, { method: "DELETE" }),

  // favorites (enriched) — paginated over the combined favorites
  // timeline; each slice is split into the 3 buckets.
  listFavoritesEnriched: (limit = 30, offset = 0) =>
    request<{
      episodes: Array<{ fav_id: number; episode_id: number; title: string; thumbnail_url: string; duration_sec: number; note: string }>;
      subtitles: Array<{ fav_id: number; subtitle_id: number; episode_id: number; episode_title: string; text_en: string; text_zh: string; note: string }>;
      chunks: Array<{ fav_id: number; chunk_id: number; episode_id: number; episode_title: string; text: string; chunk_type: string; why_explanation: string; note: string }>;
      total: number;
      has_more: boolean;
    }>(`/favorites/enriched?limit=${limit}&offset=${offset}`),
  // Paginated, searchable list of favorited chunks for the Library Chunks tab.
  listFavoriteChunks: (opts?: { q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (opts?.q) p.set("q", opts.q);
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    const qs = p.toString();
    return request<Paged<FavChunk>>(`/favorites/chunks${qs ? `?${qs}` : ""}`);
  },

  // me
  myStats: () =>
    request<{
      episodes_started: number;
      episodes_finished: number;
      favorites_count: number;
      notes_count: number;
      conversations_count: number;
      chunks_mastered: number;
      joined_at: string | null;
      last_active: string | null;
      recent_notes: Array<{ id: number; episode_id: number; episode_title: string; content: string; created_at: string | null }>;
      in_progress: Array<{ episode_id: number; title: string; thumbnail_url: string; last_seq: number; subtitles_count: number; updated_at: string | null }>;
    }>("/me/stats"),

  // bring-your-own-key (/api/me/llm).  Every endpoint returns the same
  // settings shape, so the caller can just replace its cached copy.
  getLLMSettings: () => request<LLMSettings>("/me/llm"),
  saveLLMSettings: (body: {
    provider: string;
    api_key: string;
    model?: string;
    base_url?: string;
  }) =>
    request<LLMSettings>("/me/llm", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testLLMSettings: () => request<LLMSettings>("/me/llm/test", { method: "POST" }),
  deleteLLMSettings: () => request<LLMSettings>("/me/llm", { method: "DELETE" }),
  /** api_key 可省略：只换音色时后端复用已存的那把（key 从不回传浏览器）。 */
  saveTTSSettings: (body: {
    provider?: string; api_key?: string; voice?: string;
    model?: string; group_id?: string;
  }) =>
    request<LLMSettings>("/me/llm/tts", {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  testTTSSettings: () =>
    request<LLMSettings>("/me/llm/tts/test", { method: "POST" }),
  deleteTTSSettings: () =>
    request<LLMSettings>("/me/llm/tts", { method: "DELETE" }),

  myHeatmap: () =>
    request<{
      start: string;
      end: string;
      counts: Record<string, number>;
      total_active_days: number;
      best_streak: number;
      current_streak: number;
    }>("/me/heatmap"),

  myRecent: () =>
    request<{
      hero: EpisodeCard | null;
      collection: {
        youtube_url: string;
        items: Array<{
          id: number;
          title: string;
          segment_index: number | null;
          duration_sec: number;
          thumbnail_url: string;
          progress_status: "not_started" | "in_progress" | "finished";
          is_current: boolean;
        }>;
      } | null;
    }>("/me/recent"),

  updatePreferences: (body: { onboarding_dismissed?: boolean }) =>
    request<{ onboarding_dismissed: boolean }>(
      "/me/preferences",
      { method: "PATCH", body: JSON.stringify(body) },
    ),

  // vocabulary
  lookupWord: (word: string, context: string) =>
    request<{
      word: string; ipa: string; ipa_uk: string; ipa_us: string;
      inflections: string; senses: WordSense[];
      definition_en: string; definition_zh: string; example: string;
      // "llm" (preferred) | "dict" (Free Dictionary fallback, zh empty)
      source?: string;
    }>(
      "/words/lookup",
      { method: "POST", body: JSON.stringify({ word, context }) }
    ),
  // Rich, context-aware explanation. Caller passes whatever the learner
  // highlighted (single word, phrase, or whole sentence) plus the episode
  // and subtitle for grounding. Result is a Markdown string the UI renders
  // straight into the AskPopup body.
  explainInContext: (query: string, episode_id: number, subtitle_id?: number | null) =>
    request<{ query: string; markdown: string }>(
      "/words/explain-in-context",
      { method: "POST", body: JSON.stringify({ query, episode_id, subtitle_id: subtitle_id ?? null }) }
    ),
  addVocabulary: (body: {
    word: string; ipa?: string; ipa_uk?: string; ipa_us?: string;
    inflections?: string; senses?: WordSense[];
    definition_en?: string; definition_zh?: string; example?: string;
    context_episode_id?: number; context_subtitle_id?: number | null; context_text?: string;
  }) =>
    request<Vocabulary>("/vocabulary", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  enrichVocabulary: (id: number) =>
    request<Vocabulary>(`/vocabulary/${id}/enrich`, { method: "POST" }),
  listVocabulary: (opts?: { mastery?: number; q?: string; limit?: number; offset?: number }) => {
    const p = new URLSearchParams();
    if (opts?.mastery != null) p.set("mastery", String(opts.mastery));
    if (opts?.q) p.set("q", opts.q);
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    const qs = p.toString();
    return request<Paged<Vocabulary>>(`/vocabulary${qs ? `?${qs}` : ""}`);
  },
  updateVocabulary: (id: number, mastery: number) =>
    request<Vocabulary>(`/vocabulary/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ mastery }),
    }),
  deleteVocabulary: (id: number) =>
    request<{ ok: boolean }>(`/vocabulary/${id}`, { method: "DELETE" }),
  dueVocabulary: (limit = 20) =>
    request<Vocabulary[]>(`/vocabulary/due?limit=${limit}`),
  reviewVocabulary: (
    id: number,
    grade: "forgot" | "fuzzy" | "got",
  ) =>
    request<Vocabulary>(`/vocabulary/${id}/review`, {
      method: "POST",
      body: JSON.stringify({ grade }),
    }),

  // progress
  putProgress: (episode_id: number, last_seq: number, finished = false) =>
    request<{ ok: boolean }>("/progress", {
      method: "PUT",
      body: JSON.stringify({ episode_id, last_seq, finished }),
    }),

  // search
  search: (
    q: string,
    type: "all" | "subtitle" | "chunk" | "episode" = "all",
    opts?: { limit?: number; offset?: number },
  ) => {
    const p = new URLSearchParams({ q, type });
    if (opts?.limit != null) p.set("limit", String(opts.limit));
    if (opts?.offset != null) p.set("offset", String(opts.offset));
    return request<{
      episodes: Array<{ id: number; title: string; summary: string; thumbnail_url: string; duration_sec: number; difficulty: number; accent: string }>;
      subtitles: Array<{ id: number; episode_id: number; episode_title: string; seq: number; start_ms: number; text_en: string; text_zh: string }>;
      chunks: Array<{ id: number; episode_id: number; episode_title: string; text: string; chunk_type: string; why_explanation: string }>;
      has_more: { episodes: boolean; subtitles: boolean; chunks: boolean };
    }>(`/search?${p}`);
  },

  // admin · episodes
  adminListEpisodes: (filters: { status?: string; category_id?: number; q?: string; limit?: number; offset?: number } = {}) => {
    const p = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v != null && v !== "" && p.set(k, String(v)));
    return request<Paged<{
      id: number; title: string; summary: string; thumbnail_url: string;
      video_url: string; video_codec: string; transcode_state: string;
      duration_sec: number; difficulty: number; accent: string;
      chunks_count: number; subtitles_count: number; status: string;
      category_id: number | null; category_name: string | null; topic: string; subtopic: string;
      speaker_handle: string | null; published_at: string | null; created_at: string;
    }>>(`/admin/episodes?${p}`);
  },
  adminGetEpisode: (id: number) =>
    request<{
      id: number; title: string; summary: string; thumbnail_url: string;
      video_url: string; video_codec: string; transcode_state: string;
      youtube_url: string; duration_sec: number;
      difficulty: number; accent: string; chunks_count: number; subtitles_count: number;
      status: string; category_id: number | null; category_name: string | null; topic: string; subtopic: string;
      speaker_handle: string | null; published_at: string | null; created_at: string;
      ai_metadata: Record<string, unknown>;
      subtitles: Array<{ id: number; seq: number; start_ms: number; end_ms: number; text_en: string; text_zh: string }>;
      chunks: Array<{
        id: number; text: string; chunk_type: string;
        why_explanation: string; usage_scenario: string;
        similar_expressions: string[]; common_collocations: string[];
        pronunciation_tip: string; difficulty: number;
      }>;
    }>(`/admin/episodes/${id}`),
  adminUpdateEpisode: (id: number, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/admin/episodes/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  adminPublishEpisode: (id: number) =>
    request<{ ok: boolean; status: string }>(`/admin/episodes/${id}/publish`, { method: "POST" }),
  adminUnpublishEpisode: (id: number) =>
    request<{ ok: boolean; status: string }>(`/admin/episodes/${id}/unpublish`, { method: "POST" }),
  adminDeleteEpisode: (id: number) =>
    request<void>(`/admin/episodes/${id}`, { method: "DELETE" }),

  // admin · one-click "push to prod" (local dev → remote ECS bundle publish)
  adminPushTarget: () =>
    request<{ enabled: boolean; target: string }>(`/admin/push-target`),
  adminPushToProd: (episode_id: number) =>
    request<{ ok: boolean; target: string; count: number; episode_ids: number[] }>(
      `/admin/push-to-prod`, { method: "POST", body: JSON.stringify({ episode_id }) }),

  // admin · video codec / iPhone-compat transcode
  adminScanCodecs: () =>
    request<{ scanned: number; updated: number; by_codec: Record<string, number>; iphone_broken: number }>(
      `/admin/episodes/scan-codecs`, { method: "POST" }),
  adminTranscodeEpisode: (id: number) =>
    request<{ ok: boolean; ep_id: number; state: string }>(
      `/admin/episodes/${id}/transcode`, { method: "POST" }),
  adminTranscodeAllAv1: () =>
    request<{ ok: boolean; queued: number; total_av1: number }>(
      `/admin/episodes/transcode-all-av1`, { method: "POST" }),
  adminTranscodeStatus: () =>
    request<{
      active: number | null;
      queued: number[];
      states: Record<string, string>;
      errors: Record<string, string>;
    }>(`/admin/transcode-status`),

  // anchor (= committed topic) · learner-facing
  anchorTopics: () => request<TopicCard[]>(`/anchor/topics`),
  myAnchor: (page?: number, size?: number) => {
    const p = new URLSearchParams();
    if (page != null) p.set("page", String(page));
    if (size != null) p.set("size", String(size));
    const qs = p.toString();
    return request<MyAnchor | null>(`/me/anchor${qs ? `?${qs}` : ""}`);
  },
  adoptAnchor: (topic: string, level: number = 2) =>
    request<MyAnchor>(`/me/anchor`, { method: "POST", body: JSON.stringify({ topic, level }) }),
  advanceAnchor: () =>
    request<MyAnchor>(`/me/anchor/advance`, { method: "POST" }),
  switchAnchor: (topic: string, level: number = 2) =>
    request<MyAnchor>(`/me/anchor/switch`, { method: "POST", body: JSON.stringify({ topic, level }) }),

  // admin · subtitles & chunks
  adminUpdateSubtitle: (id: number, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/admin/subtitles/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  adminDeleteSubtitle: (id: number) =>
    request<void>(`/admin/subtitles/${id}`, { method: "DELETE" }),
  adminUpdateChunk: (id: number, body: Record<string, unknown>) =>
    request<{ ok: boolean }>(`/admin/chunks/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  adminDeleteChunk: (id: number) =>
    request<void>(`/admin/chunks/${id}`, { method: "DELETE" }),
  adminAddChunk: (episodeId: number, body: { text: string; chunk_type?: string; why_explanation?: string; usage_scenario?: string; difficulty?: number }) =>
    request<{ ok: boolean; id: number }>(`/admin/episodes/${episodeId}/chunks`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // admin
  adminStats: () =>
    request<{
      total_episodes: number;
      published: number;
      reviewing: number;
      draft: number;
      total_users: number;
      total_conversations: number;
      total_chunks: number;
      pipeline_running: number;
    }>("/admin/stats"),
  adminImports: (limit = 50, offset = 0) =>
    request<Paged<ImportTask>>(`/admin/import?limit=${limit}&offset=${offset}`),
  adminImportCreate: (body: {
    youtube_url: string;
    category_id?: number | null;
    accent?: string;
    difficulty?: number;
    force?: boolean;
    segments_count?: number;
    topic_hint?: string;
    mode?: "highlight" | "full" | "chapters";
  }) =>
    request<ImportTask>("/admin/import", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  adminImportGet: (id: number) => request<ImportTask>(`/admin/import/${id}`),
  adminImportApprove: (id: number, segments: Array<{ source_start: number; source_end: number; reason?: string }>) =>
    request<{ ok: boolean }>(`/admin/import/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ segments }),
    }),
  adminImportDelete: (id: number) =>
    request<void>(`/admin/import/${id}`, { method: "DELETE" }),
  adminImportRetry: (id: number) =>
    request<ImportTask>(`/admin/import/${id}/retry`, { method: "POST" }),
  adminImportCancel: (id: number) =>
    request<ImportTask>(`/admin/import/${id}/cancel`, { method: "POST" }),
  adminRegenerateChunks: (epId: number) =>
    request<{ ok: boolean; chunks_count: number }>(`/admin/episodes/${epId}/regenerate-chunks`, { method: "POST" }),
  adminRegenerateScenario: (epId: number) =>
    request<{ ok: boolean; scenario: string }>(`/admin/episodes/${epId}/regenerate-scenario`, { method: "POST" }),
  adminRegenerateSummaryZh: (epId: number) =>
    request<{ ok: boolean; summary_zh: string }>(`/admin/episodes/${epId}/regenerate-summary-zh`, { method: "POST" }),
  adminRegenerateLessonBrief: (epId: number) =>
    request<{ ok: boolean; lesson_brief: LessonBrief }>(`/admin/episodes/${epId}/regenerate-lesson-brief`, { method: "POST" }),
  adminRetranslateSubtitles: (epId: number) =>
    request<{ ok: boolean; updated: number; total: number }>(`/admin/episodes/${epId}/retranslate-subtitles`, { method: "POST" }),

  // admin user management
  adminListUsers: (limit = 50, offset = 0) =>
    request<Paged<AdminUser>>(`/admin/users?limit=${limit}&offset=${offset}`),
  adminCreateUser: (body: {
    username: string;
    password: string;
    email?: string;
    role?: "user" | "admin";
    admin_note?: string;
    /** ISO 8601 timestamp; null/undefined = permanent. */
    expires_at?: string | null;
  }) =>
    request<AdminUser>("/admin/users", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  adminPatchUser: (
    id: number,
    body: {
      password?: string;
      email?: string;
      role?: "user" | "admin";
      admin_note?: string;
      expires_at?: string | null;
      /** Sentinel: when true, server clears expires_at (sets permanent). */
      clear_expiry?: boolean;
    },
  ) =>
    request<AdminUser>(`/admin/users/${id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }),
  adminExtendUser: (id: number, days: number) =>
    request<AdminUser>(`/admin/users/${id}/extend`, {
      method: "POST",
      body: JSON.stringify({ days }),
    }),
  adminDeleteUser: (id: number) =>
    request<void>(`/admin/users/${id}`, { method: "DELETE" }),

  // Req 5: scheduled creator imports
  adminListSchedules: () =>
    request<ImportScheduleOut[]>("/admin/schedules"),
  adminCreateSchedule: (body: ImportScheduleCreate) =>
    request<ImportScheduleOut>("/admin/schedules", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  adminUpdateSchedule: (id: number, body: Partial<ImportScheduleCreate>) =>
    request<ImportScheduleOut>(`/admin/schedules/${id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  adminDeleteSchedule: (id: number) =>
    request<void>(`/admin/schedules/${id}`, { method: "DELETE" }),
  adminRunScheduleNow: (id: number) =>
    request<{ ok: boolean }>(`/admin/schedules/${id}/run-now`, {
      method: "POST",
    }),
  adminListSpeakersAll: () =>
    request<AdminSpeakerLite[]>("/admin/schedules/speakers/all"),
  adminReviewQueue: (limit = 50, offset = 0) =>
    request<Paged<ReviewQueueItem>>(`/admin/schedules/review-queue?limit=${limit}&offset=${offset}`),
};

export type ImportScheduleOut = {
  id: number;
  name: string;
  speaker_id: number;
  speaker_handle: string | null;
  speaker_name: string | null;
  cron_expression: string;
  videos_per_run: number;
  segments_per_video: number;
  max_video_duration_sec: number;
  enabled: boolean;
  last_run_at: string | null;
  last_run_summary: Record<string, unknown>;
  created_at: string;
};

export type ImportScheduleCreate = {
  name: string;
  speaker_id: number;
  cron_expression: string;
  videos_per_run?: number;
  segments_per_video?: number;
  max_video_duration_sec?: number;
  enabled?: boolean;
};

export type AdminSpeakerLite = {
  id: number;
  handle: string;
  name: string;
  youtube_url: string;
};

export type ReviewQueueItem = {
  id: number;
  title: string;
  thumbnail_url: string;
  duration_sec: number;
  chunks_count: number;
  subtitles_count: number;
  status: string;
  speaker_handle: string | null;
  speaker_name: string | null;
  category_name: string | null;
  topic: string;
  difficulty: number;
  accent: string;
  created_at: string;
  schedule_name: string | null;
};

export type AdminUser = {
  id: number;
  username: string;
  email: string;
  role: "user" | "admin";
  admin_note: string;
  created_at: string;
  last_active: string | null;
  /** Trial expiry. null = permanent. */
  expires_at: string | null;
};
