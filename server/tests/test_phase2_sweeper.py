from datetime import timedelta

from sqlmodel import Session, select

from app.db import engine
from app.models import (
    AuthSession,
    Device,
    DeviceLinkToken,
    Link,
    SessionMember,
    SharedFile,
    ShareSession,
    Snippet,
    Transfer,
)
from app.services.cleanup import sweep_once
from app.timeutil import utcnow

OLD = utcnow() - timedelta(hours=49)
FRESH = utcnow() - timedelta(hours=1)


def seed() -> dict[str, str]:
    """Old + fresh row of every swept kind; returns ids of the rows that must survive."""
    from app.models import User

    with Session(engine) as db:
        user = User(google_sub="dev:sweep@example.com", email="sweep@example.com")
        db.add(user)
        db.flush()
        device = Device(id="sweep-dev", user_id=user.id, name="Sweeper")
        db.add(device)
        db.flush()

        keep: dict[str, str] = {}

        old_session = ShareSession(code="OLDSES", owner_id=user.id, expires_at=OLD)
        live_session = ShareSession(
            code="LIVSES", owner_id=user.id, expires_at=utcnow() + timedelta(hours=1)
        )
        db.add(old_session)
        db.add(live_session)
        db.flush()
        keep["session"] = live_session.id
        db.add(SessionMember(session_id=old_session.id, device_id=device.id, user_id=user.id))

        # 48 h content sweep: one old + one fresh of each.
        db.add(Link(user_id=user.id, url="https://old.example", created_at=OLD))
        fresh_link = Link(user_id=user.id, url="https://fresh.example", created_at=FRESH)
        db.add(fresh_link)
        # Fresh by age but scoped to the expired session → must go with it.
        db.add(
            Link(
                user_id=user.id,
                url="https://in-old-session.example",
                session_id=old_session.id,
                created_at=FRESH,
            )
        )
        db.add(Snippet(user_id=user.id, content="old", created_at=OLD))
        fresh_snippet = Snippet(user_id=user.id, content="fresh", created_at=FRESH)
        db.add(fresh_snippet)
        db.add(
            SharedFile(
                user_id=user.id, file_name="old.bin", from_device=device.id, created_at=OLD
            )
        )
        fresh_share = SharedFile(
            user_id=user.id, file_name="fresh.bin", from_device=device.id, created_at=FRESH
        )
        db.add(fresh_share)
        db.add(Transfer(user_id=user.id, file_name="old.zip", created_at=OLD))
        fresh_transfer = Transfer(user_id=user.id, file_name="fresh.zip", created_at=FRESH)
        db.add(fresh_transfer)

        expired_auth = AuthSession(
            token_hash="hash-expired", user_id=user.id, expires_at=utcnow() - timedelta(minutes=1)
        )
        valid_auth = AuthSession(
            token_hash="hash-valid", user_id=user.id, expires_at=utcnow() + timedelta(days=1)
        )
        db.add(expired_auth)
        db.add(valid_auth)

        db.add(
            DeviceLinkToken(
                token_hash="dlt-expired",
                user_id=user.id,
                expires_at=utcnow() - timedelta(seconds=10),
            )
        )
        db.add(
            DeviceLinkToken(
                token_hash="dlt-claimed",
                user_id=user.id,
                expires_at=utcnow() + timedelta(seconds=60),
                claimed_at=utcnow(),
            )
        )
        db.add(
            DeviceLinkToken(
                token_hash="dlt-live",
                user_id=user.id,
                expires_at=utcnow() + timedelta(seconds=60),
            )
        )
        db.commit()
        keep["link"] = fresh_link.id
        keep["snippet"] = fresh_snippet.id
        keep["shared_file"] = fresh_share.id
        keep["transfer"] = fresh_transfer.id
        return keep


def test_sweep_once_removes_exactly_the_expired_rows() -> None:
    keep = seed()
    sweep_once()

    with Session(engine) as db:
        links = db.exec(select(Link)).all()
        assert [link.id for link in links] == [keep["link"]]

        snippets = db.exec(select(Snippet)).all()
        assert [s.id for s in snippets] == [keep["snippet"]]

        shares = db.exec(select(SharedFile)).all()
        assert [s.id for s in shares] == [keep["shared_file"]]

        transfers = db.exec(select(Transfer)).all()
        assert [t.id for t in transfers] == [keep["transfer"]]

        sessions = db.exec(select(ShareSession)).all()
        assert [s.id for s in sessions] == [keep["session"]]
        assert db.exec(select(SessionMember)).all() == []  # expired session's member went too

        auth_hashes = {a.token_hash for a in db.exec(select(AuthSession)).all()}
        assert auth_hashes == {"hash-valid"}

        token_hashes = {t.token_hash for t in db.exec(select(DeviceLinkToken)).all()}
        assert token_hashes == {"dlt-live"}  # expired AND claimed both removed


def test_sweep_once_idempotent_on_empty_db() -> None:
    sweep_once()
    sweep_once()  # no rows, no errors
