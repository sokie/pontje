from fastapi.testclient import TestClient

from tests.conftest import login, register_device


def _share(client: TestClient, **overrides) -> dict:
    body = {"file_name": "holiday.jpg", "mime": "image/jpeg", "size_bytes": 123456}
    body.update(overrides)
    r = client.post("/api/v1/shared-files", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_share_requires_bound_device(client: TestClient) -> None:
    login(client)
    # dev-login binds no device — publishing an offer nothing could serve is a 400.
    r = client.post("/api/v1/shared-files", json={"file_name": "a.txt"})
    assert r.status_code == 400
    assert r.json()["detail"] == "no_device_bound"


def test_share_categorizes_and_tags_device(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-sharer", "Desktop")
    out = _share(client)
    assert out["category"] == "image"
    assert out["from_device"] == "dev-sharer"
    assert out["status"] == "active"
    assert out["size_bytes"] == 123456

    assert _share(client, file_name="movie.mkv", mime="video/x-matroska")["category"] == "video"
    assert _share(client, file_name="x.zip", mime=None)["category"] == "archive"
    assert _share(client, file_name="main.py", mime="text/x-python")["category"] == "code"
    assert _share(client, file_name="mystery.bin", mime=None)["category"] == "other"


def test_list_newest_first_includes_stale(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-sharer")
    first = _share(client, file_name="first.txt")
    second = _share(client, file_name="second.txt")
    r = client.post(f"/api/v1/shared-files/{first['id']}/stale")
    assert r.status_code == 200

    rows = client.get("/api/v1/shared-files").json()
    assert [f["id"] for f in rows].index(second["id"]) < [f["id"] for f in rows].index(first["id"])
    by_id = {f["id"]: f for f in rows}
    assert by_id[first["id"]]["status"] == "stale"  # stale stays listed (UI greys it)
    assert by_id[second["id"]]["status"] == "active"


def test_stale_idempotent_and_any_own_device(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-sharer")
    shared = _share(client)

    # Another device of the SAME user (fresh client = fresh session) may report.
    other_device = TestClient(client.app)
    other_device.headers["X-Pontje"] = "1"
    login(other_device)
    register_device(other_device, "dev-puller", "Phone")
    for _ in range(2):  # idempotent: repeated reports keep status="stale"
        r = other_device.post(f"/api/v1/shared-files/{shared['id']}/stale")
        assert r.status_code == 200
        assert r.json()["status"] == "stale"


def test_unshare_owner_only(client: TestClient) -> None:
    login(client, "alice@example.com")
    register_device(client, "dev-a")
    shared = _share(client)

    foreign = TestClient(client.app)
    foreign.headers["X-Pontje"] = "1"
    login(foreign, "bob@example.com")
    assert foreign.delete(f"/api/v1/shared-files/{shared['id']}").status_code == 404
    assert foreign.post(f"/api/v1/shared-files/{shared['id']}/stale").status_code == 404

    assert client.delete(f"/api/v1/shared-files/{shared['id']}").status_code == 204
    assert client.get("/api/v1/shared-files").json() == []
    # Re-deleting is a 404 — the row is gone.
    assert client.delete(f"/api/v1/shared-files/{shared['id']}").status_code == 404


def test_scoped_to_user(client: TestClient) -> None:
    login(client, "alice@example.com")
    register_device(client, "dev-a")
    _share(client)
    assert len(client.get("/api/v1/shared-files").json()) == 1

    other = TestClient(client.app)
    other.headers["X-Pontje"] = "1"
    login(other, "bob@example.com")
    assert other.get("/api/v1/shared-files").json() == []


def test_requires_auth(client: TestClient) -> None:
    assert client.get("/api/v1/shared-files").status_code == 401
    assert client.post("/api/v1/shared-files", json={"file_name": "a"}).status_code == 401
    assert client.delete("/api/v1/shared-files/nope").status_code == 401
    assert client.post("/api/v1/shared-files/nope/stale").status_code == 401
