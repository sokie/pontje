"""Cross-user share sessions (PLAN.md §15).

Create/join with a 6-char code (unambiguous alphabet), 24 h TTL. Membership is
DEVICE-scoped: only the joined device is exposed to the other party — never the
whole fleet — so create/join require the auth session to be bound to a device,
and `current` answers for the calling device. One active session per user.
Every membership change pushes `session-state` to member devices only.
"""

import secrets
from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import delete
from sqlmodel import Session, select

from app.auth.deps import AuthContext, current_auth
from app.db import get_db
from app.models import Link, SessionMember, SharedFile, ShareSession, Snippet, Transfer
from app.services import session_scope
from app.timeutil import utcnow

router = APIRouter(prefix="/sessions", tags=["sessions"])

CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # no 0/O/1/I (PLAN.md §15)
CODE_LENGTH = 6
SESSION_TTL = timedelta(hours=24)


class SessionOut(BaseModel):
    id: str
    code: str
    owner_id: int
    expires_at: str
    created_at: str


class SessionMemberOut(BaseModel):
    device_id: str
    device_name: str
    user_name: str
    user_id: int
    online: bool
    is_self: bool


class SessionStateOut(BaseModel):
    session: SessionOut | None
    members: list[SessionMemberOut]


def generate_code(db: Session) -> str:
    """6 chars from the unambiguous alphabet, unique across ALL session rows
    (expired ones keep their code until swept — the unique index covers them)."""
    for _ in range(32):
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        if db.exec(select(ShareSession).where(ShareSession.code == code)).first() is None:
            return code
    raise HTTPException(status_code=500, detail="code_generation_failed")  # pragma: no cover


def _require_device(auth: AuthContext) -> str:
    # A session member must be addressable as a WebRTC peer — an auth session
    # without a bound device has nothing the other party could ever talk to.
    if auth.session.device_id is None:
        raise HTTPException(status_code=400, detail="no_device_bound")
    return auth.session.device_id


def _state_out(db: Session, session: ShareSession, viewer_device_id: str) -> SessionStateOut:
    members = session_scope.load_members(db, session.id)
    return SessionStateOut(
        session=SessionOut(**session_scope.session_dict(session)),
        members=[
            SessionMemberOut(**m)
            for m in session_scope.tailored_members(members, viewer_device_id)
        ],
    )


@router.post("")
def create_session(
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> SessionStateOut:
    device_id = _require_device(auth)
    if session_scope.active_session_for_user(db, auth.user.id) is not None:
        raise HTTPException(status_code=409, detail="session_already_active")
    session = ShareSession(
        code=generate_code(db), owner_id=auth.user.id, expires_at=utcnow() + SESSION_TTL
    )
    db.add(session)
    # Flush first: without Relationship() objects the unit of work won't order
    # the sessions INSERT before the member row that references it.
    db.flush()
    # The creating device auto-joins as the first member (PLAN.md §15).
    db.add(SessionMember(session_id=session.id, user_id=auth.user.id, device_id=device_id))
    db.commit()
    db.refresh(session)
    session_scope.broadcast_session_state(session.id)
    return _state_out(db, session, device_id)


class SessionJoinIn(BaseModel):
    code: str


@router.post("/join")
def join_session(
    body: SessionJoinIn,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> SessionStateOut:
    device_id = _require_device(auth)
    code = body.code.strip().upper()
    session = db.exec(select(ShareSession).where(ShareSession.code == code)).first()
    if session is None:
        raise HTTPException(status_code=404, detail="session_not_found")
    if not session_scope.is_active(session):
        raise HTTPException(status_code=410, detail="session_expired")
    if db.get(SessionMember, (session.id, device_id)) is not None:
        return _state_out(db, session, device_id)  # idempotent re-join, same device
    if session_scope.active_session_for_user(db, auth.user.id) is not None:
        raise HTTPException(status_code=409, detail="session_already_active")
    db.add(SessionMember(session_id=session.id, user_id=auth.user.id, device_id=device_id))
    db.commit()
    session_scope.broadcast_session_state(session.id)
    return _state_out(db, session, device_id)


@router.get("/current")
def get_current_session(
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> SessionStateOut:
    # Device-scoped on purpose: a member's OTHER devices must not see the
    # session (PLAN.md §15) — REST agrees with the WS broadcast targeting.
    device_id = auth.session.device_id
    session = session_scope.active_session_for_device(db, device_id) if device_id else None
    if device_id is None or session is None:
        return SessionStateOut(session=None, members=[])
    return _state_out(db, session, device_id)


def _end_session(db: Session, session: ShareSession) -> None:
    """Delete members + session and tell every (former) member device.

    Session-scoped content holds FKs onto the session row, so it goes first —
    same order as the sweeper. Ending the session ends its shared scope.
    """
    targets = [
        (m.user_id, m.device_id)
        for m in db.exec(
            select(SessionMember).where(SessionMember.session_id == session.id)
        ).all()
    ]
    for model in (Link, Snippet, SharedFile, Transfer):
        db.execute(delete(model).where(model.session_id == session.id))
    db.execute(delete(SessionMember).where(SessionMember.session_id == session.id))
    db.delete(session)
    db.commit()
    session_scope.broadcast_session_ended(targets)


@router.post("/{session_id}/leave", status_code=204)
def leave_session(
    session_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> None:
    session = db.get(ShareSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session_not_found")
    mine = db.exec(
        select(SessionMember).where(
            SessionMember.session_id == session_id, SessionMember.user_id == auth.user.id
        )
    ).all()
    if not mine:
        raise HTTPException(status_code=404, detail="session_not_found")
    if session.owner_id == auth.user.id:
        _end_session(db, session)  # the owner leaving ends it for everyone
        return
    targets = [(m.user_id, m.device_id) for m in mine]
    for member in mine:
        db.delete(member)
    db.commit()
    session_scope.broadcast_session_ended(targets)  # my removed device(s)
    session_scope.broadcast_session_state(session_id)  # everyone still in


@router.delete("/{session_id}", status_code=204)
def end_session(
    session_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> None:
    session = db.get(ShareSession, session_id)
    # 404 for non-owners too — don't leak session existence.
    if session is None or session.owner_id != auth.user.id:
        raise HTTPException(status_code=404, detail="session_not_found")
    _end_session(db, session)
