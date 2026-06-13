from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_healthz() -> None:
    r = client.get("/api/v1/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["version"]


def test_openapi_has_clean_operation_ids() -> None:
    schema = client.get("/api/v1/openapi.json").json()
    assert schema["paths"]["/api/v1/healthz"]["get"]["operationId"] == "healthz"
