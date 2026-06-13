"""Links CRUD + async enrichment kick-off (PLAN.md §12, session scope §15).

Sync endpoints (threadpool): WS broadcasts go through app.loop, and the
enrichment coroutine is scheduled onto the main loop via loop.submit.
Session-scoped links (session_id set) require the calling DEVICE to be a
member and broadcast to all member devices across users.
"""

from typing import Any
from urllib.parse import urlparse

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app import loop
from app.auth.deps import AuthContext, current_auth
from app.db import get_db
from app.models import Link
from app.services import session_scope
from app.services.categorize import categorize
from app.services.enrichment import enrich_link, link_payload
from app.ws import messages

router = APIRouter(prefix="/links", tags=["links"])


class LinkOut(BaseModel):
    id: str
    url: str
    title: str | None
    category: str
    summary: str | None = None  # optional LLM one-liner (settings.ai_enabled)
    from_device: str | None
    session_id: str | None = None
    created_at: str


class LinkCreateIn(BaseModel):
    url: str
    session_id: str | None = None


def _payload(link: Link) -> dict[str, Any]:
    # link_payload lives in enrichment.py (kept frozen) and predates session
    # scoping — the session_id rides along here so clients can group by scope.
    return {**link_payload(link), "session_id": link.session_id}


def _broadcast(link_session_id: str | None, user_id: int, msg: dict[str, Any]) -> None:
    """Session links go to all member devices across users; personal links to
    the owner's devices (PLAN.md §15)."""
    if link_session_id is not None:
        session_scope.broadcast_to_session_devices(link_session_id, msg)
    else:
        loop.broadcast_to_user(user_id, msg)


@router.post("")
def create_link(
    body: LinkCreateIn,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> LinkOut:
    url = body.url.strip()
    parsed = urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise HTTPException(status_code=422, detail="invalid_url")
    if body.session_id is not None:
        # 404 unknown / 410 expired / 403 when this device isn't a member.
        session_scope.require_membership(db, body.session_id, auth.session.device_id)

    # Insert immediately with the hostname as a placeholder title. Host-rule
    # categorization needs no network, so it happens HERE — enrichment only
    # refines it (og:type) along with the real title (link-updated). This way
    # hosts that block bots or fail to fetch still categorize correctly.
    link = Link(
        user_id=auth.user.id,
        session_id=body.session_id,
        url=url,
        title=parsed.hostname,
        category=categorize(parsed.hostname),
        from_device=auth.session.device_id,
    )
    db.add(link)
    db.commit()
    db.refresh(link)

    payload = _payload(link)
    _broadcast(link.session_id, auth.user.id, messages.link_new(payload))
    loop.submit(enrich_link(link.id))
    return LinkOut(**payload)


@router.get("")
def list_links(
    session: str | None = None,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> list[LinkOut]:
    if session is not None:
        # A member sees the whole shared list (every member's posts).
        session_scope.require_membership(db, session, auth.session.device_id)
        rows = db.exec(
            select(Link)
            .where(Link.session_id == session)
            .order_by(col(Link.created_at).desc(), col(Link.id).desc())
        ).all()
    else:
        rows = db.exec(
            select(Link)
            .where(Link.user_id == auth.user.id, col(Link.session_id).is_(None))
            .order_by(col(Link.created_at).desc(), col(Link.id).desc())
        ).all()
    return [LinkOut(**_payload(row)) for row in rows]


@router.delete("/{link_id}", status_code=204)
def delete_link(
    link_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> None:
    link = db.get(Link, link_id)
    # Creator-only, also within a session (PLAN.md §12).
    if link is None or link.user_id != auth.user.id:
        raise HTTPException(status_code=404, detail="link_not_found")
    session_id = link.session_id
    db.delete(link)
    db.commit()
    _broadcast(session_id, auth.user.id, messages.link_deleted(link_id))
