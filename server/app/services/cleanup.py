"""Hourly cleanup sweep, run as an asyncio task from the lifespan (PLAN.md §6, §18).

Idempotent, ONE short transaction to keep write contention low.
"""

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import delete, or_, select

from app.db import engine
from app.models import (
    AuthSession,
    DeviceLinkToken,
    Link,
    SessionMember,
    SharedFile,
    ShareSession,
    Snippet,
    Transfer,
)
from app.timeutil import utcnow

logger = logging.getLogger(__name__)

SWEEP_INTERVAL_SECONDS = 3600
RETENTION_HOURS = 48


def sweep_once() -> None:
    """Delete expired rows per PLAN.md §6. Sync — callers use asyncio.to_thread."""
    now = utcnow()
    cutoff = now - timedelta(hours=RETENTION_HOURS)
    expired_session_ids = select(ShareSession.id).where(ShareSession.expires_at < now)

    deleted = 0
    with engine.begin() as conn:
        # 48 h retention for content metadata.
        for model in (Link, Snippet, SharedFile, Transfer):
            deleted += conn.execute(delete(model).where(model.created_at < cutoff)).rowcount
        # Rows scoped to an expired session must go before the session itself
        # (links/snippets/shared_files/transfers hold FKs onto sessions, and a
        # 24 h session expires before its rows hit the 48 h cutoff).
        for model in (Link, Snippet, SharedFile, Transfer):
            deleted += conn.execute(
                delete(model).where(model.session_id.in_(expired_session_ids))
            ).rowcount
        deleted += conn.execute(
            delete(SessionMember).where(SessionMember.session_id.in_(expired_session_ids))
        ).rowcount
        deleted += conn.execute(
            delete(ShareSession).where(ShareSession.expires_at < now)
        ).rowcount
        deleted += conn.execute(delete(AuthSession).where(AuthSession.expires_at < now)).rowcount
        # Device-link tokens: expired OR already claimed (one-time use).
        deleted += conn.execute(
            delete(DeviceLinkToken).where(
                or_(
                    DeviceLinkToken.expires_at < now,
                    DeviceLinkToken.claimed_at.is_not(None),  # type: ignore[union-attr]
                )
            )
        ).rowcount

    if deleted:
        logger.info("cleanup sweep removed %d expired rows", deleted)


async def sweeper_loop() -> None:
    while True:
        try:
            await asyncio.to_thread(sweep_once)
        except Exception:
            logger.exception("cleanup sweep failed")
        await asyncio.sleep(SWEEP_INTERVAL_SECONDS)
