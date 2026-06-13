"""§23 hardening: production-config fail-fast + WebSocket CSWSH Origin check.

The suite runs with PONTJE_PUBLIC_BASE_URL=http://testserver (conftest), i.e.
non-production, so both guards are inert by default. These tests force the
production signal (https base URL) explicitly to exercise them.
"""

import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app import ratelimit
from app.config import Settings, settings
from tests.conftest import login, recv_until, register_device


@pytest.fixture(autouse=True)
def reset_ratelimit():
    ratelimit.reset()
    yield
    ratelimit.reset()


# ---- B1: security headers on every response --------------------------------


def test_security_headers_present_on_api_response(client: TestClient) -> None:
    r = client.get("/api/v1/healthz")
    assert r.status_code == 200
    assert "default-src 'self'" in r.headers["content-security-policy"]
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.headers["referrer-policy"] == "strict-origin-when-cross-origin"
    assert r.headers["x-frame-options"] == "DENY"
    # http testserver → not production → no HSTS (browsers ignore it over http).
    assert "strict-transport-security" not in r.headers


def test_hsts_only_in_production(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "public_base_url", "https://pontje.example.com")
    r = client.get("/api/v1/healthz")
    assert r.headers["strict-transport-security"] == "max-age=31536000; includeSubDomains"


# ---- B2: boot-time fail-fast for production secrets ------------------------


def _prod_settings(**overrides) -> Settings:
    """A fully valid production config; override one field to test each guard.
    Init kwargs outrank the conftest PONTJE_* env vars in pydantic-settings."""
    base = dict(
        public_base_url="https://pontje.example.com",
        session_secret="s" * 32,
        secret_key=Fernet.generate_key().decode(),
        google_client_id="client-id",
        google_client_secret="client-secret",
        allowed_emails="you@example.com",
        dev_fake_login=False,
    )
    base.update(overrides)
    return Settings(**base)


def test_valid_production_config_boots() -> None:
    _prod_settings().assert_production_ready()  # must not raise


def test_dev_http_config_skips_all_checks() -> None:
    # Plain-http localhost keeps every friendly default (default session_secret,
    # empty secret_key, dev_fake_login on) — the suite itself relies on this.
    Settings(
        public_base_url="http://localhost:5173",
        dev_fake_login=True,
        session_secret="dev-only-not-a-secret",
        secret_key="",
    ).assert_production_ready()


def test_default_session_secret_in_production_fails() -> None:
    with pytest.raises(RuntimeError, match="SESSION_SECRET"):
        _prod_settings(session_secret="dev-only-not-a-secret").assert_production_ready()


def test_short_session_secret_in_production_fails() -> None:
    with pytest.raises(RuntimeError, match="SESSION_SECRET"):
        _prod_settings(session_secret="too-short").assert_production_ready()


def test_missing_secret_key_in_production_fails() -> None:
    with pytest.raises(RuntimeError, match="SECRET_KEY"):
        _prod_settings(secret_key="").assert_production_ready()


def test_invalid_fernet_secret_key_in_production_fails() -> None:
    with pytest.raises(RuntimeError, match="Fernet"):
        _prod_settings(secret_key="not-a-valid-fernet-key").assert_production_ready()


def test_dev_fake_login_in_production_fails() -> None:
    with pytest.raises(RuntimeError, match="DEV_FAKE_LOGIN"):
        _prod_settings(dev_fake_login=True).assert_production_ready()


def test_missing_google_or_allowlist_in_production_fails() -> None:
    with pytest.raises(RuntimeError, match="GOOGLE_CLIENT_ID"):
        _prod_settings(google_client_id="").assert_production_ready()
    with pytest.raises(RuntimeError, match="ALLOWED_EMAILS"):
        _prod_settings(allowed_emails="").assert_production_ready()


# ---- B3: WebSocket Origin check (CSWSH) ------------------------------------
#
# Auth over Bearer (not cookie) so flipping cookie_secure→True for the prod
# signal can't strip a Secure cookie the http TestClient would refuse to resend.
# Device registration runs first, while the base URL is still http.


def test_ws_foreign_origin_rejected_in_production(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = login(client)
    register_device(client, "dev-a", "A")
    monkeypatch.setattr(settings, "public_base_url", "https://pontje.example.com")

    with (
        client.websocket_connect(
            "/ws?device=dev-a",
            headers={"Authorization": f"Bearer {token}", "Origin": "https://evil.example"},
        ) as ws,
        pytest.raises(WebSocketDisconnect) as exc,
    ):
        ws.receive_json()
    assert exc.value.code == 4401


def test_ws_matching_origin_and_native_allowed_in_production(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    token = login(client)
    register_device(client, "dev-a", "A")
    monkeypatch.setattr(settings, "public_base_url", "https://pontje.example.com")

    # Same-origin browser handshake → passes the guard, normal presence snapshot.
    with client.websocket_connect(
        "/ws?device=dev-a",
        headers={"Authorization": f"Bearer {token}", "Origin": "https://pontje.example.com"},
    ) as ws:
        recv_until(ws, "peers")

    # Native Bearer client (no Origin header) → allowed.
    with client.websocket_connect(
        "/ws?device=dev-a", headers={"Authorization": f"Bearer {token}"}
    ) as ws:
        recv_until(ws, "peers")


def test_ws_foreign_origin_allowed_in_dev_http(client: TestClient) -> None:
    # Default conftest config is http → the guard is skipped, so LAN-IP phone
    # testing (a "foreign" Origin to the server's own URL) keeps working.
    token = login(client)
    register_device(client, "dev-a", "A")
    with client.websocket_connect(
        "/ws?device=dev-a",
        headers={"Authorization": f"Bearer {token}", "Origin": "http://192.168.1.50:5173"},
    ) as ws:
        recv_until(ws, "peers")
