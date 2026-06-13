"""Transfer HISTORY — metadata only, logged by the sender on completion
(PLAN.md §14.3). File bytes never touch the server by construction.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app import loop
from app.auth.deps import AuthContext, current_auth
from app.db import get_db
from app.models import Transfer
from app.services.categorize import categorize_file
from app.ws import messages

router = APIRouter(prefix="/transfers", tags=["transfers"])

VALID_STATUS = {"completed", "failed", "rejected", "canceled"}
VALID_PATH = {"lan", "internet", "relay"}


class TransferCreate(BaseModel):
    file_name: str
    mime: str | None = None
    size_bytes: int | None = None
    to_device: str | None = None
    network_path: str | None = None  # lan | internet | relay
    status: str  # completed | failed | rejected | canceled


class TransferOut(BaseModel):
    id: str
    file_name: str
    mime: str | None
    size_bytes: int | None
    category: str
    from_device: str | None
    to_device: str | None
    network_path: str | None
    status: str
    created_at: str


def to_out(t: Transfer) -> TransferOut:
    return TransferOut(
        id=t.id,
        file_name=t.file_name,
        mime=t.mime,
        size_bytes=t.size_bytes,
        category=t.category,
        from_device=t.from_device,
        to_device=t.to_device,
        network_path=t.network_path,
        status=t.status,
        created_at=t.created_at.isoformat(),
    )


@router.post("")
def log_transfer(
    body: TransferCreate,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> TransferOut:
    if body.status not in VALID_STATUS:
        raise HTTPException(status_code=422, detail="invalid_status")
    if body.network_path is not None and body.network_path not in VALID_PATH:
        raise HTTPException(status_code=422, detail="invalid_network_path")
    transfer = Transfer(
        user_id=auth.user.id,
        file_name=body.file_name,
        mime=body.mime,
        size_bytes=body.size_bytes,
        category=categorize_file(body.mime, body.file_name),
        from_device=auth.session.device_id,
        to_device=body.to_device,
        network_path=body.network_path,
        status=body.status,
    )
    db.add(transfer)
    db.commit()
    db.refresh(transfer)
    out = to_out(transfer)
    loop.broadcast_to_user(auth.user.id, messages.transfer_logged(out.model_dump()))
    return out


@router.get("")
def list_transfers(
    auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> list[TransferOut]:
    rows = db.exec(
        select(Transfer)
        .where(Transfer.user_id == auth.user.id, Transfer.session_id == None)  # noqa: E711
        .order_by(Transfer.created_at.desc(), Transfer.id)  # type: ignore[union-attr]
    ).all()
    return [to_out(t) for t in rows]
