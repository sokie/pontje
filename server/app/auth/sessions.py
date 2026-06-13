"""Opaque session tokens: sha256 at rest, 30-day sliding expiry (PLAN.md §7.1)."""

import hashlib
import secrets
from datetime import timedelta

from fastapi import Response
from sqlmodel import Session, select

from app.config import settings
from app.models import AuthSession
from app.timeutil import utcnow

COOKIE_NAME = "pontje_session"
SESSION_TTL = timedelta(days=30)
# Slide expiry at most once an hour to avoid a write per request.
SLIDE_EVERY = timedelta(hours=1)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def mint_session(
    db: Session,
    user_id: int,
    device_id: str | None = None,
    created_via: str = "oauth",
) -> tuple[str, AuthSession]:
    token = secrets.token_urlsafe(32)
    sess = AuthSession(
        token_hash=hash_token(token),
        user_id=user_id,
        device_id=device_id,
        created_via=created_via,
        expires_at=utcnow() + SESSION_TTL,
        last_used=utcnow(),
    )
    db.add(sess)
    db.commit()
    db.refresh(sess)
    return token, sess


def resolve_session(db: Session, token: str) -> AuthSession | None:
    sess = db.exec(
        select(AuthSession).where(AuthSession.token_hash == hash_token(token))
    ).first()
    now = utcnow()
    if sess is None or sess.expires_at <= now:
        return None
    if sess.last_used is None or now - sess.last_used >= SLIDE_EVERY:
        sess.last_used = now
        sess.expires_at = now + SESSION_TTL
        db.add(sess)
        db.commit()
        db.refresh(sess)
    return sess


def revoke_session(db: Session, sess: AuthSession) -> None:
    db.delete(sess)
    db.commit()


def set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        COOKIE_NAME,
        token,
        max_age=int(SESSION_TTL.total_seconds()),
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",  # Lax, not Strict — the OAuth callback is cross-site (PLAN.md §7.1)
        path="/",
    )


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(COOKIE_NAME, path="/")
