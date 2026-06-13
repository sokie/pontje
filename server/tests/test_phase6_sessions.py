"""Phase 6: cross-user share sessions — lifecycle + session-state broadcasts
(PLAN.md §15)."""

import re
from datetime import timedelta
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import ratelimit
from app.db import engine
from app.main import app
from app.models import SessionMember, ShareSession
from app.timeutil import utcnow
from tests.conftest import login, register_device

CODE_RE = re.compile(r"^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$")


@pytest.fixture(autouse=True)
def reset_ratelimit():
    ratelimit.reset()
    yield
    ratelimit.reset()


def other_client(client: TestClient, email: str, device_id: str | None) -> tuple[TestClient, str]:
    c = TestClient(app)
    c.headers["X-Pontje"] = "1"
    token = login(c, email)
    if device_id is not None:
        register_device(c, device_id, f"Device {device_id}")
    return c, token


def expire_session(session_id: str) -> None:
    with Session(engine) as db:
        s = db.get(ShareSession, session_id)
        assert s is not None
        s.expires_at = utcnow() - timedelta(minutes=1)
        db.add(s)
        db.commit()


def create_session(client: TestClient) -> dict:
    r = client.post("/api/v1/sessions")
    assert r.status_code == 200, r.text
    return r.json()


def recv_until(ws, t: str, limit: int = 10) -> dict:
    """Skip interleaved frames (presence/session pushes) until type t."""
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["t"] == t:
            return msg
    raise AssertionError(f"no {t!r} frame within {limit} messages")


def test_create_requires_bound_device(client: TestClient) -> None:
    login(client)  # no register_device → session has no device binding
    r = client.post("/api/v1/sessions")
    assert r.status_code == 400
    assert r.json()["detail"] == "no_device_bound"


