"""Phase 6: session-scoped links + snippets (PLAN.md §13, §15).

Member devices post into / list the shared scope; non-members get 403;
broadcasts reach every member device ACROSS users; session secrets are
revealable by any active member, exactly once.
"""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app import ratelimit
from app.db import engine
from app.main import app
from app.models import ShareSession, Snippet
from app.timeutil import utcnow
from tests.conftest import login, register_device


@pytest.fixture(autouse=True)
def reset_ratelimit():
    ratelimit.reset()
    yield
    ratelimit.reset()


@pytest.fixture(autouse=True)
def no_enrichment(monkeypatch: pytest.MonkeyPatch):
    """Keep API tests offline: the router still schedules the coroutine, but it no-ops."""

    async def _noop(link_id: str, client=None) -> None:
        return None

    monkeypatch.setattr("app.routers.links.enrich_link", _noop)


def bob_client(register: bool = True) -> tuple[TestClient, str]:
    bob = TestClient(app)
    bob.headers["X-Pontje"] = "1"
    token = login(bob, "bob@example.com")
    if register:
        register_device(bob, "dev-bob", "Bob Phone")
    return bob, token


def make_session(client: TestClient) -> dict:
    body = client.post("/api/v1/sessions").json()
    return body["session"]


def join(bob: TestClient, code: str) -> None:
    assert bob.post("/api/v1/sessions/join", json={"code": code}).status_code == 200


def expire_session(session_id: str) -> None:
    with Session(engine) as db:
        s = db.get(ShareSession, session_id)
        assert s is not None
        s.expires_at = utcnow() - timedelta(minutes=1)
        db.add(s)
        db.commit()


def db_snippet(snippet_id: str) -> Snippet | None:
    with Session(engine) as db:
        return db.get(Snippet, snippet_id)


def recv_until(ws, t: str, limit: int = 10) -> dict:
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["t"] == t:
            return msg
    raise AssertionError(f"no {t!r} frame within {limit} messages")


# ---------------------------------------------------------------------------
# Links


