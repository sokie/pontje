import os
import tempfile

# Must be set before any `app.*` import — config/db read env at import time.
os.environ["PONTJE_DB_PATH"] = os.path.join(tempfile.mkdtemp(prefix="pontje-test-"), "test.db")
os.environ["PONTJE_DEV_FAKE_LOGIN"] = "1"
os.environ["PONTJE_ALLOWED_EMAILS"] = "alice@example.com,bob@example.com"
os.environ["PONTJE_PUBLIC_BASE_URL"] = "http://testserver"
os.environ["PONTJE_GOOGLE_CLIENT_ID"] = "test-client-id"
os.environ["PONTJE_GOOGLE_CLIENT_SECRET"] = "test-client-secret"
# Pin AI off regardless of the developer's server/.env (env vars beat env_file)
# — tests opt in explicitly via the ai_on fixture.
os.environ["PONTJE_AI_DISABLED"] = "0"
os.environ["PONTJE_LLM_BASE_URL"] = ""
os.environ["PONTJE_LLM_MODEL"] = ""
os.environ["PONTJE_LLM_API_KEY"] = ""

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlmodel import SQLModel  # noqa: E402

from app.db import engine, init_db  # noqa: E402
from app.main import app  # noqa: E402
from app.ws.presence import hub  # noqa: E402


@pytest.fixture(autouse=True)
def clean_db():
    init_db()
    # The presence hub is an in-memory singleton (PLAN.md §18) shared across
    # tests — drop any sockets a prior test left registered so WS message
    # ordering stays deterministic regardless of run order.
    hub._conns.clear()
    yield
    hub._conns.clear()
    with engine.begin() as conn:
        for table in reversed(SQLModel.metadata.sorted_tables):
            conn.execute(table.delete())


@pytest.fixture
def client():
    # Per-test client → isolated cookie jar. raise_server_exceptions kept default.
    with TestClient(app) as c:
        c.headers["X-Pontje"] = "1"
        yield c


def login(client: TestClient, email: str = "alice@example.com") -> str:
    """Dev-login helper: sets the session cookie on the client, returns the Bearer token."""
    r = client.post("/api/v1/auth/dev-login", json={"email": email})
    assert r.status_code == 200, r.text
    return r.json()["token"]


def register_device(client: TestClient, device_id: str, name: str = "Test Device") -> dict:
    r = client.post(
        "/api/v1/devices", json={"id": device_id, "name": name, "platform": "other"}
    )
    assert r.status_code == 200, r.text
    return r.json()


def recv_until(ws, t: str, limit: int = 12) -> dict:
    """Read frames until one of type t, skipping interleaved presence/session
    churn (peers/peer-online/peer-offline/session-state) and async enrichment
    pushes that race real frames when sockets connect or drop.

    Presence ordering across concurrently-connecting sockets is genuinely
    non-deterministic — a peer's snapshot awaits a threadpool DB read while it is
    already a broadcast target, and a closed socket's peer-offline fires from a
    background task — so tests target the frame they care about rather than
    asserting an exact sequence.
    """
    for _ in range(limit):
        msg = ws.receive_json()
        if msg["t"] == t:
            return msg
    raise AssertionError(f"no {t!r} frame within {limit} messages")
