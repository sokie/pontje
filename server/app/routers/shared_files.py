"""Shared-file offers — pull model, presence-aware (PLAN.md §14.1).

Metadata only: the bytes stay on the sharing device, which serves pulls over
WebRTC (§10.2 pull mode). Any device of the owner may report an offer stale
when the sharer replied `unavailable`.
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlmodel import Session, col, select

from app import loop
from app.auth.deps import AuthContext, current_auth
from app.db import get_db
from app.models import SharedFile
from app.services.categorize import categorize_file
from app.ws import messages

router = APIRouter(prefix="/shared-files", tags=["shared-files"])


class SharedFileCreate(BaseModel):
    file_name: str
    mime: str | None = None
    size_bytes: int | None = None


class SharedFileOut(BaseModel):
    id: str
    file_name: str
    mime: str | None
    size_bytes: int | None
    category: str
    from_device: str
    status: str  # active | stale
    created_at: str


def to_out(f: SharedFile) -> SharedFileOut:
    return SharedFileOut(
        id=f.id,
        file_name=f.file_name,
        mime=f.mime,
        size_bytes=f.size_bytes,
        category=f.category,
        from_device=f.from_device,
        status=f.status,
        created_at=f.created_at.isoformat(),
    )


@router.post("")
def share_file(
    body: SharedFileCreate,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> SharedFileOut:
    # The offer is served by the sharing DEVICE — a session without a bound
    # device has nothing that could ever answer a pull.
    if auth.session.device_id is None:
        raise HTTPException(status_code=400, detail="no_device_bound")
    shared = SharedFile(
        user_id=auth.user.id,
        file_name=body.file_name,
        mime=body.mime,
        size_bytes=body.size_bytes,
        category=categorize_file(body.mime, body.file_name),
        from_device=auth.session.device_id,
        status="active",
    )
    db.add(shared)
    db.commit()
    db.refresh(shared)
    out = to_out(shared)
    loop.broadcast_to_user(auth.user.id, messages.file_shared(out.model_dump()))
    return out


@router.get("")
def list_shared_files(
    auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> list[SharedFileOut]:
    # Stale offers stay listed — the UI greys them out (PLAN.md §14.1).
    rows = db.exec(
        select(SharedFile)
        .where(SharedFile.user_id == auth.user.id, col(SharedFile.session_id).is_(None))
        .order_by(col(SharedFile.created_at).desc(), col(SharedFile.id).desc())
    ).all()
    return [to_out(f) for f in rows]


@router.delete("/{shared_file_id}", status_code=204)
def unshare_file(
    shared_file_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> None:
    shared = db.get(SharedFile, shared_file_id)
    if shared is None or shared.user_id != auth.user.id:
        raise HTTPException(status_code=404, detail="shared_file_not_found")
    db.delete(shared)
    db.commit()
    loop.broadcast_to_user(auth.user.id, messages.file_unshared(shared_file_id))


@router.post("/{shared_file_id}/stale")
def mark_stale(
    shared_file_id: str,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> SharedFileOut:
    # Any device of the owning user may report (the PULLER saw `unavailable`);
    # idempotent — concurrent reports all land on status="stale".
    shared = db.get(SharedFile, shared_file_id)
    if shared is None or shared.user_id != auth.user.id:
        raise HTTPException(status_code=404, detail="shared_file_not_found")
    if shared.status != "stale":
        shared.status = "stale"
        db.add(shared)
        db.commit()
        db.refresh(shared)
        loop.broadcast_to_user(auth.user.id, messages.file_stale(shared_file_id))
    return to_out(shared)
