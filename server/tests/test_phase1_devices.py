"""Phase 1: device rename/delete + session revocation + device-linked broadcast."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import ratelimit
from app.db import engine
from app.main import app
from app.models import Link, SessionMember, SharedFile, ShareSession, Snippet, Transfer, User
from app.timeutil import utcnow
from tests.conftest import login, recv_until, register_device


@pytest.fixture(autouse=True)
def reset_ratelimit():
    ratelimit.reset()
    yield
    ratelimit.reset()


def other_client(email: str) -> TestClient:
    c = TestClient(app)
    c.headers["X-Pontje"] = "1"
    login(c, email)
    return c


def test_rename_device_by_owner(client: TestClient) -> None:
    login(client)
    register_device(client, "d1", "Old Name")
    r = client.patch("/api/v1/devices/d1", json={"name": "  New Name  "})
    assert r.status_code == 200
    assert r.json()["name"] == "New Name"
    devices = client.get("/api/v1/devices").json()
    assert devices[0]["name"] == "New Name"


def test_rename_and_delete_foreign_device_404(client: TestClient) -> None:
    login(client, "alice@example.com")
    register_device(client, "d1", "Alice PC")
    bob = other_client("bob@example.com")
    assert bob.patch("/api/v1/devices/d1", json={"name": "Hax"}).status_code == 404
    assert bob.delete("/api/v1/devices/d1").status_code == 404
    # Untouched.
    assert client.get("/api/v1/devices").json()[0]["name"] == "Alice PC"


def test_rename_unknown_device_404(client: TestClient) -> None:
    login(client)
    assert client.patch("/api/v1/devices/nope", json={"name": "X"}).status_code == 404
    assert client.delete("/api/v1/devices/nope").status_code == 404


def test_delete_device_revokes_bound_sessions(client: TestClient) -> None:
    first_token = login(client)
    register_device(client, "d1", "Doomed")
    # A second session of the same user removes the device...
    alice2 = other_client("alice@example.com")
    assert alice2.delete("/api/v1/devices/d1").status_code == 200
    assert alice2.get("/api/v1/devices").json() == []
    # ...and the session bound to it stops working on both transports.
    bare = TestClient(app)
    r = bare.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {first_token}"})
    assert r.status_code == 401
    assert client.get("/api/v1/auth/me").status_code == 401
    # The remover's own (unbound) session still works.
    assert alice2.get("/api/v1/auth/me").status_code == 200


def test_delete_device_with_references_succeeds(client: TestClient) -> None:
    """A device referenced by links/snippets/transfers/offers/session membership
    must still delete — those FKs aren't ON DELETE SET NULL, so the endpoint
    clears them itself or SQLite aborts the delete (the 'Remove failed' bug)."""
    login(client)
    register_device(client, "d1", "Doomed")
    register_device(client, "d2", "Keeper")  # transfer counterpart, kept

    with Session(engine) as db:
        uid = db.exec(select(User).where(User.email == "alice@example.com")).one().id
        share = ShareSession(code="REF123", owner_id=uid, expires_at=utcnow() + timedelta(hours=24))
        db.add(share)
        db.commit()
        db.add(Link(user_id=uid, url="https://example.com", from_device="d1"))
        db.add(Snippet(user_id=uid, content="hi", from_device="d1"))
        db.add(Transfer(user_id=uid, file_name="a.bin", from_device="d1", to_device="d2"))
        db.add(SharedFile(user_id=uid, file_name="f.bin", from_device="d1"))
        db.add(SessionMember(session_id=share.id, device_id="d1", user_id=uid))
        db.commit()

    assert client.delete("/api/v1/devices/d1").status_code == 200
    assert [d["id"] for d in client.get("/api/v1/devices").json()] == ["d2"]

    with Session(engine) as db:
        # Content survives with the from-chip nulled; the offer and the session
        # membership die with the device; an unrelated to_device is untouched.
        assert db.exec(select(Link)).one().from_device is None
        assert db.exec(select(Snippet)).one().from_device is None
        transfer = db.exec(select(Transfer)).one()
        assert transfer.from_device is None and transfer.to_device == "d2"
        assert db.exec(select(SharedFile)).all() == []
        assert db.exec(select(SessionMember)).all() == []


def test_register_after_device_link_broadcasts_device_linked(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Desktop")
    minted = client.post("/api/v1/auth/device-link").json()

    claimer = TestClient(app)
    claimer.headers["X-Pontje"] = "1"
    r = claimer.post("/api/v1/auth/device-link/claim", json={"token": minted["token"]})
    assert r.status_code == 200

    with client.websocket_connect("/ws?device=dev-a") as ws:
        recv_until(ws, "peers")  # connect snapshot
        r = claimer.post(
            "/api/v1/devices", json={"id": "dev-pixel", "name": "Pixel 8", "platform": "android"}
        )
        assert r.status_code == 200
        # Registration fires device-linked AND a peers refresh; order may vary and
        # a stray presence frame may interleave — collect until both have arrived.
        frames = {}
        for _ in range(12):
            f = ws.receive_json()
            frames[f["t"]] = f
            if {"device-linked", "peers"} <= frames.keys():
                break
        linked = frames["device-linked"]
        assert linked["deviceName"] == "Pixel 8"
        assert linked["at"]
        peers = frames["peers"]
        assert {p["deviceId"] for p in peers["peers"]} == {"dev-a", "dev-pixel"}


def test_oauth_register_does_not_broadcast_device_linked(client: TestClient) -> None:
    """Only sessions created via device_link announce; dev/oauth sessions don't."""
    login(client)
    register_device(client, "dev-a", "Desktop")
    with client.websocket_connect("/ws?device=dev-a") as ws:
        recv_until(ws, "peers")  # connect snapshot
        register_device(client, "dev-b", "Second")
        # A non-device-link registration must NOT announce device-linked — only a
        # peers refresh arrives (possibly after stray presence churn).
        for _ in range(12):
            frame = ws.receive_json()
            assert frame["t"] != "device-linked", "oauth/dev registration must not announce"
            if frame["t"] == "peers":
                break
        else:
            raise AssertionError("no peers refresh after registration")
        assert {p["deviceId"] for p in frame["peers"]} == {"dev-a", "dev-b"}
