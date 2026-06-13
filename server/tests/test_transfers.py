from fastapi.testclient import TestClient

from tests.conftest import login, register_device


def _log(client: TestClient, **overrides) -> dict:
    body = {
        "file_name": "holiday.jpg",
        "mime": "image/jpeg",
        "size_bytes": 123456,
        "to_device": None,
        "network_path": "lan",
        "status": "completed",
    }
    body.update(overrides)
    r = client.post("/api/v1/transfers", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_log_transfer_categorizes_and_tags_sender(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-sender", "Desktop")
    out = _log(client)
    assert out["category"] == "image"
    assert out["from_device"] == "dev-sender"
    assert out["network_path"] == "lan"

    assert _log(client, file_name="movie.mkv", mime="video/x-matroska")["category"] == "video"
    assert _log(client, file_name="x.zip", mime=None)["category"] == "archive"
    assert _log(client, file_name="main.py", mime="text/x-python")["category"] == "code"
    assert _log(client, file_name="notes.txt", mime="text/plain")["category"] == "document"
    assert _log(client, file_name="mystery.bin", mime=None)["category"] == "other"


def test_log_transfer_validates_enums(client: TestClient) -> None:
    login(client)
    r = client.post("/api/v1/transfers", json={"file_name": "a", "status": "nope"})
    assert r.status_code == 422
    r = client.post(
        "/api/v1/transfers",
        json={"file_name": "a", "status": "completed", "network_path": "carrier-pigeon"},
    )
    assert r.status_code == 422


def test_transfers_scoped_to_user(client: TestClient) -> None:
    login(client, "alice@example.com")
    _log(client)
    assert len(client.get("/api/v1/transfers").json()) == 1

    other = TestClient(client.app)
    other.headers["X-Pontje"] = "1"
    login(other, "bob@example.com")
    assert other.get("/api/v1/transfers").json() == []


def test_transfers_newest_first(client: TestClient) -> None:
    login(client)
    a = _log(client, file_name="first.txt")
    b = _log(client, file_name="second.txt")
    names = [t["file_name"] for t in client.get("/api/v1/transfers").json()]
    assert names.index(b["file_name"]) < names.index(a["file_name"])


def test_transfers_require_auth(client: TestClient) -> None:
    assert client.get("/api/v1/transfers").status_code == 401
