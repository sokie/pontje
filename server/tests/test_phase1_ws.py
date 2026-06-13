"""Phase 1: WS rtc-* relay authorization matrix (PLAN.md §9)."""

import pytest
from fastapi.testclient import TestClient

from app import ratelimit
from app.main import app
from tests.conftest import login, recv_until, register_device


@pytest.fixture(autouse=True)
def reset_ratelimit():
    ratelimit.reset()
    yield
    ratelimit.reset()


def test_rtc_relayed_intact_between_same_user_devices(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "A")
    register_device(client, "dev-b", "B")
    with (
        client.websocket_connect("/ws?device=dev-a") as ws_a,
        client.websocket_connect("/ws?device=dev-b") as ws_b,
    ):
        recv_until(ws_a, "peers")
        recv_until(ws_b, "peers")

        offer = {"t": "rtc-offer", "to": "dev-b", "from": "dev-a", "sdp": "v=0 fake-offer"}
        ws_a.send_json(offer)
        assert recv_until(ws_b, "rtc-offer") == offer  # full original message, untouched

        answer = {"t": "rtc-answer", "to": "dev-a", "from": "dev-b", "sdp": "v=0 fake-answer"}
        ws_b.send_json(answer)
        assert recv_until(ws_a, "rtc-answer") == answer

        ice = {
            "t": "rtc-ice",
            "to": "dev-b",
            "from": "dev-a",
            "candidate": {"candidate": "candidate:1 1 udp 1 10.0.0.1 1 typ host"},
        }
        ws_a.send_json(ice)
        assert recv_until(ws_b, "rtc-ice") == ice


def test_rtc_same_user_offline_target_errors(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "A")
    register_device(client, "dev-b", "B")  # registered but never connects
    with client.websocket_connect("/ws?device=dev-a") as ws_a:
        recv_until(ws_a, "peers")
        ws_a.send_json({"t": "rtc-offer", "to": "dev-b", "from": "dev-a", "sdp": "x"})
        assert recv_until(ws_a, "error")["code"] == "target_offline"


def test_rtc_foreign_target_unauthorized_and_not_delivered(client: TestClient) -> None:
    login(client, "alice@example.com")
    register_device(client, "dev-a", "Alice PC")

    bob = TestClient(app)
    bob.headers["X-Pontje"] = "1"
    bob_token = login(bob, "bob@example.com")
    r = bob.post("/api/v1/devices", json={"id": "dev-bob", "name": "Bob Phone"})
    assert r.status_code == 200

    # Bob's socket runs through the same client/portal (Bearer wins over cookie)
    # so the presence hub stays loop-confined, as in production.
    with (
        client.websocket_connect("/ws?device=dev-a") as ws_a,
        client.websocket_connect(
            "/ws?device=dev-bob", headers={"Authorization": f"Bearer {bob_token}"}
        ) as ws_bob,
    ):
        recv_until(ws_a, "peers")
        recv_until(ws_bob, "peers")

        ws_a.send_json({"t": "rtc-offer", "to": "dev-bob", "from": "dev-a", "sdp": "x"})
        assert recv_until(ws_a, "error")["code"] == "unauthorized_target"

        # Receiving Alice's error proves her frame was fully dispatched; Bob's
        # next rtc frame being his own loopback marker proves nothing was relayed.
        marker = {"t": "rtc-ice", "to": "dev-bob", "from": "dev-bob", "candidate": "marker"}
        ws_bob.send_json(marker)
        assert recv_until(ws_bob, "rtc-ice") == marker


def test_rtc_spoofed_from_rejected(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "A")
    register_device(client, "dev-b", "B")
    with (
        client.websocket_connect("/ws?device=dev-a") as ws_a,
        client.websocket_connect("/ws?device=dev-b") as ws_b,
    ):
        recv_until(ws_a, "peers")
        recv_until(ws_b, "peers")

        ws_a.send_json({"t": "rtc-offer", "to": "dev-b", "from": "dev-b", "sdp": "spoof"})
        err = recv_until(ws_a, "error")
        assert err["code"] == "invalid_from"

        # dev-b never saw the spoofed frame: its next frame is its own loopback.
        marker = {"t": "rtc-ice", "to": "dev-b", "from": "dev-b", "candidate": "marker"}
        ws_b.send_json(marker)
        assert recv_until(ws_b, "rtc-ice") == marker


def test_rtc_missing_target_errors(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "A")
    with client.websocket_connect("/ws?device=dev-a") as ws_a:
        recv_until(ws_a, "peers")
        ws_a.send_json({"t": "rtc-offer", "from": "dev-a", "sdp": "x"})
        assert recv_until(ws_a, "error")["code"] == "invalid_target"


def test_unknown_message_type_still_errors(client: TestClient) -> None:
    login(client)
    register_device(client, "dev-a", "A")
    with client.websocket_connect("/ws?device=dev-a") as ws_a:
        recv_until(ws_a, "peers")
        ws_a.send_json({"t": "mystery"})
        assert recv_until(ws_a, "error")["code"] == "unknown_type"
