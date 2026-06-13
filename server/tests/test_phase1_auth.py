"""Phase 1: Google OAuth callback + QR device-link + rate limits (PLAN.md §7)."""

from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from typing import Any

import pytest
from authlib.integrations.starlette_client import OAuthError
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import ratelimit
from app.auth import oauth as oauth_module
from app.auth.sessions import hash_token
from app.db import engine
from app.main import app
from app.models import AuthSession, DeviceLinkToken, User
from app.timeutil import utcnow
from tests.conftest import login


@pytest.fixture(autouse=True)
def reset_ratelimit():
    """Rate-limit counters are in-process and would leak across tests."""
    ratelimit.reset()
    yield
    ratelimit.reset()


@pytest.fixture
def pinned_clock(monkeypatch: pytest.MonkeyPatch):
    """Pin the limiter clock so a fixed-window boundary can't split a test."""
    monkeypatch.setattr(ratelimit, "_now", lambda: 1_000_000_000.0)


# ---------------------------------------------------------------------------
# OAuth callback (authorize_access_token monkeypatched — no network)

GOOD_CLAIMS: dict[str, Any] = {
    "sub": "google-sub-1",
    "email": "alice@example.com",
    "email_verified": True,
    "name": "Alice A",
    "picture": "https://example.com/a.png",
}


def fake_token_exchange(monkeypatch: pytest.MonkeyPatch, claims: dict[str, Any]) -> None:
    async def fake(request: Any) -> dict[str, Any]:
        return {"access_token": "x", "userinfo": claims}

    monkeypatch.setattr(oauth_module.oauth.google, "authorize_access_token", fake)


def callback(client: TestClient):
    return client.get("/api/v1/auth/callback?code=c&state=s", follow_redirects=False)