def test_member_posts_session_link_and_lists_shared_scope(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice PC")
    session = make_session(client)
    bob, _ = bob_client()
    join(bob, session["code"])

    personal = client.post("/api/v1/links", json={"url": "https://example.com/personal"}).json()
    mine = client.post(
        "/api/v1/links", json={"url": "https://example.com/a", "session_id": session["id"]}
    )
    assert mine.status_code == 200, mine.text
    assert mine.json()["session_id"] == session["id"]
    theirs = bob.post(
        "/api/v1/links", json={"url": "https://example.com/b", "session_id": session["id"]}
    )
    assert theirs.status_code == 200

    # Members see the WHOLE shared list — both users' posts, nothing personal.
    shared = bob.get(f"/api/v1/links?session={session['id']}").json()
    assert {link["url"] for link in shared} == {
        "https://example.com/a",
        "https://example.com/b",
    }
    assert all(link["session_id"] == session["id"] for link in shared)

    # Personal lists stay personal — session items never leak in.
    assert [link["id"] for link in client.get("/api/v1/links").json()] == [personal["id"]]
    assert bob.get("/api/v1/links").json() == []


def test_session_link_post_403_404_410(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    session = make_session(client)
    url = "https://example.com/x"

    # Unknown session id → 404 (as before Phase 6).
    r = client.post("/api/v1/links", json={"url": url, "session_id": "nope"})
    assert r.status_code == 404

    # A non-member DEVICE → 403 (real membership check, not just existence).
    bob, _ = bob_client()
    r = bob.post("/api/v1/links", json={"url": url, "session_id": session["id"]})
    assert r.status_code == 403
    assert r.json()["detail"] == "not_a_session_member"
    r = bob.get(f"/api/v1/links?session={session['id']}")
    assert r.status_code == 403

    # Expired → 410, even for a member.
    expire_session(session["id"])
    r = client.post("/api/v1/links", json={"url": url, "session_id": session["id"]})
    assert r.status_code == 410


def test_session_link_broadcast_reaches_other_users_member_device(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice PC")
    session = make_session(client)
    bob, bob_token = bob_client()
    join(bob, session["code"])

    with client.websocket_connect(
        "/ws?device=dev-bob", headers={"Authorization": f"Bearer {bob_token}"}
    ) as ws_bob:
        recv_until(ws_bob, "peers")
        created = client.post(
            "/api/v1/links", json={"url": "https://example.com/live", "session_id": session["id"]}
        ).json()
        msg = recv_until(ws_bob, "link-new")
        assert msg["link"]["id"] == created["id"]
        assert msg["link"]["session_id"] == session["id"]

        # Deletion fans out to the same member devices.
        assert client.delete(f"/api/v1/links/{created['id']}").status_code == 204
        assert recv_until(ws_bob, "link-deleted")["id"] == created["id"]


# ---------------------------------------------------------------------------
# Snippets


def test_member_posts_session_snippet_non_member_403(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    session = make_session(client)
    bob, _ = bob_client()

    r = bob.post(
        "/api/v1/snippets", json={"content": "hi", "kind": "text", "session_id": session["id"]}
    )
    assert r.status_code == 403

    join(bob, session["code"])
    r = bob.post(
        "/api/v1/snippets", json={"content": "hi", "kind": "text", "session_id": session["id"]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["session_id"] == session["id"]

    shared = client.get(f"/api/v1/snippets?session={session['id']}").json()
    assert [s["content"] for s in shared] == ["hi"]
    # Personal list untouched.
    assert client.get("/api/v1/snippets").json() == []

    # Unknown / expired for snippets too.
    assert (
        bob.post(
            "/api/v1/snippets", json={"content": "x", "session_id": "nope"}
        ).status_code
        == 404
    )
    expire_session(session["id"])
    r = bob.post("/api/v1/snippets", json={"content": "x", "session_id": session["id"]})
    assert r.status_code == 410
    assert bob.get(f"/api/v1/snippets?session={session['id']}").status_code == 410


def test_session_snippet_broadcast_reaches_other_user(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    session = make_session(client)
    bob, bob_token = bob_client()
    join(bob, session["code"])

    with client.websocket_connect(
        "/ws?device=dev-bob", headers={"Authorization": f"Bearer {bob_token}"}
    ) as ws_bob:
        recv_until(ws_bob, "peers")
        created = client.post(
            "/api/v1/snippets",
            json={"content": "shared note", "kind": "text", "session_id": session["id"]},
        ).json()
        msg = recv_until(ws_bob, "snippet-new")
        assert msg["snippet"]["id"] == created["id"]
        assert msg["snippet"]["content"] == "shared note"
        assert msg["snippet"]["session_id"] == session["id"]


def test_session_secret_revealable_by_other_member_exactly_once(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Alice PC")
    session = make_session(client)
    bob, _ = bob_client()
    join(bob, session["code"])

    sid = client.post(
        "/api/v1/snippets",
        json={"content": "wifi-password", "kind": "secret", "session_id": session["id"]},
    ).json()["id"]

    # The OTHER member reveals — and the burn broadcast crosses users, tagged
    # with the revealing device.
    with client.websocket_connect("/ws?device=dev-a") as ws_a:
        recv_until(ws_a, "peers")
        first = bob.post(f"/api/v1/snippets/{sid}/reveal")
        assert first.status_code == 200, first.text
        assert first.json()["content"] == "wifi-password"
        msg = recv_until(ws_a, "snippet-deleted")
        assert msg == {"t": "snippet-deleted", "id": sid, "revealedBy": "dev-bob"}

    assert db_snippet(sid) is None  # burned
    # Exactly once: the creator's own second attempt loses too.
    assert client.post(f"/api/v1/snippets/{sid}/reveal").status_code == 410


def test_session_secret_not_revealable_by_non_member(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    session = make_session(client)
    sid = client.post(
        "/api/v1/snippets",
        json={"content": "mine", "kind": "secret", "session_id": session["id"]},
    ).json()["id"]

    bob, _ = bob_client()  # NOT a member
    assert bob.post(f"/api/v1/snippets/{sid}/reveal").status_code == 410
    assert db_snippet(sid) is not None  # not burned by the failed attempt


def test_session_secret_member_reveal_blocked_after_expiry(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    session = make_session(client)
    bob, _ = bob_client()
    join(bob, session["code"])
    sid = client.post(
        "/api/v1/snippets",
        json={"content": "stale", "kind": "secret", "session_id": session["id"]},
    ).json()["id"]

    expire_session(session["id"])
    # Membership only counts while the session is ACTIVE (the SQL folds the
    # expiry check into the atomic delete).
    assert bob.post(f"/api/v1/snippets/{sid}/reveal").status_code == 410
    assert db_snippet(sid) is not None
    # The creator path is user-scoped and still works.
    assert client.post(f"/api/v1/snippets/{sid}/reveal").status_code == 200


def test_session_text_snippet_member_delete_and_reveal_400(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    session = make_session(client)
    bob, _ = bob_client()
    join(bob, session["code"])
    sid = client.post(
        "/api/v1/snippets",
        json={"content": "todo list", "kind": "text", "session_id": session["id"]},
    ).json()["id"]

    # Member revealing a TEXT snippet → 400 (authorized, wrong kind).
    assert bob.post(f"/api/v1/snippets/{sid}/reveal").status_code == 400
    # Member can delete another member's session snippet.
    assert bob.delete(f"/api/v1/snippets/{sid}").status_code == 204
    assert db_snippet(sid) is None


def test_session_end_clears_scoped_content(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a")
    session = make_session(client)
    link = client.post(
        "/api/v1/links", json={"url": "https://example.com/s", "session_id": session["id"]}
    ).json()
    snip = client.post(
        "/api/v1/snippets", json={"content": "bye", "session_id": session["id"]}
    ).json()

    assert client.delete(f"/api/v1/sessions/{session['id']}").status_code == 204
    # Scoped rows went with the session (FK-safe, mirrors the sweeper).
    assert db_snippet(snip["id"]) is None
    assert client.get("/api/v1/links").json() == []  # not leaked into personal
    with Session(engine) as db:
        from app.models import Link

        assert db.get(Link, link["id"]) is None
