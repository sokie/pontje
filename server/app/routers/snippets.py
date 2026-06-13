"""Text snippets + burn-on-read secrets (PLAN.md §13, session scope §15).

Secret content is Fernet-encrypted at rest and NEVER appears in list/create
responses or WS payloads — only the one-shot reveal returns it. The reveal is
an atomic DELETE … RETURNING on its own connection: exactly one concurrent
caller wins; everyone else gets 410. For session-scoped snippets the reveal/
delete authorization is "creator OR member of that active session", folded
into the same atomic statement so the burn race guard still holds.
"""

from typing import Any, Literal

from cryptography.fernet import InvalidToken
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text as sql_text
from sqlmodel import Session, col, select

from app import loop, ratelimit
from app.auth.deps import AuthContext, current_auth
from app.db import engine, get_db
from app.models import Snippet
from app.services import secretbox, session_scope
from app.timeutil import utcnow
from app.ws import messages

router = APIRouter(prefix="/snippets", tags=["snippets"])


class SnippetOut(BaseModel):
    id: str
    kind: str
    content: str | None  # always None for secrets — never the ciphertext either
    from_device: str | None
    session_id: str | None = None
    created_at: str


def snippet_payload(snippet: Snippet) -> dict[str, Any]:
    """Serialized snippet for REST + WS — redacts secret content."""
    return {
        "id": snippet.id,
        "kind": snippet.kind,
        "content": None if snippet.kind == "secret" else snippet.content,
        "from_device": snippet.from_device,
        "session_id": snippet.session_id,
        "created_at": snippet.created_at.isoformat(),
    }


def _broadcast(session_id: str | None, user_id: int, msg: dict[str, Any]) -> None:
    """Session snippets go to all member devices across users (PLAN.md §15)."""
    if session_id is not None:
        session_scope.broadcast_to_session_devices(session_id, msg)
    else:
        loop.broadcast_to_user(user_id, msg)


def _can_touch(db: Session, snippet: Snippet, auth: AuthContext) -> bool:
    """Creator OR active-session member (for session-scoped snippets)."""
    if snippet.user_id == auth.user.id:
        return True
    if snippet.session_id is None:
        return False
    return session_scope.is_active_member(db, snippet.session_id, auth.session.device_id)


class SnippetCreateIn(BaseModel):
    content: str = Field(min_length=1)
    kind: Literal["text", "secret"] = "text"
    session_id: str | None = None


@router.post("")
def create_snippet(
    body: SnippetCreateIn,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> SnippetOut:
    if body.session_id is not None:
        # 404 unknown / 410 expired / 403 when this device isn't a member.
        session_scope.require_membership(db, body.session_id, auth.session.device_id)
    snippet = Snippet(
        user_id=auth.user.id,
        session_id=body.session_id,
        kind=body.kind,
        content=secretbox.encrypt(body.content) if body.kind == "secret" else body.content,
        from_device=auth.session.device_id,
    )
    db.add(snippet)
    db.commit()
    db.refresh(snippet)

    payload = snippet_payload(snippet)
    _broadcast(snippet.session_id, auth.user.id, messages.snippet_new(payload))
    return SnippetOut(**payload)


@router.get("")
def list_snippets(
    session: str | None = None,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> list[SnippetOut]:
    if session is not None:
        # A member sees the whole shared list (every member's posts).
        session_scope.require_membership(db, session, auth.session.device_id)
        rows = db.exec(
            select(Snippet)
            .where(Snippet.session_id == session)
            .order_by(col(Snippet.created_at).desc(), col(Snippet.id).desc())
        ).all()
    else:
        rows = db.exec(
            select(Snippet)
            .where(Snippet.user_id == auth.user.id, col(Snippet.session_id).is_(None))
            .order_by(col(Snippet.created_at).desc(), col(Snippet.id).desc())
        ).all()
    return [SnippetOut(**snippet_payload(row)) for row in rows]


class RevealOut(BaseModel):
    content: str


@router.post(
    "/{snippet_id}/reveal",
    # Defense-in-depth (PLAN.md §23): reveal is already authorized (creator OR
    # active-session member) over an unguessable uuid4, so this only caps
    # brute-force enumeration — generous enough never to bite a human's clicks.
    dependencies=[Depends(ratelimit.limit_by_user("snippet-reveal", 30, 60))],
)
def reveal_snippet(
    snippet_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> RevealOut:
    # Atomic burn: the DELETE is the first statement of a fresh transaction on
    # its own connection, so two concurrent reveals serialize on SQLite's write
    # lock and exactly one gets the row back (PLAN.md §13). The session-member
    # authorization is folded INTO the statement — splitting it into a separate
    # check would reopen the race. Timestamps are naive-UTC ISO strings in
    # SQLite, so the expiry comparison binds utcnow() the same way.
    with engine.begin() as conn:
        row = conn.execute(
            sql_text(
                "DELETE FROM snippets"
                " WHERE id = :id AND kind = 'secret'"
                "   AND (user_id = :uid"
                "        OR (session_id IS NOT NULL AND EXISTS ("
                "             SELECT 1 FROM session_members sm"
                "             JOIN sessions s ON s.id = sm.session_id"
                "             WHERE sm.session_id = snippets.session_id"
                "               AND sm.device_id = :did"
                "               AND s.expires_at > :now)))"
                " RETURNING content, session_id"
            ),
            {
                "id": snippet_id,
                "uid": auth.user.id,
                "did": auth.session.device_id or "",
                # Match SQLAlchemy's SQLite DATETIME format exactly ("YYYY-MM-DD
                # HH:MM:SS.ffffff") so the string comparison is sound.
                "now": utcnow().strftime("%Y-%m-%d %H:%M:%S.%f"),
            },
        ).first()

    if row is None:
        leftover = db.get(Snippet, snippet_id)
        if leftover is not None and leftover.kind == "text" and _can_touch(db, leftover, auth):
            raise HTTPException(status_code=400, detail="not_a_secret")
        raise HTTPException(status_code=410, detail="secret_gone")

    content, session_id = row
    # The row is gone either way — every device drops it, tagged with who read it.
    _broadcast(
        session_id,
        auth.user.id,
        messages.snippet_deleted(snippet_id, revealed_by=auth.session.device_id),
    )
    try:
        return RevealOut(content=secretbox.decrypt(content))
    except InvalidToken:
        # Burned, but the ciphertext predates the current key (dev restarts).
        raise HTTPException(status_code=410, detail="secret_unrecoverable") from None


@router.delete("/{snippet_id}", status_code=204)
def delete_snippet(
    snippet_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> None:
    snippet = db.get(Snippet, snippet_id)
    if snippet is None or not _can_touch(db, snippet, auth):
        raise HTTPException(status_code=404, detail="snippet_not_found")
    session_id = snippet.session_id
    db.delete(snippet)
    db.commit()
    _broadcast(session_id, auth.user.id, messages.snippet_deleted(snippet_id))
