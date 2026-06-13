"""QR device-link tokens (PLAN.md §7.3): 60 s TTL, sha256 at rest, one-time atomic claim."""

import secrets
from datetime import timedelta

from sqlalchemy import update
from sqlmodel import Session, select

from app.auth.sessions import hash_token
from app.models import DeviceLinkToken
from app.timeutil import utcnow

LINK_TTL = timedelta(seconds=60)


def mint_link_token(
    db: Session, user_id: int, created_by_session: int | None
) -> tuple[str, DeviceLinkToken]:
    """Mint a one-time link token; only its sha256 is stored."""
    token = secrets.token_urlsafe(32)
    row = DeviceLinkToken(
        token_hash=hash_token(token),
        user_id=user_id,
        created_by_session=created_by_session,
        expires_at=utcnow() + LINK_TTL,
    )
    db.add(row)
    db.commit()
    db.refresh(row)
    return token, row


def claim_link_token(db: Session, token: str) -> int | None:
    """Atomic one-time claim (PLAN.md §7.3).

    A single conditional UPDATE is the race guard: of N concurrent claims
    exactly one sees rowcount 1. Returns the owning user_id, or None when the
    token is unknown, expired, or already claimed (callers answer 410).
    """
    now = utcnow()
    token_hash = hash_token(token)
    result = db.execute(
        update(DeviceLinkToken)
        .where(
            DeviceLinkToken.token_hash == token_hash,
            DeviceLinkToken.claimed_at.is_(None),
            DeviceLinkToken.expires_at > now,
        )
        .values(claimed_at=now)
    )
    db.commit()
    if result.rowcount != 1:
        return None
    row = db.exec(select(DeviceLinkToken).where(DeviceLinkToken.token_hash == token_hash)).one()
    return row.user_id
