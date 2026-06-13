"""Cross-user share-session scope helpers (PLAN.md §15).

One place for: session/member serialization, membership + one-active-session
checks, and the WS fan-outs that go to member DEVICES only — a member's other
devices must never see session traffic. Used by the sessions router, the
links/snippets session scoping, the WS presence hooks, and enrichment's
link-updated broadcast.

Sync helpers take a Session and run in the threadpool (routers) or via
asyncio.to_thread; `push_*` coroutines run on the main loop; `broadcast_*`
wrappers are the thread-safe entry points for sync endpoint code.
"""

import asyncio
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session, col, select

from app import loop
from app.db import engine
from app.models import Device, Link, SessionMember, ShareSession, User
from app.timeutil import utcnow
from app.ws import messages
from app.ws.presence import hub


def is_active(session: ShareSession) -> bool:
    return session.expires_at > utcnow()


def session_dict(session: ShareSession) -> dict[str, Any]:
    """Serialized session — shared by REST responses and WS session-state."""
    return {
        "id": session.id,
        "code": session.code,
        "owner_id": session.owner_id,
        "expires_at": session.expires_at.isoformat(),
        "created_at": session.created_at.isoformat(),
    }


def load_members(db: Session, session_id: str) -> list[dict[str, Any]]:
    """Member entries WITHOUT is_self — callers tailor that per viewing device.

    user_name falls back to the email local-part; online comes from the
    presence hub (reading it from the threadpool matches devices.py).
    """
    rows = db.exec(
        select(SessionMember, Device, User)
        .join(Device, col(Device.id) == col(SessionMember.device_id))
        .join(User, col(User.id) == col(SessionMember.user_id))
        .where(SessionMember.session_id == session_id)
    ).all()
    return [
        {
            "device_id": member.device_id,
            "device_name": device.name,
            "user_name": user.name or user.email.split("@")[0],
            "user_id": member.user_id,
            "online": hub.is_online(member.user_id, member.device_id),
        }
        for member, device, user in rows
    ]


def tailored_members(members: list[dict[str, Any]], device_id: str | None) -> list[dict[str, Any]]:
    """is_self is relative to the device LOOKING at the list."""
    return [{**m, "is_self": m["device_id"] == device_id} for m in members]


def active_session_for_user(db: Session, user_id: int) -> ShareSession | None:
    """Any non-expired session ANY of the user's devices is a member of —
    the one-active-session rule checks user-wide (PLAN.md §15)."""
    return db.exec(
        select(ShareSession)
        .join(SessionMember, col(SessionMember.session_id) == col(ShareSession.id))
        .where(SessionMember.user_id == user_id, ShareSession.expires_at > utcnow())
    ).first()


def active_session_for_device(db: Session, device_id: str) -> ShareSession | None:
    """The non-expired session THIS device is a member of (exposure is
    device-scoped: a member's other devices don't see the session)."""
    return db.exec(
        select(ShareSession)
        .join(SessionMember, col(SessionMember.session_id) == col(ShareSession.id))
        .where(SessionMember.device_id == device_id, ShareSession.expires_at > utcnow())
    ).first()


def is_active_member(db: Session, session_id: str, device_id: str | None) -> bool:
    if device_id is None:
        return False
    session = db.get(ShareSession, session_id)
    if session is None or not is_active(session):
        return False
    return db.get(SessionMember, (session_id, device_id)) is not None


def require_membership(db: Session, session_id: str, device_id: str | None) -> ShareSession:
    """Shared guard for session-scoped posting/listing (links, snippets):
    404 unknown id, 410 expired, 403 when the calling DEVICE isn't a member."""
    session = db.get(ShareSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="session_not_found")
    if not is_active(session):
        raise HTTPException(status_code=410, detail="session_expired")
    if device_id is None or db.get(SessionMember, (session_id, device_id)) is None:
        raise HTTPException(status_code=403, detail="not_a_session_member")
    return session


# ---------------------------------------------------------------------------
# WS fan-out to member devices (and ONLY member devices)


def _load_state(session_id: str) -> tuple[dict[str, Any], list[dict[str, Any]]] | None:
    with Session(engine) as db:
        session = db.get(ShareSession, session_id)
        if session is None or not is_active(session):
            return None
        return session_dict(session), load_members(db, session.id)


def _load_member_targets(session_id: str) -> list[tuple[int, str]]:
    with Session(engine) as db:
        rows = db.exec(
            select(SessionMember).where(SessionMember.session_id == session_id)
        ).all()
        return [(m.user_id, m.device_id) for m in rows]


async def push_session_state(session_id: str) -> None:
    """Refreshed session-state to every member device, is_self tailored per
    receiver. A gone/expired session pushes nothing — use push_session_ended
    with the captured member targets for that."""
    state = await asyncio.to_thread(_load_state, session_id)
    if state is None:
        return
    sdict, members = state
    for m in members:
        payload = messages.session_state(sdict, tailored_members(members, m["device_id"]))
        await hub.send_to_device(m["user_id"], m["device_id"], payload)


async def push_session_ended(targets: list[tuple[int, str]]) -> None:
    payload = messages.session_state(None, [])
    for user_id, device_id in targets:
        await hub.send_to_device(user_id, device_id, payload)


async def push_to_session_devices(session_id: str, payload: dict[str, Any]) -> None:
    """One payload to every member device across users (link/snippet events)."""
    for user_id, device_id in await asyncio.to_thread(_load_member_targets, session_id):
        await hub.send_to_device(user_id, device_id, payload)


# Thread-safe wrappers for sync (threadpool) endpoint code.


def broadcast_session_state(session_id: str) -> None:
    loop.submit(push_session_state(session_id))


def broadcast_session_ended(targets: list[tuple[int, str]]) -> None:
    loop.submit(push_session_ended(targets))


def broadcast_to_session_devices(session_id: str, payload: dict[str, Any]) -> None:
    loop.submit(push_to_session_devices(session_id, payload))


# ---------------------------------------------------------------------------
# Presence + enrichment hooks (called from the event loop)


def _active_session_id_for_device(device_id: str) -> str | None:
    with Session(engine) as db:
        session = active_session_for_device(db, device_id)
        return session.id if session else None


async def notify_device_session(device_id: str) -> None:
    """WS connect/disconnect hook: if the device is a session member, push the
    refreshed state (online flags) to all member devices."""
    session_id = await asyncio.to_thread(_active_session_id_for_device, device_id)
    if session_id is not None:
        await push_session_state(session_id)


def _link_session_id(link_id: str) -> str | None:
    with Session(engine) as db:
        link = db.get(Link, link_id)
        return link.session_id if link else None


async def send_link_updated(user_id: int, payload: dict[str, Any]) -> None:
    """Enrichment's link-updated broadcast: session links fan out to member
    devices across users; personal links to the owner's devices as before."""
    session_id = await asyncio.to_thread(_link_session_id, str(payload["id"]))
    msg = messages.link_updated({**payload, "session_id": session_id})
    if session_id is None:
        await hub.send_to_user(user_id, msg)
    else:
        await push_to_session_devices(session_id, msg)
