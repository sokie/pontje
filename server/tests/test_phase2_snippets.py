import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app import ratelimit
from app.db import engine
from app.models import Snippet
from app.services import secretbox
from tests.conftest import login, recv_until, register_device


@pytest.fixture(autouse=True)
def reset_ratelimit():
    # Reveal is rate-limited (PLAN.md §23); isolate the per-user window per test.
    ratelimit.reset()
    yield
    ratelimit.reset()


def bob_client(client: TestClient) -> TestClient:
    other = TestClient(client.app)
    other.headers["X-Pontje"] = "1"
    login(other, "bob@example.com")
    return other


def db_content(snippet_id: str) -> str | None:
    with Session(engine) as db:
        row = db.get(Snippet, snippet_id)
        return None if row is None else row.content


def test_text_snippet_roundtrip(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-snip", "Phone")
    r = client.post("/api/v1/snippets", json={"content": "hello clipboard", "kind": "text"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "text"
    assert body["content"] == "hello clipboard"
    assert body["from_device"] == "dev-snip"

    listed = client.get("/api/v1/snippets").json()
    assert [s["id"] for s in listed] == [body["id"]]
    assert listed[0]["content"] == "hello clipboard"


def test_secret_never_exposed_and_ciphertext_at_rest(client: TestClient) -> None:
    login(client)
    plaintext = "p@ssw0rd-very-secret"
    r = client.post("/api/v1/snippets", json={"content": plaintext, "kind": "secret"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["content"] is None  # response redacted

    listed = client.get("/api/v1/snippets").json()
    assert listed[0]["kind"] == "secret"
    assert listed[0]["content"] is None  # list redacted

    stored = db_content(body["id"])
    assert stored is not None
    assert stored != plaintext  # ciphertext, not plaintext
    assert plaintext not in stored
    assert secretbox.decrypt(stored) == plaintext


def test_secret_ws_payload_redacted(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-ws-s", "Desktop")
    with client.websocket_connect("/ws?device=dev-ws-s") as ws:
        recv_until(ws, "peers")
        client.post("/api/v1/snippets", json={"content": "tr0ub4dor", "kind": "secret"})
        msg = recv_until(ws, "snippet-new")
        assert msg["snippet"]["content"] is None
        assert "tr0ub4dor" not in json.dumps(msg)


def test_reveal_returns_content_exactly_once(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-reveal", "Desktop")
    sid = client.post("/api/v1/snippets", json={"content": "burn me", "kind": "secret"}).json()[
        "id"
    ]

    first = client.post(f"/api/v1/snippets/{sid}/reveal")
    assert first.status_code == 200
    assert first.json()["content"] == "burn me"
    assert db_content(sid) is None  # burned from the DB

    second = client.post(f"/api/v1/snippets/{sid}/reveal")
    assert second.status_code == 410


def test_reveal_race_exactly_one_winner(client: TestClient) -> None:
    token = login(client)
    sid = client.post("/api/v1/snippets", json={"content": "hunter2", "kind": "secret"}).json()[
        "id"
    ]

    barrier = threading.Barrier(2)

    def attempt(_: int) -> tuple[int, str | None]:
        c = TestClient(client.app)  # own client per thread (Bearer → no CSRF header needed)
        barrier.wait()
        resp = c.post(
            f"/api/v1/snippets/{sid}/reveal",
            headers={"Authorization": f"Bearer {token}"},
        )
        return resp.status_code, resp.json().get("content") if resp.status_code == 200 else None

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, range(2)))

    assert sorted(status for status, _ in results) == [200, 410]
    winner_content = next(content for status, content in results if status == 200)
    assert winner_content == "hunter2"
    assert db_content(sid) is None


def test_reveal_broadcasts_snippet_deleted_with_revealed_by(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-ws-r", "Desktop")
    sid = client.post("/api/v1/snippets", json={"content": "zap", "kind": "secret"}).json()["id"]
    with client.websocket_connect("/ws?device=dev-ws-r") as ws:
        recv_until(ws, "peers")
        assert client.post(f"/api/v1/snippets/{sid}/reveal").status_code == 200
        msg = recv_until(ws, "snippet-deleted")
        assert msg == {"t": "snippet-deleted", "id": sid, "revealedBy": "dev-ws-r"}


def test_reveal_of_text_snippet_400(client: TestClient) -> None:
    login(client)
    sid = client.post("/api/v1/snippets", json={"content": "plain", "kind": "text"}).json()["id"]
    r = client.post(f"/api/v1/snippets/{sid}/reveal")
    assert r.status_code == 400
    assert db_content(sid) == "plain"  # not burned


def test_reveal_foreign_secret_410(client: TestClient) -> None:
    login(client)
    sid = client.post("/api/v1/snippets", json={"content": "mine", "kind": "secret"}).json()["id"]
    other = bob_client(client)
    assert other.post(f"/api/v1/snippets/{sid}/reveal").status_code == 410
    assert db_content(sid) is not None  # alice's secret survived bob's attempt


def test_delete_owner_only(client: TestClient) -> None:
    login(client)
    sid = client.post("/api/v1/snippets", json={"content": "bye", "kind": "text"}).json()["id"]

    other = bob_client(client)
    assert other.delete(f"/api/v1/snippets/{sid}").status_code == 404

    assert client.delete(f"/api/v1/snippets/{sid}").status_code == 204
    assert client.get("/api/v1/snippets").json() == []


def test_kind_validated(client: TestClient) -> None:
    login(client)
    r = client.post("/api/v1/snippets", json={"content": "x", "kind": "nuclear"})
    assert r.status_code == 422
    r = client.post("/api/v1/snippets", json={"content": "", "kind": "text"})
    assert r.status_code == 422
