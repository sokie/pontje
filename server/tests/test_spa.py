from pathlib import Path

from fastapi.testclient import TestClient

from app.config import settings
from app.main import create_app


def make_spa_client(tmp_path: Path, monkeypatch) -> TestClient:
    (tmp_path / "index.html").write_text("<html>pontje-spa</html>")
    (tmp_path / "asset.js").write_text("console.log(1)")
    monkeypatch.setattr(settings, "static_dir", str(tmp_path))
    return TestClient(create_app())


def test_spa_serves_index_and_assets(tmp_path: Path, monkeypatch) -> None:
    client = make_spa_client(tmp_path, monkeypatch)
    assert "pontje-spa" in client.get("/").text
    assert client.get("/asset.js").status_code == 200


def test_spa_fallback_for_client_routes(tmp_path: Path, monkeypatch) -> None:
    client = make_spa_client(tmp_path, monkeypatch)
    for route in ("/link", "/share", "/some/deep/route"):
        r = client.get(route)
        assert r.status_code == 200, route
        assert "pontje-spa" in r.text


def test_spa_share_post_303(tmp_path: Path, monkeypatch) -> None:
    client = make_spa_client(tmp_path, monkeypatch)
    r = client.post("/share", follow_redirects=False)
    assert r.status_code == 303
    assert r.headers["location"] == "/"


def test_spa_api_still_routes(tmp_path: Path, monkeypatch) -> None:
    client = make_spa_client(tmp_path, monkeypatch)
    assert client.get("/api/v1/healthz").json()["status"] == "ok"


def test_static_mode_off_by_default(client: TestClient) -> None:
    # Without PONTJE_STATIC_DIR the API 404s non-API paths (Caddy serves the SPA).
    assert client.get("/link").status_code == 404
