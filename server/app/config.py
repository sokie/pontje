from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Runtime configuration from PONTJE_* env vars (or server/.env in dev)."""

    model_config = SettingsConfigDict(env_prefix="PONTJE_", env_file=".env", extra="ignore")

    db_path: str = "pontje.db"
    public_base_url: str = "http://localhost:5173"
    google_client_id: str = ""
    google_client_secret: str = ""
    allowed_emails: str = ""  # comma-separated
    session_secret: str = "dev-only-not-a-secret"  # signs the transient OAuth state cookie
    secret_key: str = ""  # Fernet key for secret snippets

    # Local testing escape hatch: POST /api/v1/auth/dev-login mints a session for
    # an allowlisted email without touching Google. NEVER enable in production.
    dev_fake_login: bool = False

    # Single-container deploys (Railway): serve the built SPA from this dir.
    # Empty (default) = Caddy serves the SPA instead (NAS/dev).
    static_dir: str = ""

    # ---- AI / LLM ----------------------------------------------------------
    # HARD master switch: PONTJE_AI_DISABLED=1 kills every AI/LLM feature no
    # matter what else is configured. Any future AI feature MUST gate on
    # `settings.ai_enabled`.
    ai_disabled: bool = False
    # OpenAI-compatible chat-completions endpoint (Ollama, LM Studio,
    # OpenRouter, cloud gateways). AI stays OFF until BOTH are set.
    llm_base_url: str = ""  # e.g. http://nas.local:11434/v1
    llm_model: str = ""  # e.g. qwen3:1.7b
    llm_api_key: str = ""  # optional — local servers usually need none

    @property
    def ai_enabled(self) -> bool:
        return not self.ai_disabled and bool(self.llm_base_url) and bool(self.llm_model)

    @property
    def allowed_email_set(self) -> set[str]:
        return {e.strip().lower() for e in self.allowed_emails.split(",") if e.strip()}

    @property
    def cookie_secure(self) -> bool:
        # http://localhost dev → non-Secure cookies; anything https → Secure.
        return self.public_base_url.startswith("https")

    def assert_production_ready(self) -> None:
        """Boot-time guard (PLAN.md §23): in production refuse to start on
        insecure dev defaults rather than silently degrade.

        "Production" == https PONTJE_PUBLIC_BASE_URL (same signal as cookie_secure).
        Dev (http) and tests (http://testserver) keep today's friendly defaults,
        so local development and the suite are unaffected. Catching these at boot
        also means a bad PONTJE_SECRET_KEY surfaces here, not on the first secret
        decrypt, and an unset one can't quietly mint an ephemeral Fernet key that
        loses every stored secret on the next restart.
        """
        if not self.cookie_secure:
            return  # http dev / tests — friendly defaults are intentional

        problems: list[str] = []
        if self.dev_fake_login:
            problems.append("PONTJE_DEV_FAKE_LOGIN must be off in production")
        if self.session_secret in ("", "dev-only-not-a-secret") or len(self.session_secret) < 16:
            problems.append("PONTJE_SESSION_SECRET must be a strong random value (≥16 chars)")
        if not self.secret_key:
            problems.append("PONTJE_SECRET_KEY must be set to a Fernet key")
        else:
            from cryptography.fernet import Fernet  # local: keep config import-light

            try:
                Fernet(self.secret_key)
            except Exception:  # noqa: BLE001 — any malformed key is a hard fail
                problems.append("PONTJE_SECRET_KEY is not a valid Fernet key")
        if not self.google_client_id:
            problems.append("PONTJE_GOOGLE_CLIENT_ID must be set")
        if not self.google_client_secret:
            problems.append("PONTJE_GOOGLE_CLIENT_SECRET must be set")
        if not self.allowed_email_set:
            problems.append("PONTJE_ALLOWED_EMAILS must list at least one address")

        if problems:
            raise RuntimeError(
                "Refusing to start: insecure production configuration —\n  - "
                + "\n  - ".join(problems)
            )


settings = Settings()
