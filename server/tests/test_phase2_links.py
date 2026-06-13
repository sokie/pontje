import pytest
from fastapi.testclient import TestClient

from tests.conftest import login, recv_until, register_device


@pytest.fixture(autouse=True)
def no_enrichment(monkeypatch: pytest.MonkeyPatch):
    """Keep API tests offline: the router still schedules the coroutine, but it no-ops."""

    async def _noop(link_id: str, client=None) -> None:
        return None

    monkeypatch.setattr("app.routers.links.enrich_link", _noop)


def bob_client(client: TestClient) -> TestClient:
    other = TestClient(client.app)
    other.headers["X-Pontje"] = "1"
    login(other, "bob@example.com")
    return other


def test_post_returns_immediately_with_hostname_title(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-link", "MacBook")
    r = client.post("/api/v1/links", json={"url": "https://www.youtube.com/watch?v=abc"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["title"] == "www.youtube.com"  # placeholder until enrichment lands
    # Host-rule categorization is instant (insert-time, no network); enrichment
    # only refines via og:type later.
    assert body["category"] == "video"
    assert body["from_device"] == "dev-link"
    assert body["url"] == "https://www.youtube.com/watch?v=abc"
    assert body["created_at"]


@pytest.mark.parametrize(
    "url", ["notaurl", "ftp://example.com/x", "javascript:alert(1)", "http://", ""]
)
def test_post_rejects_non_http_urls(client: TestClient, url: str) -> None:
    login(client)
    r = client.post("/api/v1/links", json={"url": url})
    assert r.status_code == 422


def test_post_unknown_session_404(client: TestClient) -> None:
    login(client)
    r = client.post("/api/v1/links", json={"url": "https://example.com", "session_id": "nope"})
    assert r.status_code == 404


def test_get_scoped_to_user_newest_first(client: TestClient) -> None:
    login(client)
    first = client.post("/api/v1/links", json={"url": "https://example.com/1"}).json()
    second = client.post("/api/v1/links", json={"url": "https://example.com/2"}).json()

    mine = client.get("/api/v1/links").json()
    assert [link["id"] for link in mine] == [second["id"], first["id"]]

    other = bob_client(client)
    assert other.get("/api/v1/links").json() == []


def test_delete_owner_only(client: TestClient) -> None:
    login(client)
    link = client.post("/api/v1/links", json={"url": "https://example.com/x"}).json()

    other = bob_client(client)
    assert other.delete(f"/api/v1/links/{link['id']}").status_code == 404

    assert client.delete(f"/api/v1/links/{link['id']}").status_code == 204
    assert client.get("/api/v1/links").json() == []
    # Idempotence: it is gone now.
    assert client.delete(f"/api/v1/links/{link['id']}").status_code == 404


def test_link_new_broadcast_reaches_ws(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-ws-l", "Desktop")
    with client.websocket_connect("/ws?device=dev-ws-l") as ws:
        recv_until(ws, "peers")
        created = client.post("/api/v1/links", json={"url": "https://example.com/live"}).json()
        msg = recv_until(ws, "link-new")
        assert msg["link"]["id"] == created["id"]
        assert msg["link"]["title"] == "example.com"
