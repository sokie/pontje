"""Devices: list / register / rename / delete (PLAN.md §8)."""

import contextlib

from fastapi import APIRouter, Depends, HTTPException, WebSocket
from pydantic import BaseModel, Field
from sqlalchemy import delete, update
from sqlmodel import Session, select

from app import loop as loop_bridge
from app.auth.deps import AuthContext, current_auth
from app.db import get_db
from app.models import AuthSession, Device, Link, SessionMember, SharedFile, Snippet, Transfer
from app.timeutil import utcnow
from app.ws import messages
from app.ws.handler import peers_snapshot
from app.ws.presence import hub

router = APIRouter(prefix="/devices", tags=["devices"])


class DeviceOut(BaseModel):
    id: str
    name: str
    platform: str | None
    online: bool
    last_seen: str | None


def to_device_out(device: Device, user_id: int) -> DeviceOut:
    return DeviceOut(
        id=device.id,
        name=device.name,
        platform=device.platform,
        online=hub.is_online(user_id, device.id),
        last_seen=device.last_seen.isoformat() if device.last_seen else None,
    )


def broadcast_peers_refresh(user_id: int) -> None:
    """Push a fresh `peers` snapshot to the user's sockets after device changes.

    Reuses the existing protocol message — clients already replace their list on
    `peers`, so registrations/renames/removals show up live without a reload.
    """

    async def _send() -> None:
        await hub.send_to_user(user_id, await peers_snapshot(user_id))

    loop_bridge.submit(_send())


@router.get("")
def list_devices(
    auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> list[DeviceOut]:
    devices = db.exec(select(Device).where(Device.user_id == auth.user.id)).all()
    return [to_device_out(d, auth.user.id) for d in devices]


class DeviceRegisterIn(BaseModel):
    id: str
    name: str
    platform: str | None = None


@router.post("")
def register_device(
    body: DeviceRegisterIn,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> DeviceOut:
    device = db.get(Device, body.id)
    if device is not None and device.user_id != auth.user.id:
        raise HTTPException(status_code=409, detail="device_id_taken")
    is_new = device is None
    if device is None:
        device = Device(id=body.id, user_id=auth.user.id, name=body.name, platform=body.platform)
    else:
        device.name = body.name
        device.platform = body.platform or device.platform
    device.last_seen = utcnow()
    db.add(device)
    # Flush first: without Relationship() objects the unit of work won't order
    # this INSERT before the auth_sessions UPDATE that references it.
    db.flush()
    # Bind this auth session to the device ("remove device" then revokes it too).
    auth.session.device_id = device.id
    db.add(auth.session)
    db.commit()
    db.refresh(device)
    # A QR-linked device announces itself once it has a name — at registration,
    # not at claim (PLAN.md §7.3): the name isn't known before this point.
    if is_new and auth.session.created_via == "device_link":
        loop_bridge.broadcast_to_user(
            auth.user.id,
            messages.device_linked(device.name, utcnow().isoformat()),
            exclude_device=device.id,
        )
    broadcast_peers_refresh(auth.user.id)
    return to_device_out(device, auth.user.id)


class DeviceRenameIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)


@router.patch("/{device_id}")
def rename_device(
    device_id: str,
    body: DeviceRenameIn,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> DeviceOut:
    device = db.get(Device, device_id)
    if device is None or device.user_id != auth.user.id:
        raise HTTPException(status_code=404, detail="device_not_found")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="empty_name")
    device.name = name
    db.add(device)
    db.commit()
    db.refresh(device)
    broadcast_peers_refresh(auth.user.id)
    return to_device_out(device, auth.user.id)


class OkOut(BaseModel):
    ok: bool


async def _close_ws(ws: WebSocket) -> None:
    with contextlib.suppress(Exception):
        await ws.close(code=4401)


@router.delete("/{device_id}")
def delete_device(
    device_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> OkOut:
    device = db.get(Device, device_id)
    if device is None or device.user_id != auth.user.id:
        raise HTTPException(status_code=404, detail="device_not_found")
    # Removing a device revokes every session bound to it (application logic;
    # the FK's ON DELETE SET NULL is just referential safety — PLAN.md §8).
    db.execute(delete(AuthSession).where(AuthSession.device_id == device_id))
    # Every other reference must be cleared too, or SQLite's FK check aborts the
    # delete (those columns aren't ON DELETE SET NULL). Content the device
    # produced is kept — its from-chip just loses the name; offers and session
    # membership die with the device.
    db.execute(update(Link).where(Link.from_device == device_id).values(from_device=None))
    db.execute(update(Snippet).where(Snippet.from_device == device_id).values(from_device=None))
    db.execute(update(Transfer).where(Transfer.from_device == device_id).values(from_device=None))
    db.execute(update(Transfer).where(Transfer.to_device == device_id).values(to_device=None))
    db.execute(delete(SharedFile).where(SharedFile.from_device == device_id))
    db.execute(delete(SessionMember).where(SessionMember.device_id == device_id))
    db.delete(device)
    db.commit()
    # Its live socket (if any) is now unauthenticated — close it.
    ws = hub.socket_for(auth.user.id, device_id)
    if ws is not None:
        loop_bridge.submit(_close_ws(ws))
    broadcast_peers_refresh(auth.user.id)
    return OkOut(ok=True)
