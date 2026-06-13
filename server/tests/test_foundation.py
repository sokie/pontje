from fastapi.testclient import TestClient

from tests.conftest import login, register_device


def test_me_requires_auth(client: TestClient) -> None:
    assert client.get("/api/v1/auth/me").status_code == 401


def test_dev_login_allowlist(client: TestClient) -> None:
    r = client.post("/api/v1/auth/dev-login", json={"email": "intruder@example.com"})
    assert r.status_code == 403


def test_dev_login_me_and_bearer(client: TestClient) -> None:
    token = login(client)
    me = client.get("/api/v1/auth/me").json()
    assert me["user"]["email"] == "alice@example.com"

    # Bearer path works without any cookie (Android-readiness).
    bare = TestClient(client.app)
    r = bare.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert r.status_code == 200


def test_csrf_header_required_on_cookie_mutations(client: TestClient) -> None:
    login(client)
    del client.headers["X-Pontje"]
    r = client.post("/api/v1/devices", json={"id": "d1", "name": "PC"})
    assert r.status_code == 403
    # Bearer-authed mutation is exempt from the CSRF header.
    token_client = TestClient(client.app)
    token = login(token_client)
    bare = TestClient(client.app)
    r = bare.post(
        "/api/v1/devices",
        json={"id": "d2", "name": "PC"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert r.status_code == 200


def test_device_registration_binds_session(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-abc", "MacBook")
    me = client.get("/api/v1/auth/me").json()
    assert me["device_id"] == "dev-abc"
    devices = client.get("/api/v1/devices").json()
    assert [d["id"] for d in devices] == ["dev-abc"]
    assert devices[0]["online"] is False


def test_device_id_collision_across_users(client: TestClient) -> None:
    login(client, "alice@example.com")
    register_device(client, "shared-id")
    other = TestClient(client.app)
    other.headers["X-Pontje"] = "1"
    login(other, "bob@example.com")
    r = other.post("/api/v1/devices", json={"id": "shared-id", "name": "Evil"})
    assert r.status_code == 409


def test_ws_rejects_unauthenticated(client: TestClient) -> None:
    with client.websocket_connect("/ws?device=nope") as ws:
        # Server accepts then closes with 4401; receive surfaces the disconnect.
        import pytest
        from starlette.websockets import WebSocketDisconnect

        with pytest.raises(WebSocketDisconnect) as exc:
            ws.receive_json()
        assert exc.value.code == 4401


def test_ws_presence_snapshot_and_deltas(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "Desktop")
    register_device(client, "dev-b", "Laptop")

    with client.websocket_connect("/ws?device=dev-a") as ws_a:
        snap = ws_a.receive_json()
        assert snap["t"] == "peers"
        assert snap["protocolVersion"] == 1
        assert {p["deviceId"] for p in snap["peers"]} == {"dev-a", "dev-b"}

        with client.websocket_connect("/ws?device=dev-b") as ws_b:
            snap_b = ws_b.receive_json()
            online = {p["deviceId"] for p in snap_b["peers"] if p["online"]}
            assert "dev-a" in online
            evt = ws_a.receive_json()
            assert evt == {"t": "peer-online", "deviceId": "dev-b"}

        evt = ws_a.receive_json()
        assert evt["t"] == "peer-offline"
        assert evt["deviceId"] == "dev-b"
        assert evt["lastSeen"]