def test_create_auto_joins_owner_device(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice Desktop")
    me = client.get("/api/v1/auth/me").json()

    body = create_session(client)
    session = body["session"]
    assert CODE_RE.match(session["code"]), session["code"]
    assert session["owner_id"] == me["user"]["id"]
    expires = utcnow() + timedelta(hours=23, minutes=59)
    assert session["expires_at"] > expires.isoformat()

    assert len(body["members"]) == 1
    member = body["members"][0]
    assert member == {
        "device_id": "dev-a",
        "device_name": "Alice Desktop",
        "user_name": "alice",  # email local-part fallback
        "user_id": me["user"]["id"],
        "online": False,  # no WS connected in this test
        "is_self": True,
    }


def test_code_generation_skips_collisions(client: TestClient, monkeypatch) -> None:
    login(client)
    register_device(client, "dev-a")
    me = client.get("/api/v1/auth/me").json()
    # Occupy AAAAAA (memberless: it must not trip the one-active rule).
    with Session(engine) as db:
        db.add(
            ShareSession(
                code="AAAAAA",
                owner_id=me["user"]["id"],
                expires_at=utcnow() + timedelta(hours=24),
            )
        )
        db.commit()
    seq = iter("AAAAAA" + "BBBBBB")
    monkeypatch.setattr(
        "app.routers.share_sessions.secrets", SimpleNamespace(choice=lambda _a: next(seq))
    )
    body = create_session(client)
    assert body["session"]["code"] == "BBBBBB"  # first candidate collided, retried


def test_join_happy_path_normalizes_code(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice Desktop")
    code = create_session(client)["session"]["code"]

    bob, _ = other_client(client, "bob@example.com", "dev-bob")
    r = bob.post("/api/v1/sessions/join", json={"code": f"  {code.lower()} "})
    assert r.status_code == 200, r.text
    body = r.json()
    assert {m["device_id"] for m in body["members"]} == {"dev-a", "dev-bob"}
    by_id = {m["device_id"]: m for m in body["members"]}
    assert by_id["dev-bob"]["is_self"] is True  # tailored to the caller's device
    assert by_id["dev-a"]["is_self"] is False
    assert by_id["dev-a"]["user_name"] == "alice"

    # Idempotent re-join with the same device.
    again = bob.post("/api/v1/sessions/join", json={"code": code})
    assert again.status_code == 200
    assert len(again.json()["members"]) == 2


def test_join_unknown_code_404(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    r = client.post("/api/v1/sessions/join", json={"code": "ZZZZZZ"})
    assert r.status_code == 404


def test_join_expired_session_410(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    body = create_session(client)
    expire_session(body["session"]["id"])

    bob, _ = other_client(client, "bob@example.com", "dev-bob")
    r = bob.post("/api/v1/sessions/join", json={"code": body["session"]["code"]})
    assert r.status_code == 410


def test_join_requires_bound_device(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    code = create_session(client)["session"]["code"]
    bob, _ = other_client(client, "bob@example.com", None)
    r = bob.post("/api/v1/sessions/join", json={"code": code})
    assert r.status_code == 400
    assert r.json()["detail"] == "no_device_bound"


def test_one_active_session_per_user_409(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    alice_body = create_session(client)

    # Creating again while a session is active → 409.
    assert client.post("/api/v1/sessions").status_code == 409

    bob, _ = other_client(client, "bob@example.com", "dev-bob")
    bob_code = create_session(bob)["session"]["code"]

    # Joining someone else's session while owning an active one → 409.
    r = client.post("/api/v1/sessions/join", json={"code": bob_code})
    assert r.status_code == 409
    assert r.json()["detail"] == "session_already_active"

    # After ending mine, joining works.
    assert client.delete(f"/api/v1/sessions/{alice_body['session']['id']}").status_code == 204
    assert client.post("/api/v1/sessions/join", json={"code": bob_code}).status_code == 200


def test_current_is_device_scoped(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    body = create_session(client)

    mine = client.get("/api/v1/sessions/current").json()
    assert mine["session"]["id"] == body["session"]["id"]
    assert mine["members"][0]["is_self"] is True

    # The same USER's other (non-member) device must not see the session.
    alice2, _ = other_client(client, "alice@example.com", "dev-a2")
    assert alice2.get("/api/v1/sessions/current").json() == {"session": None, "members": []}

    # Another user entirely: nothing either.
    bob, _ = other_client(client, "bob@example.com", "dev-bob")
    assert bob.get("/api/v1/sessions/current").json() == {"session": None, "members": []}


def test_owner_leave_ends_session_for_everyone(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    body = create_session(client)
    sid = body["session"]["id"]

    bob, _ = other_client(client, "bob@example.com", "dev-bob")
    bob.post("/api/v1/sessions/join", json={"code": body["session"]["code"]})

    assert client.post(f"/api/v1/sessions/{sid}/leave").status_code == 204
    assert bob.get("/api/v1/sessions/current").json()["session"] is None
    assert client.get("/api/v1/sessions/current").json()["session"] is None
    with Session(engine) as db:
        assert db.get(ShareSession, sid) is None
        assert db.exec(select(SessionMember).where(SessionMember.session_id == sid)).all() == []


def test_guest_leave_keeps_session(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    body = create_session(client)
    sid = body["session"]["id"]

    bob, _ = other_client(client, "bob@example.com", "dev-bob")
    bob.post("/api/v1/sessions/join", json={"code": body["session"]["code"]})

    assert bob.post(f"/api/v1/sessions/{sid}/leave").status_code == 204
    assert bob.get("/api/v1/sessions/current").json()["session"] is None
    mine = client.get("/api/v1/sessions/current").json()
    assert mine["session"]["id"] == sid
    assert [m["device_id"] for m in mine["members"]] == ["dev-a"]
    # Leaving again: no member rows left → 404.
    assert bob.post(f"/api/v1/sessions/{sid}/leave").status_code == 404


def test_delete_is_owner_only(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    body = create_session(client)
    sid = body["session"]["id"]

    bob, _ = other_client(client, "bob@example.com", "dev-bob")
    bob.post("/api/v1/sessions/join", json={"code": body["session"]["code"]})
    assert bob.delete(f"/api/v1/sessions/{sid}").status_code == 404  # guest can't end

    assert client.delete(f"/api/v1/sessions/{sid}").status_code == 204
    assert client.delete(f"/api/v1/sessions/{sid}").status_code == 404  # gone
    assert bob.get("/api/v1/sessions/current").json()["session"] is None


def test_session_state_broadcast_on_join_and_leave(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice Desktop")
    body = create_session(client)
    sid = body["session"]["id"]
    bob, bob_token = other_client(client, "bob@example.com", "dev-bob")

    with client.websocket_connect("/ws?device=dev-a") as ws_a:
        recv_until(ws_a, "peers")
        # Connect hook: this member device gets the current state right away.
        state = ws_a.receive_json()
        assert state["t"] == "session-state"
        assert state["session"]["id"] == sid
        assert [m["device_id"] for m in state["members"]] == ["dev-a"]
        assert state["members"][0]["online"] is True  # we just connected
        assert state["members"][0]["is_self"] is True

        bob.post("/api/v1/sessions/join", json={"code": body["session"]["code"]})
        joined = ws_a.receive_json()
        assert joined["t"] == "session-state"
        by_id = {m["device_id"]: m for m in joined["members"]}
        assert set(by_id) == {"dev-a", "dev-bob"}
        # is_self is tailored PER RECEIVING DEVICE — this is dev-a's frame.
        assert by_id["dev-a"]["is_self"] is True
        assert by_id["dev-bob"]["is_self"] is False
        assert by_id["dev-bob"] == {
            "device_id": "dev-bob",
            "device_name": "Device dev-bob",
            "user_name": "bob",
            "user_id": by_id["dev-bob"]["user_id"],
            "online": False,
            "is_self": False,
        }

        bob.post(f"/api/v1/sessions/{sid}/leave")
        left = ws_a.receive_json()
        assert left["t"] == "session-state"
        assert [m["device_id"] for m in left["members"]] == ["dev-a"]


def test_session_end_pushes_null_state_to_member_devices(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    body = create_session(client)
    bob, bob_token = other_client(client, "bob@example.com", "dev-bob")
    bob.post("/api/v1/sessions/join", json={"code": body["session"]["code"]})

    with client.websocket_connect(
        "/ws?device=dev-bob", headers={"Authorization": f"Bearer {bob_token}"}
    ) as ws_bob:
        recv_until(ws_bob, "peers")
        assert ws_bob.receive_json()["t"] == "session-state"  # connect hook
        client.delete(f"/api/v1/sessions/{body['session']['id']}")
        ended = ws_bob.receive_json()
        assert ended == {"t": "session-state", "session": None, "members": []}


def test_members_other_devices_never_see_session_state(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    alice2, alice2_token = other_client(client, "alice@example.com", "dev-a2")
    body = create_session(client)  # dev-a is the member; dev-a2 is NOT
    bob, _ = other_client(client, "bob@example.com", "dev-bob")

    with (
        client.websocket_connect("/ws?device=dev-a") as ws_a,
        client.websocket_connect(
            "/ws?device=dev-a2", headers={"Authorization": f"Bearer {alice2_token}"}
        ) as ws_a2,
    ):
        # Connect fan-outs interleave freely across sockets (websocket_connect
        # returns at the 101, before the app's first send). dev-a (member) must
        # see peers + its connect-hook session-state + dev-a2's peer-online, in
        # ANY order; dev-a2 (NOT a member) may see peers and dev-a's
        # peer-online, but NEVER a session-state.
        seen_a: set[str] = set()
        for _ in range(6):
            t = ws_a.receive_json()["t"]
            assert t in {"peers", "session-state", "peer-online"}
            seen_a.add(t)
            if seen_a == {"peers", "session-state", "peer-online"}:
                break
        assert seen_a == {"peers", "session-state", "peer-online"}

        msg = ws_a2.receive_json()
        assert msg["t"] != "session-state"
        if msg["t"] != "peers":
            recv_until(ws_a2, "peers")

        bob.post("/api/v1/sessions/join", json={"code": body["session"]["code"]})
        joined = ws_a.receive_json()  # member device: yes
        assert joined["t"] == "session-state"
        assert len(joined["members"]) == 2

        # dev-a2 got NO session-state: drain (tolerating a late peer-online)
        # until its own loopback marker comes back.
        marker = {"t": "rtc-ice", "to": "dev-a2", "from": "dev-a2", "candidate": "marker"}
        ws_a2.send_json(marker)
        for _ in range(5):
            msg = ws_a2.receive_json()
            assert msg["t"] != "session-state"
            if msg == marker:
                break
        else:
            raise AssertionError("loopback marker never arrived")


def test_presence_flip_pushes_refreshed_session_state(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    body = create_session(client)
    bob, bob_token = other_client(client, "bob@example.com", "dev-bob")
    bob.post("/api/v1/sessions/join", json={"code": body["session"]["code"]})

    with client.websocket_connect("/ws?device=dev-a") as ws_a:
        recv_until(ws_a, "peers")
        assert ws_a.receive_json()["t"] == "session-state"  # connect hook (self online)

        with client.websocket_connect(
            "/ws?device=dev-bob", headers={"Authorization": f"Bearer {bob_token}"}
        ) as ws_bob:
            recv_until(ws_bob, "peers")
            online = ws_a.receive_json()  # bob's device connected
            assert online["t"] == "session-state"
            assert {m["device_id"]: m["online"] for m in online["members"]} == {
                "dev-a": True,
                "dev-bob": True,
            }

        offline = ws_a.receive_json()  # bob's device disconnected (fresh task)
        assert offline["t"] == "session-state"
        assert {m["device_id"]: m["online"] for m in offline["members"]} == {
            "dev-a": True,
            "dev-bob": False,
        }
