"""/ws endpoint: authenticate on upgrade, presence bookkeeping (PLAN.md §8, §18).

Foundation skeleton — Phase 1 adds the rtc-* relay with authorization.
"""

import asyncio
import contextlib
import logging
from typing import Any
from urllib.parse import urlsplit

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlmodel import Session, col, select

from app.auth.sessions import COOKIE_NAME, resolve_session
from app.config import settings
from app.db import engine
from app.models import AuthSession, Device, SessionMember, ShareSession
from app.services import session_scope
from app.timeutil import utcnow
from app.ws import messages
from app.ws.presence import hub

router = APIRouter()
logger = logging.getLogger(__name__)

CLOSE_UNAUTHENTICATED = 4401
CLOSE_UNKNOWN_DEVICE = 4404

# Keep strong refs to fire-and-forget tasks (create_task holds only a weakref).
_background_tasks: set[asyncio.Task] = set()


def _resolve_ws_auth(token: str) -> AuthSession | None:
    with Session(engine) as db:
        return resolve_session(db, token)


def _load_user_devices(user_id: int) -> list[Device]:
    with Session(engine) as db:
        return list(db.exec(select(Device).where(Device.user_id == user_id)))


def _device_owned(device_id: str, user_id: int) -> bool:
    with Session(engine) as db:
        device = db.get(Device, device_id)
        return device is not None and device.user_id == user_id


def _relay_target_owner(sender_id: str, target_id: str, user_id: int) -> int | None:
    """The target device's owner iff relaying is authorized, else None.

    Authorization rule (PLAN.md §9): the target belongs to the same user, OR
    sender and target devices are both members of the same NON-EXPIRED session.
    """
    with Session(engine) as db:
        target = db.get(Device, target_id)
        if target is None:
            return None
        if target.user_id == user_id:
            return target.user_id
        shared = db.exec(
            select(SessionMember.session_id).where(
                SessionMember.device_id == sender_id,
                col(SessionMember.session_id).in_(
                    select(SessionMember.session_id).where(
                        SessionMember.device_id == target_id
                    )
                ),
                col(SessionMember.session_id).in_(
                    select(ShareSession.id).where(ShareSession.expires_at > utcnow())
                ),
            )
        ).first()
        return target.user_id if shared is not None else None


def _touch_last_seen(device_id: str) -> str | None:
    with Session(engine) as db:
        device = db.get(Device, device_id)
        if device is None:
            return None
        device.last_seen = utcnow()
        db.add(device)
        db.commit()
        return device.last_seen.isoformat()


def _extract_ws_token(websocket: WebSocket) -> str | None:
    header = websocket.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return websocket.cookies.get(COOKIE_NAME)


def _origin_allowed(origin: str) -> bool:
    """True iff the WS handshake Origin matches PONTJE_PUBLIC_BASE_URL's origin."""
    want, got = urlsplit(settings.public_base_url), urlsplit(origin)
    return (want.scheme, want.hostname, want.port) == (got.scheme, got.hostname, got.port)


def _reject_cross_origin(websocket: WebSocket) -> bool:
    """CSWSH guard (PLAN.md §23): a browser WebSocket can't carry our X-Pontje
    CSRF header, so the Origin check is the correct cross-site defense for the
    cookie-authed socket. Enforced ONLY in production (cookie_secure): an absent
    Origin (native Bearer clients like OkHttp) is allowed, and dev over http
    LAN-IP is skipped so phone testing keeps working.
    """
    if not settings.cookie_secure:
        return False
    origin = websocket.headers.get("origin")
    return bool(origin) and not _origin_allowed(origin)


async def peers_snapshot(user_id: int) -> dict[str, Any]:
    devices = await asyncio.to_thread(_load_user_devices, user_id)
    online = hub.online_device_ids(user_id)
    return messages.peers(
        [
            {
                "deviceId": d.id,
                "name": d.name,
                "platform": d.platform,
                "online": d.id in online,
                "lastSeen": d.last_seen.isoformat() if d.last_seen else None,
            }
            for d in devices
        ]
    )


