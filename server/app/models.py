"""SQLModel tables — full schema per PLAN.md §6.

Conventions: timestamps are naive UTC (app.timeutil.utcnow); emails stored
lowercased; string PKs are client-generated UUIDs (devices) or uuid4 hex.
"""

import uuid
from datetime import datetime

from sqlalchemy import Column, ForeignKey, String
from sqlmodel import Field, SQLModel

from app.timeutil import utcnow


def new_id() -> str:
    return uuid.uuid4().hex


class User(SQLModel, table=True):
    __tablename__ = "users"

    id: int | None = Field(default=None, primary_key=True)
    google_sub: str = Field(unique=True, index=True)  # stable OIDC identity key
    email: str = Field(unique=True, index=True)  # lowercased
    name: str | None = None
    picture: str | None = None
    created_at: datetime = Field(default_factory=utcnow)
    last_login: datetime | None = None


class AuthSession(SQLModel, table=True):
    __tablename__ = "auth_sessions"

    id: int | None = Field(default=None, primary_key=True)
    token_hash: str = Field(unique=True, index=True)  # sha256(opaque token)
    user_id: int = Field(
        sa_column=Column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    )
    # "remove device" also revokes its sessions (application logic; SET NULL is
    # just referential safety).
    device_id: str | None = Field(
        default=None, sa_column=Column(String, ForeignKey("devices.id", ondelete="SET NULL"))
    )
    created_via: str = "oauth"  # oauth | device_link | dev
    created_at: datetime = Field(default_factory=utcnow)
    expires_at: datetime  # sliding 30 days
    last_used: datetime | None = None


class DeviceLinkToken(SQLModel, table=True):
    __tablename__ = "device_link_tokens"

    id: int | None = Field(default=None, primary_key=True)
    token_hash: str = Field(unique=True, index=True)
    user_id: int = Field(
        sa_column=Column(ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    )
    created_by_session: int | None = Field(
        default=None,
        sa_column=Column(ForeignKey("auth_sessions.id", ondelete="CASCADE")),
    )
    created_at: datetime = Field(default_factory=utcnow)
    expires_at: datetime  # +60 s
    claimed_at: datetime | None = None  # one-time gate (conditional UPDATE)


class Device(SQLModel, table=True):
    __tablename__ = "devices"

    id: str = Field(primary_key=True)  # client-generated UUID (localStorage)
    user_id: int = Field(foreign_key="users.id", index=True)
    name: str
    platform: str | None = None  # windows | mac | android | linux | other
    last_seen: datetime | None = None
    created_at: datetime = Field(default_factory=utcnow)


class ShareSession(SQLModel, table=True):
    """Cross-user share session (PLAN.md §15). Table name kept as `sessions`."""

    __tablename__ = "sessions"

    id: str = Field(default_factory=new_id, primary_key=True)
    code: str = Field(unique=True, index=True)  # 6 chars, unambiguous alphabet
    owner_id: int = Field(foreign_key="users.id")
    expires_at: datetime  # now + 24 h
    created_at: datetime = Field(default_factory=utcnow)


class SessionMember(SQLModel, table=True):
    __tablename__ = "session_members"

    session_id: str = Field(foreign_key="sessions.id", primary_key=True)
    device_id: str = Field(foreign_key="devices.id", primary_key=True)
    user_id: int = Field(foreign_key="users.id")


class Link(SQLModel, table=True):
    __tablename__ = "links"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True)
    session_id: str | None = Field(default=None, foreign_key="sessions.id")  # NULL = personal
    url: str
    title: str | None = None
    category: str = "other"
    # Optional LLM one-liner (AI feature, gated by settings.ai_enabled).
    # Added post-v1: db.init_db() backfills the column on existing DBs.
    summary: str | None = None
    from_device: str | None = Field(default=None, foreign_key="devices.id")
    created_at: datetime = Field(default_factory=utcnow, index=True)


class Snippet(SQLModel, table=True):
    """Text clips + burn-on-read secrets (PLAN.md §13)."""

    __tablename__ = "snippets"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True)
    session_id: str | None = Field(default=None, foreign_key="sessions.id")
    kind: str = "text"  # text | secret
    content: str  # secret: Fernet ciphertext — NEVER returned in list responses
    from_device: str | None = Field(default=None, foreign_key="devices.id")
    created_at: datetime = Field(default_factory=utcnow, index=True)


class SharedFile(SQLModel, table=True):
    """Pull-able offer while the sharing device is online (PLAN.md §14)."""

    __tablename__ = "shared_files"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True)
    session_id: str | None = Field(default=None, foreign_key="sessions.id")
    file_name: str
    mime: str | None = None
    size_bytes: int | None = None
    category: str = "other"
    from_device: str = Field(foreign_key="devices.id")
    status: str = "active"  # active | stale
    created_at: datetime = Field(default_factory=utcnow, index=True)


class Transfer(SQLModel, table=True):
    """HISTORY ONLY — file bytes are never stored (PLAN.md §6)."""

    __tablename__ = "transfers"

    id: str = Field(default_factory=new_id, primary_key=True)
    user_id: int = Field(foreign_key="users.id", index=True)
    session_id: str | None = Field(default=None, foreign_key="sessions.id")
    file_name: str
    mime: str | None = None
    size_bytes: int | None = None
    category: str = "other"
    from_device: str | None = Field(default=None, foreign_key="devices.id")
    to_device: str | None = Field(default=None, foreign_key="devices.id")
    network_path: str | None = None  # lan | internet | relay
    status: str = "completed"  # completed | failed | rejected | canceled
    created_at: datetime = Field(default_factory=utcnow, index=True)
