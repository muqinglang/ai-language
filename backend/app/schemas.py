from datetime import datetime
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, EmailStr, field_validator

from .config import settings


# ============ Pagination ============
_PageT = TypeVar("_PageT")


class Page(BaseModel, Generic[_PageT]):
    """Standard list-endpoint envelope. `total` is the unfiltered-by-page
    row count; `has_more` is True when more rows exist past this slice."""
    items: list[_PageT]
    total: int
    has_more: bool


# ============ Auth ============
class UserRegister(BaseModel):
    email: EmailStr
    password: str
    # Optional — the signup form only asks for email + password, and the
    # router derives a unique username from the email's local part when
    # this is blank.  Kept accepted so existing callers still work.
    username: str = ""

    @field_validator("password")
    @classmethod
    def _password_length(cls, v: str) -> str:
        if len(v) < 6:
            raise ValueError("密码至少 6 位")
        return v


class UserLogin(BaseModel):
    # Accepts either the username or the email address — self-signup
    # users only ever see their email, and would have no idea what
    # username got derived for them.
    username: str
    password: str


class GoogleAuthIn(BaseModel):
    """The ID token ("credential") returned by Google Identity Services."""
    credential: str


class AuthConfigOut(BaseModel):
    """What the login page needs to know before rendering itself:
    whether to show the signup tab, and whether to draw the Google
    button (only when the server has a client id configured)."""
    self_signup: bool
    trial_days: int
    google_client_id: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    username: str
    email: str
    role: str
    # Trial / time-limited access.  Null = permanent.  Frontend uses
    # this to render the "试用还剩 N 天" banner in Shell when the
    # remaining window is short.
    expires_at: datetime | None = None
    # "自由模式" — Home shows recent clips instead of the topic mainline.
    # Persisted per user via PATCH /me/preferences, but the frontend reads
    # it off the login payload it caches in localStorage, so leaving it out
    # here meant every fresh login silently reverted the learner to the
    # mainline. If their anchor topic has no published episodes, that is a
    # blank Home screen they have to dismiss again on every sign-in.
    onboarding_dismissed: bool = False