RTC_TYPES = frozenset({"rtc-offer", "rtc-answer", "rtc-ice"})


async def dispatch(user_id: int, device_id: str, msg: dict[str, Any]) -> None:
    """Handle one client→server message: rtc-* relay with authorization (PLAN.md §9)."""
    if msg.get("t") in RTC_TYPES:
        await _relay_rtc(user_id, device_id, msg)
        return
    err = messages.error("unknown_type", f"unhandled message type {msg.get('t')!r}")
    await hub.send_to_device(user_id, device_id, err)


async def _relay_rtc(user_id: int, sender_id: str, msg: dict[str, Any]) -> None:
    """Relay an rtc-* frame iff the target is the same user's device OR shares
    a non-expired session with the sender device (PLAN.md §9).

    The server is a router with authorization — it never inspects SDP/ICE
    contents. On the session path the frame is delivered under the target's
    OWN user id (the presence registry is keyed per user).
    """
    target = msg.get("to")
    if msg.get("from") != sender_id:
        err = messages.error("invalid_from", "'from' must be your own device id")
        await hub.send_to_device(user_id, sender_id, err)
        return
    if not isinstance(target, str) or not target:
        err = messages.error("invalid_target", "missing 'to' device id")
        await hub.send_to_device(user_id, sender_id, err)
        return
    owner_id = await asyncio.to_thread(_relay_target_owner, sender_id, target, user_id)
    if owner_id is None:
        # Message kept verbatim — the web engine parses it to fail the right peer.
        err = messages.error("unauthorized_target", f"device {target} is not yours")
        await hub.send_to_device(user_id, sender_id, err)
        return
    if not await hub.send_to_device(owner_id, target, msg):
        err = messages.error("target_offline", f"device {target} is offline")
        await hub.send_to_device(user_id, sender_id, err)


@router.websocket("/ws")
async def ws_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()

    if _reject_cross_origin(websocket):
        await websocket.close(code=CLOSE_UNAUTHENTICATED)
        return

    token = _extract_ws_token(websocket)
    device_id = websocket.query_params.get("device")
    auth = await asyncio.to_thread(_resolve_ws_auth, token) if token else None
    if auth is None or not device_id:
        await websocket.close(code=CLOSE_UNAUTHENTICATED)
        return
    user_id = auth.user_id
    if not await asyncio.to_thread(_device_owned, device_id, user_id):
        await websocket.close(code=CLOSE_UNKNOWN_DEVICE)
        return

    old = hub.register(user_id, device_id, websocket)
    if old is not None:
        with contextlib.suppress(Exception):
            await old.close(code=1000)

    await websocket.send_json(await peers_snapshot(user_id))
    await hub.send_to_user(user_id, messages.peer_online(device_id), exclude_device=device_id)
    # Session presence (PLAN.md §15): if this device is in an active session,
    # every member device gets a refreshed state — the online dot flips live.
    await session_scope.notify_device_session(device_id)

    try:
        while True:
            msg = await websocket.receive_json()
            if isinstance(msg, dict):
                await dispatch(user_id, device_id, msg)
    except WebSocketDisconnect:
        pass
    finally:
        # Unregister synchronously (no await — safe under cancellation), then
        # announce offline from a FRESH task: the handler task itself may be
        # cancelled during disconnect, which would silently skip any await here.
        if hub.unregister(user_id, device_id, websocket):
            task = asyncio.get_running_loop().create_task(_announce_offline(user_id, device_id))
            _background_tasks.add(task)
            task.add_done_callback(_background_tasks.discard)


async def _announce_offline(user_id: int, device_id: str) -> None:
    try:
        last_seen = await asyncio.to_thread(_touch_last_seen, device_id)
        await hub.send_to_user(user_id, messages.peer_offline(device_id, last_seen))
        # After last_seen is written: flip this device's dot on every session
        # member's card (PLAN.md §15).
        await session_scope.notify_device_session(device_id)
    except Exception:
        logger.exception("failed to announce peer-offline for %s", device_id)
