from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    database_url: str = "postgresql+asyncpg://admin:justspeak_dev@localhost:5432/justspeak"
    jwt_secret: str = "change-me"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7

    # ---- Self-serve signup (see routers/auth.py) ----
    # When true, POST /auth/register and POST /auth/google both create
    # accounts on the spot instead of requiring an admin to provision
    # one after an offline Xiaohongshu payment.  Set to false to go back
    # to invite-only without touching code.
    auth_self_signup: bool = True
    # Days of access a self-created account gets.  Written into
    # User.expires_at at creation time, so the existing trial_expired
    # machinery (auth.current_user / login / admin extend) handles the
    # rest unchanged.  0 → NULL expires_at, i.e. permanent accounts.
    # Only applies to accounts created BY signup; existing users and
    # admin-provisioned ones are untouched, and signing in again never
    # re-stamps an existing account's expiry.
    # Default 0 = new signups are permanent. Set AUTH_NEW_USER_TRIAL_DAYS=N
    # to hand out N-day trials instead.
    auth_new_user_trial_days: int = 0

    # ---- Email verification (see routers/auth.py + services/email.py) ----
    # When true, a self-signup must enter a 6-digit code emailed to them
    # before the account can log in (the email_verified gate). Default FALSE
    # so a deployment without a mail sender still works — turn it ON only
    # AFTER SMTP_* below is configured, otherwise nobody receives the code.
    # When no SMTP sender is configured, the code is written to the api log
    # (for local dev / staging) instead of emailed.
    auth_require_email_verification: bool = False
    email_code_ttl_minutes: int = 15
    # SMTP sender. All-empty → no real email is sent (code goes to the log).
    # Fill these to send for real, e.g. 阿里云邮件推送 / QQ / 163 SMTP.
    smtp_host: str = ""
    smtp_port: int = 465
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_use_ssl: bool = True        # 465 = SSL; for STARTTLS use false + port 587
    email_from: str = ""             # falls back to smtp_user when empty
    email_from_name: str = "justSpeak"

    # Google Sign-In (Google Identity Services).  The frontend renders
    # the Google button only when this is set, and posts the resulting
    # ID token to /auth/google where services/google_auth.py verifies
    # its signature against Google's JWKS.  Empty → feature off, the
    # endpoint 503s and the button is hidden.
    #
    # NOTE for the mainland deploy: verification fetches Google's public
    # certs over the network, which is blocked from a China ECS without
    # a proxy.  Leave this unset on prod until that's solved — see
    # DEPLOY.md.
    google_client_id: str = ""

    # Encryption key for user-supplied third-party API keys (see
    # services/secrets.py).  Any string; a 32-byte urlsafe-base64 value is
    # used as a Fernet key directly, anything else is SHA-256 stretched.
    # UNSET → the "bring your own key" feature is disabled outright and
    # /api/me/llm 503s, because storing spendable credentials in plaintext
    # is worse than not offering the feature.  Rotating it invalidates every
    # stored key (users are told to re-enter, nothing crashes).
    credential_enc_key: str = ""
    # ---- Platform LLM keys: OPTIONAL, and not used by anything a learner
    # or an admin triggers. ----
    #
    # Every model call in the product runs on the key of whoever asked for
    # it (see docs/BYOK.md): learners' chat/rephrase/words, and admins' own
    # imports. These env keys remain only as a last-resort fallback for a
    # deployment that wants one — leaving them empty is the supported
    # configuration, and prod runs that way.
    #
    # Why they went away: a platform key is a bill nobody can see and a
    # single point of failure. On 2026-08-16 this one lapsed and Rephrase
    # broke while the settings page still reported 连接正常, because that
    # button tests the learner's key, not this one.
    deepseek_api_key: str = ""
    deepseek_base_url: str = "https://api.deepseek.com"
    # v4-pro, NOT v4-flash: both are reasoning models and their thinking
    # tokens come out of max_tokens, but flash routinely spends the WHOLE
    # budget on reasoning (4000/4000 tokens, finish_reason=length) and returns
    # empty content — which surfaced as "Chunk 提取失败：LLM 三次尝试都返回空
    # 列表". pro spends ~500 and answers.
    deepseek_model: str = "deepseek-v4-pro"

    anthropic_api_key: str = ""
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"

    # Hard kill-switch for non-DeepSeek providers. Set to "deepseek_only"
    # in the prod env so even if OpenAI / Anthropic keys leak into the
    # server, they won't be called. Any other value → normal fallback
    # behavior (DeepSeek → Anthropic → OpenAI per _chat()'s order).
    # Use this on mainland-China deploys where non-DeepSeek endpoints
    # are unreliable from the server's network.
    llm_provider: str = "auto"

    # ElevenLabs TTS (see services/tts.py).  Unset → endpoint 503 →
    # frontend falls back to Web Speech.
    #
    # Two ways to configure keys:
    #   - ELEVENLABS_API_KEY=sk_xxx              (single key, original)
    #   - ELEVENLABS_API_KEYS=sk_aaa,sk_bbb,sk_ccc   (multiple, rotated)
    # When the plural form is set, tts.py walks keys in order and on
    # 401/402/429 cools that key for 1h and retries with the next.
    # Useful when the free tier on a single account caps out — chain
    # 2-3 free accounts to get more headroom before fallback Web Speech.
    elevenlabs_api_key: str = ""
    elevenlabs_api_keys: str = ""
    # Hard kill-switch for TTS: when true, /api/tts returns 503 even
    # if a key is configured, so the client always uses Web Speech.
    # Saves ElevenLabs bill on test tier and gives a deterministic
    # "free pronunciation" experience for all users.
    tts_disabled: bool = False
    # Default voice: Matilda (US, female, "Knowledgable, Professional",
    # informative_educational) — premade, free-tier OK on current
    # accounts. Picked over Rachel (paid library voice → 402 on free
    # tier) and Alice (UK accent — app is optimized for learners
    # targeting US English). Per-user override is stored client-side
    # under localStorage["tts-voice-id"] and sent as `voice_id` in the
    # /api/tts body, so this default only matters when the client
    # hasn't picked one.
    elevenlabs_voice_id: str = "XrExE9yKIg1WjnnlVkGX"
    elevenlabs_model: str = "eleven_turbo_v2_5"

    # Optional absolute base URL for /media/* assets, used to bypass
    # Cloudflare on the video stream while keeping CF for HTML/JS/API.
    # Why: CF Free has no mainland edge; large mp4 + Range requests
    # over CF Tokyo/HK frequently fail for CN mobile users with the
    # generic "media could not be loaded" error.  Pointing video at a
    # DNS-only subdomain (e.g. media.justspeak.today, gray cloud in
    # CF panel → straight to Vultr Tokyo) sidesteps the CF path while
    # keeping the small assets on the CDN.
    #
    # When empty (default): EpisodeDetail.video_url stays relative
    # ("/media/foo.mp4") and the browser inherits the page's origin —
    # i.e. goes through CF.  When set (e.g. "https://media.justspeak.today"):
    # the API rewrites video_url to absolute, so the <video> element
    # connects directly to the bypass host.
    media_base_url: str = ""

    # Aliyun OSS — object storage for media (video/thumb/tts) on the
    # mainland-China deploy. When oss_bucket + keys are set, the
    # bundle-import endpoint and media writes push to OSS instead of the
    # local /app/media volume; DB still stores relative paths
    # ("/media/videos/<id>.mp4") and media_base_url (the CDN domain)
    # absolutizes them at serve time. When unset (local dev), media falls
    # back to the local disk volume served by nginx — so the whole
    # import/playback flow works E2E without any Aliyun credentials.
    #
    # Use the INTERNAL endpoint on an Aliyun ECS in the same region
    # (oss-cn-hangzhou-internal.aliyuncs.com) — same-region traffic is
    # free and ~Gbps. The public endpoint (oss-cn-hangzhou.aliyuncs.com)
    # works from anywhere but bills public egress.
    oss_endpoint: str = ""
    oss_bucket: str = ""
    oss_access_key_id: str = ""
    oss_access_key_secret: str = ""

    @property
    def oss_enabled(self) -> bool:
        return bool(
            self.oss_bucket
            and self.oss_endpoint
            and self.oss_access_key_id
            and self.oss_access_key_secret
        )

    # "Push to prod" — lets the LOCAL admin one-click export+publish a locally
    # imported episode/collection to the remote mainland deploy, instead of
    # running the export_bundle/publish CLIs by hand. Only meaningful on the
    # Mac dev stack (which runs the pipeline); the remote ECS leaves these
    # empty so the button stays hidden there. Holds the remote admin creds —
    # keep them in the LOCAL .env only.
    publish_target_api: str = ""
    publish_target_user: str = ""
    publish_target_password: str = ""

    @property
    def publish_enabled(self) -> bool:
        return bool(
            self.publish_target_api
            and self.publish_target_user
            and self.publish_target_password
        )

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")


settings = Settings()