class TokenOut(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: UserOut


# ============ Category / Speaker ============
class CategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    name: str
    slug: str
    icon: str


class SpeakerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    handle: str
    name: str
    default_accent: str


# ============ Episode ============
def _absolutize_relative_media(v: str) -> str:
    """Turn a relative /media/... path into an absolute URL on the
    media bypass subdomain when MEDIA_BASE_URL is configured.

    Pulled out as a free function so EpisodeCard.thumbnail_url and
    EpisodeDetail.video_url share the exact same rewrite behavior —
    same fallback for already-absolute URLs (legacy YouTube CDN
    thumbnails, external video hosts), same empty-string passthrough,
    same single-slash normalization."""
    base = settings.media_base_url.rstrip("/")
    if not base or not v:
        return v
    if v.startswith("http://") or v.startswith("https://"):
        return v
    path = v if v.startswith("/") else "/" + v
    return f"{base}{path}"


class EpisodeCard(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    summary: str
    # Chinese version of the clip summary — surfaced on card + catalog for
    # Chinese learners to skim before clicking in.  Sourced from
    # Episode.summary_zh (@property on the model that reads ai_metadata).
    summary_zh: str = ""
    thumbnail_url: str
    duration_sec: int
    difficulty: int
    accent: str
    chunks_count: int
    subtitles_count: int
    status: str
    category: CategoryOut | None = None
    speaker: SpeakerOut | None = None
    topic: str = "other"
    # Collection grouping (full-video imports). Null for legacy / highlight
    # episodes; "full" means this episode is segment N of a Collection
    # whose other segments share the same youtube_url.
    collection_kind: str | None = None
    segment_index: int | None = None
    # Import strategy used when this episode was created. "segment" (default)
    # = 2-3 min highlight clip; "chapters" = whole video preserved with
    # episode_chapters rows for in-video navigation. The frontend uses this
    # to decide whether to fetch GET /api/episodes/:id/chapters.
    import_mode: str = "segment"
    youtube_url: str = ""

    @field_validator("thumbnail_url", mode="after")
    @classmethod
    def _absolutize_thumbnail(cls, v: str) -> str:
        """When pipeline saved the thumbnail locally as
        `/media/thumbs/<id>.jpg`, prepend MEDIA_BASE_URL so the card
        renders through the media bypass subdomain (DNS-only, direct
        Tokyo) — that's the path mainland CN users can reach.  Old
        rows still pointing at https://i.ytimg.com/... pass through
        unchanged (they're already absolute) until the backfill job
        rewrites them."""
        return _absolutize_relative_media(v)


class SubtitleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    seq: int
    start_ms: int
    end_ms: int
    text_en: str
    text_zh: str
    chunk_refs: list
    word_timings: list = []


class EpisodeChapterOut(BaseModel):
    """Navigation marker inside a chapters-mode Episode.

    Returned by GET /api/episodes/:id/chapters in order_idx order. Times
    are absolute ms into the full-video timeline (no rebase).
    """
    model_config = ConfigDict(from_attributes=True)
    id: int
    order_idx: int
    start_ms: int
    end_ms: int
    title_en: str
    title_zh: str = ""
    summary_zh: str = ""


class ChunkOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    text: str
    chunk_type: str
    why_explanation: str
    usage_scenario: str
    similar_expressions: list
    common_collocations: list
    pronunciation_tip: str
    difficulty: int


class LessonBriefPoint(BaseModel):
    en: str = ""
    zh: str = ""


class LessonBriefChunkHint(BaseModel):
    text: str
    zh: str = ""


class LessonBrief(BaseModel):
    """Structured study card shown above the AI chat.  Pre-generated at
    pipeline stage 5 and persisted in Episode.ai_metadata.lesson_brief —
    null when an older episode hasn't been re-processed yet."""
    core_points: list[LessonBriefPoint] = []
    target_chunks_hint: list[LessonBriefChunkHint] = []
    speaking_prompts: list[str] = []
    discussion_question: LessonBriefPoint | None = None


class EpisodeDetail(EpisodeCard):
    video_url: str
    youtube_url: str
    ai_metadata: dict = {}
    # Surfaced as a typed top-level field (also lives in ai_metadata) so
    # the frontend gets a stable shape and TS types instead of poking at
    # the open-ended ai_metadata bag.
    lesson_brief: LessonBrief | None = None
    subtitles: list[SubtitleOut] = []
    chunks: list[ChunkOut] = []

    @field_validator("video_url", mode="after")
    @classmethod
    def _absolutize_video(cls, v: str) -> str:
        """Same rewrite logic as thumbnail_url — see _absolutize_relative_media."""
        return _absolutize_relative_media(v)


# ============ AI conversation ============
class StartConversation(BaseModel):
    episode_id: int


class SendMessage(BaseModel):
    content: str


class Message(BaseModel):
    role: str
    content: str
    ts: float


class ConversationOut(BaseModel):
    id: int
    episode_id: int
    scenario: str
    target_chunks: list
    messages: list[Message]
    chunks_used: list
    summary: str
    status: str


# ============ Admin import ============
class ImportCreate(BaseModel):
    youtube_url: str
    category_id: int | None = None
    speaker_id: int | None = None
    accent: str = "US"
    difficulty: int = 3
    force: bool = False
    # How many 2-3 min clips to cut from the source video. Each produces its
    # own independent Episode sharing the same youtube_url as grouping key.
    segments_count: int = 1
    # Optional free-text directive that biases the LLM's segment picker
    # toward parts of the video about THIS sub-area. Empty = no bias
    # (legacy behavior — picker chooses by general "learning value").
    # Useful when a 1-hour podcast covers shopping + cooking + politics
    # and you only want the cooking parts.
    topic_hint: str = ""
    # When True (or when segments_count > 1), the pipeline pauses after
    # AI segment selection so the admin can review / ±15s adjust the picks
    # before downloading.
    preview: bool = False
    # Import mode:
    #   "highlight" (default) — AI picks 1 or N highlight windows from the
    #     source video, each becomes a standalone Episode (segment-style).
    #   "full" — legacy Collection mode: split the WHOLE video into 2-3min
    #     coherent segments and produce N Episodes sharing youtube_url.
    #     Retained for back-compat with old admin requests; no longer
    #     surfaced in the admin UI.
    #   "chapters" — import the whole video as ONE Episode with AI-generated
    #     chapter navigation markers (Episode.import_mode='chapters').
    mode: str = "highlight"


class ImportTaskOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    youtube_url: str
    status: str
    stage: int
    progress: int
    log: list
    ai_segments: list
    selected_segment: dict
    episode_id: int | None
    error: str
    created_at: datetime
    # Refreshed on every mark() commit. Frontend computes "X 分钟未更新"
    # so admin can spot a stuck pipeline (silent yt-dlp retry, expired
    # cookies, etc.) instead of guessing whether progress is just slow.
    updated_at: datetime
    # Measured (not inferred) download stats, present only while bytes are
    # in flight: {label, bytes, rate_bps, elapsed_sec, stalled_sec,
    # deadline_sec, remaining_sec}. Sampled off the growing file on disk
    # because ffmpeg — which does the actual transfer for ranged downloads —
    # reports nothing back to yt-dlp until it exits.
    download: dict | None = None


class StatsOut(BaseModel):
    total_episodes: int
    published: int
    reviewing: int
    draft: int
    total_users: int
    total_conversations: int
    total_chunks: int
    pipeline_running: int
