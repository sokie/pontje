"""Phase 6: cross-user rtc-* relay matrix (PLAN.md §9).

Relay iff same user OR sender+target devices share a non-expired session.
Two-user WS pattern: both sockets run through the same TestClient portal
(Bearer wins over cookie) so the presence hub stays loop-confined.
"""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app import ratelimit
from app.db import engine
from app.main import app
from app.models import ShareSession
from app.timeutil import utcnow
from tests.conftest import login, register_device


@pytest.fixture(autouse=True)
def reset_ratelimit():
    ratelimit.reset()
    yield
    ratelimit.reset()


def bob_client() -> tuple[TestClient, str]:
    bob = TestClient(app)
    bob.headers["X-Pontje"] = "1"
    token = login(bob, "bob@example.com")
    register_device(bob, "dev-bob", "Bob Phone")
    return bob, token


def make_shared_session(client: TestClient, bob: TestClient) -> str:
    body = client.post("/api/v1/sessions").json()
    r = bob.post("/api/v1/sessions/join", json={"code": body["session"]["code"]})
    assert r.status_code == 200, r.text
    return body["session"]["id"]


def expire_session(session_id: str) -> None:
    with Session(engine) as db:
        s = db.get(ShareSession, session_id)
        assert s is not None
        s.expires_at = utcnow() - timedelta(minutes=1)
        db.add(s)
        db.commit()


def recv_until(ws, t: str, limit: int = 10) -> dict:
    """Skip interleaved frames (session-state pushes etc.) until type t."""
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["t"] == t:
            return msg
    raise AssertionError(f"no {t!r} frame within {limit} messages")


def test_rtc_relayed_both_ways_between_session_members(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice PC")
    bob, bob_token = bob_client()
    make_shared_session(client, bob)

    with (
        client.websocket_connect("/ws?device=dev-a") as ws_a,
        client.websocket_connect(
            "/ws?device=dev-bob", headers={"Authorization": f"Bearer {bob_token}"}
        ) as ws_bob,
    ):
        recv_until(ws_a, "peers")
        recv_until(ws_bob, "peers")

        offer = {"t": "rtc-offer", "to": "dev-bob", "from": "dev-a", "sdp": "v=0 cross-user"}
        ws_a.send_json(offer)
        assert recv_until(ws_bob, "rtc-offer") == offer  # intact, untouched

        answer = {"t": "rtc-answer", "to": "dev-a", "from": "dev-bob", "sdp": "v=0 reply"}
        ws_bob.send_json(answer)
        assert recv_until(ws_a, "rtc-answer") == answer

        ice = {"t": "rtc-ice", "to": "dev-bob", "from": "dev-a", "candidate": {"candidate": "c"}}
        ws_a.send_json(ice)
        assert recv_until(ws_bob, "rtc-ice") == ice


def test_rtc_cross_user_without_session_still_blocked(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice PC")
    bob, bob_token = bob_client()

    with (
        client.websocket_connect("/ws?device=dev-a") as ws_a,
        client.websocket_connect(
            "/ws?device=dev-bob", headers={"Authorization": f"Bearer {bob_token}"}
        ) as ws_bob,
    ):
        recv_until(ws_a, "peers")
        recv_until(ws_bob, "peers")

        ws_a.send_json({"t": "rtc-offer", "to": "dev-bob", "from": "dev-a", "sdp": "x"})
        err = recv_until(ws_a, "error")
        assert err["code"] == "unauthorized_target"

        # Bob's frame was never relayed: his next rtc frame is his own loopback.
        marker = {"t": "rtc-ice", "to": "dev-bob", "from": "dev-bob", "candidate": "marker"}
        ws_bob.send_json(marker)
        assert recv_until(ws_bob, "rtc-ice") == marker


def test_rtc_blocked_across_two_different_sessions(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice PC")
    bob, bob_token = bob_client()
    # Each user sits in their OWN session — no shared membership.
    assert client.post("/api/v1/sessions").status_code == 200
    assert bob.post("/api/v1/sessions").status_code == 200

    with (
        client.websocket_connect("/ws?device=dev-a") as ws_a,
        client.websocket_connect(
            "/ws?device=dev-bob", headers={"Authorization": f"Bearer {bob_token}"}
        ) as ws_bob,
    ):
        recv_until(ws_a, "peers")
        recv_until(ws_bob, "peers")
        ws_a.send_json({"t": "rtc-offer", "to": "dev-bob", "from": "dev-a", "sdp": "x"})
        err = recv_until(ws_a, "error")
        assert err["code"] == "unauthorized_target"


def test_rtc_blocked_once_shared_session_expires(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice PC")
    bob, bob_token = bob_client()
    sid = make_shared_session(client, bob)

    with (
        client.websocket_connect("/ws?device=dev-a") as ws_a,
        client.websocket_connect(
            "/ws?device=dev-bob", headers={"Authorization": f"Bearer {bob_token}"}
        ) as ws_bob,
    ):
        recv_until(ws_a, "peers")
        recv_until(ws_bob, "peers")

        # Sanity: relay works while the session is live.
        offer = {"t": "rtc-offer", "to": "dev-bob", "from": "dev-a", "sdp": "pre-expiry"}
        ws_a.send_json(offer)
        assert recv_until(ws_bob, "rtc-offer") == offer

        expire_session(sid)
        ws_a.send_json({"t": "rtc-offer", "to": "dev-bob", "from": "dev-a", "sdp": "post"})
        err = recv_until(ws_a, "error")
        assert err["code"] == "unauthorized_target"

        # And no rtc traffic leaked to bob — late session-state/presence pushes
        # are legitimate (bob is a member); the leak would be an rtc-offer.
        marker = {"t": "rtc-ice", "to": "dev-bob", "from": "dev-bob", "candidate": "marker"}
        ws_bob.send_json(marker)
        for _ in range(5):
            msg = ws_bob.receive_json()
            assert msg["t"] not in {"rtc-offer", "rtc-answer"}
            if msg == marker:
                break
        else:
            raise AssertionError("loopback marker never arrived")


def test_rtc_session_member_offline_gets_target_offline(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice PC")
    bob, _bob_token = bob_client()
    make_shared_session(client, bob)  # authorized, but bob never connects WS

    with client.websocket_connect("/ws?device=dev-a") as ws_a:
        recv_until(ws_a, "peers")
        ws_a.send_json({"t": "rtc-offer", "to": "dev-bob", "from": "dev-a", "sdp": "x"})
        err = recv_until(ws_a, "error")
        assert err["code"] == "target_offline"