def test_oauth_callback_allowlisted_mints_session(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_token_exchange(monkeypatch, GOOD_CLAIMS)
    r = callback(client)
    assert r.status_code == 302
    assert r.headers["location"] == "/"
    assert "pontje_session=" in r.headers.get("set-cookie", "")
    with Session(engine) as db:
        user = db.exec(select(User).where(User.google_sub == "google-sub-1")).one()
        assert user.email == "alice@example.com"
        assert user.name == "Alice A"
        assert user.picture == "https://example.com/a.png"
        assert user.last_login is not None
        sess = db.exec(select(AuthSession).where(AuthSession.user_id == user.id)).one()
        assert sess.created_via == "oauth"
    # The cookie actually authenticates.
    me = client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "alice@example.com"


def test_oauth_callback_not_allowlisted(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_token_exchange(
        monkeypatch, {**GOOD_CLAIMS, "sub": "sub-x", "email": "intruder@example.com"}
    )
    r = callback(client)
    assert r.status_code == 302
    assert r.headers["location"] == "/?error=not_allowed"
    assert "pontje_session=" not in r.headers.get("set-cookie", "")
    with Session(engine) as db:
        assert db.exec(select(User)).all() == []
    assert client.get("/api/v1/auth/me").status_code == 401


def test_oauth_callback_unverified_email_rejected(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_token_exchange(monkeypatch, {**GOOD_CLAIMS, "email_verified": False})
    r = callback(client)
    assert r.headers["location"] == "/?error=not_allowed"
    with Session(engine) as db:
        assert db.exec(select(User)).all() == []


def test_oauth_callback_upserts_by_sub_no_duplicate(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    fake_token_exchange(monkeypatch, GOOD_CLAIMS)
    callback(client)
    # Same sub, changed name, email cased differently → update, not duplicate.
    fake_token_exchange(
        monkeypatch, {**GOOD_CLAIMS, "name": "Alice Renamed", "email": "Alice@Example.com"}
    )
    callback(client)
    with Session(engine) as db:
        users = db.exec(select(User).where(User.google_sub == "google-sub-1")).all()
        assert len(users) == 1
        assert users[0].name == "Alice Renamed"
        assert users[0].email == "alice@example.com"  # stored lowercased


def test_oauth_callback_oauth_error_redirects(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(request: Any) -> dict[str, Any]:
        raise OAuthError(error="mismatching_state")

    monkeypatch.setattr(oauth_module.oauth.google, "authorize_access_token", boom)
    r = callback(client)
    assert r.status_code == 302
    assert r.headers["location"] == "/?error=oauth"


# ---------------------------------------------------------------------------
# QR device-link


def mint(client: TestClient) -> dict[str, Any]:
    r = client.post("/api/v1/auth/device-link")
    assert r.status_code == 200, r.text
    return r.json()


def claim(client: TestClient, token: str):
    return client.post("/api/v1/auth/device-link/claim", json={"token": token})


def test_device_link_mint_requires_auth(client: TestClient) -> None:
    assert client.post("/api/v1/auth/device-link").status_code == 401


def test_device_link_mint_shape(client: TestClient) -> None:
    login(client)
    body = mint(client)
    assert body["link_url"] == f"http://testserver/link#lt={body['token']}"
    # sha256 at rest — never the raw token.
    with Session(engine) as db:
        row = db.exec(select(DeviceLinkToken)).one()
        assert row.token_hash == hash_token(body["token"])
        assert row.claimed_at is None
        assert row.expires_at > utcnow()


def test_device_link_claim_happy_path(client: TestClient) -> None:
    login(client)
    body = mint(client)

    claimer = TestClient(app)
    claimer.headers["X-Pontje"] = "1"
    r = claim(claimer, body["token"])
    assert r.status_code == 200
    session_token = r.json()["token"]
    assert session_token
    # Cookie set and authenticates...
    assert "pontje_session" in claimer.cookies
    me = claimer.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["created_via"] == "device_link"
    assert me.json()["device_id"] is None  # not bound until POST /devices
    # ...and the body token doubles as a Bearer token (Android-readiness).
    bare = TestClient(app)
    r2 = bare.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {session_token}"})
    assert r2.status_code == 200


def test_device_link_claim_expired_410(client: TestClient) -> None:
    login(client)
    token = "expired-token-value"
    with Session(engine) as db:
        user = db.exec(select(User)).one()
        db.add(
            DeviceLinkToken(
                token_hash=hash_token(token),
                user_id=user.id,
                expires_at=utcnow() - timedelta(seconds=1),
            )
        )
        db.commit()
    assert claim(client, token).status_code == 410


def test_device_link_claim_twice_second_410(client: TestClient) -> None:
    login(client)
    token = mint(client)["token"]
    claimer = TestClient(app)
    claimer.headers["X-Pontje"] = "1"
    assert claim(claimer, token).status_code == 200
    assert claim(claimer, token).status_code == 410


def test_device_link_claim_unknown_410(client: TestClient) -> None:
    assert claim(client, "never-minted").status_code == 410


def test_device_link_claim_race_exactly_one_winner(client: TestClient) -> None:
    login(client)
    token = mint(client)["token"]

    clients = [TestClient(app), TestClient(app)]

    def attempt(c: TestClient) -> int:
        return c.post(
            "/api/v1/auth/device-link/claim",
            json={"token": token},
            headers={"X-Pontje": "1"},
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as ex:
        codes = sorted(ex.map(attempt, clients))
    assert codes == [200, 410]


# ---------------------------------------------------------------------------
# Rate limits


def test_device_link_mint_rate_limited(client: TestClient, pinned_clock: None) -> None:
    login(client)
    for _ in range(10):
        assert client.post("/api/v1/auth/device-link").status_code == 200
    assert client.post("/api/v1/auth/device-link").status_code == 429


def test_device_link_claim_rate_limited_by_ip(client: TestClient, pinned_clock: None) -> None:
    for i in range(10):
        assert claim(client, f"junk-{i}").status_code == 410
    assert claim(client, "junk-11").status_code == 429


def test_allow_window_rolls_over(monkeypatch: pytest.MonkeyPatch) -> None:
    clock = [1_000_000_000.0]
    monkeypatch.setattr(ratelimit, "_now", lambda: clock[0])
    assert ratelimit.allow("k", 1, 60) is True
    assert ratelimit.allow("k", 1, 60) is False
    clock[0] += 60  # next window
    assert ratelimit.allow("k", 1, 60) is True
