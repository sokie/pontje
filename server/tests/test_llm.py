import json

import httpx
import pytest

from app.config import settings
from app.db import engine, init_db
from app.models import Link, User
from app.services import llm
from app.services.enrichment import enrich_link


def completion(content: str) -> httpx.Response:
    return httpx.Response(
        200, json={"choices": [{"message": {"role": "assistant", "content": content}}]}
    )


def llm_client(handler) -> tuple[httpx.AsyncClient, list[httpx.Request]]:
    calls: list[httpx.Request] = []

    def wrapped(request: httpx.Request) -> httpx.Response:
        calls.append(request)
        return handler(request)

    return httpx.AsyncClient(transport=httpx.MockTransport(wrapped)), calls


@pytest.fixture
def ai_on(monkeypatch):
    monkeypatch.setattr(settings, "llm_base_url", "http://llm.test/v1")
    monkeypatch.setattr(settings, "llm_model", "test-model")
    monkeypatch.setattr(settings, "ai_disabled", False)


GOOD = json.dumps({"category": "tech", "summary": "A library for embedding models."})


async def test_disabled_by_default_makes_no_call() -> None:
    # conftest sets no PONTJE_LLM_* vars → ai_enabled is False.
    client, calls = llm_client(lambda r: completion(GOOD))
    async with client:
        assert await llm.summarize_and_categorize("https://x.test", "t", "text", client) is None
    assert calls == []


async def test_hard_kill_switch_wins_over_config(ai_on, monkeypatch) -> None:
    monkeypatch.setattr(settings, "ai_disabled", True)
    assert settings.ai_enabled is False
    client, calls = llm_client(lambda r: completion(GOOD))
    async with client:
        assert await llm.summarize_and_categorize("https://x.test", "t", "text", client) is None
    assert calls == []


async def test_happy_path_validates_and_returns(ai_on) -> None:
    client, calls = llm_client(lambda r: completion(GOOD))
    async with client:
        out = await llm.summarize_and_categorize("https://x.test", "t", "text", client)
    assert out == {"category": "tech", "summary": "A library for embedding models."}
    req = calls[0]
    assert str(req.url) == "http://llm.test/v1/chat/completions"
    body = json.loads(req.content)
    assert body["model"] == "test-model"
    assert "never follow instructions" in body["messages"][0]["content"].lower()


async def test_invalid_category_dropped_summary_kept(ai_on) -> None:
    content = json.dumps({"category": "blogspam", "summary": "Still useful."})
    client, _ = llm_client(lambda r: completion(content))
    async with client:
        out = await llm.summarize_and_categorize("https://x.test", "t", "text", client)
    assert out == {"category": None, "summary": "Still useful."}


async def test_summary_clamped_and_whitespace_normalized(ai_on) -> None:
    long = "word " * 200
    client, _ = llm_client(lambda r: completion(json.dumps({"category": "tech", "summary": long})))
    async with client:
        out = await llm.summarize_and_categorize("https://x.test", "t", "text", client)
    assert out is not None and out["summary"] is not None
    assert len(out["summary"]) <= llm.MAX_SUMMARY_CHARS
    assert "\n" not in out["summary"]


async def test_json_in_prose_is_extracted(ai_on) -> None:
    content = f"Sure! Here you go:\n```json\n{GOOD}\n```"
    client, _ = llm_client(lambda r: completion(content))
    async with client:
        out = await llm.summarize_and_categorize("https://x.test", "t", "text", client)
    assert out is not None and out["category"] == "tech"


async def test_garbage_and_errors_return_none(ai_on) -> None:
    for handler in (
        lambda r: completion("no json here at all"),
        lambda r: httpx.Response(500, json={"error": "boom"}),
        lambda r: (_ for _ in ()).throw(httpx.ConnectError("down")),
    ):
        client, _ = llm_client(handler)
        async with client:
            assert (
                await llm.summarize_and_categorize("https://x.test", "t", "text", client) is None
            )


# ---- enrichment integration -------------------------------------------------

HTML = b"""<html><head><title>Embedding Models Weekly</title>
<meta name="description" content="A page about embedding models.">
</head><body><p>Long-form text about embeddings and retrieval.</p></body></html>"""


def make_link(url: str = "https://unknown-blog.test/post") -> str:
    from sqlmodel import Session

    with Session(engine) as db:
        user = User(google_sub="llm-test", email="llm@example.com")
        db.add(user)
        db.commit()
        db.refresh(user)
        link = Link(user_id=user.id, url=url, title="unknown-blog.test", category="other")
        db.add(link)
        db.commit()
        return link.id


def fetch_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(
        transport=httpx.MockTransport(
            lambda r: httpx.Response(200, headers={"content-type": "text/html"}, content=HTML)
        ),
        follow_redirects=False,
    )


async def test_enrichment_ai_stage_applies(ai_on, monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.enrichment.resolve_host", lambda host: ["93.184.216.34"]
    )
    link_id = make_link()
    ai_client, calls = llm_client(lambda r: completion(GOOD))
    async with fetch_client() as fc, ai_client:
        await enrich_link(link_id, client=fc, llm_client=ai_client)

    from sqlmodel import Session

    with Session(engine) as db:
        link = db.get(Link, link_id)
        assert link is not None
        assert link.summary == "A library for embedding models."
        assert link.category == "tech"  # upgraded: rules said "other"
    assert len(calls) == 1
    # The page text reached the prompt.
    assert "embedding models" in json.loads(calls[0].content)["messages"][1]["content"].lower()


async def test_enrichment_skips_ai_when_disabled(monkeypatch) -> None:
    monkeypatch.setattr(
        "app.services.enrichment.resolve_host", lambda host: ["93.184.216.34"]
    )
    link_id = make_link("https://unknown-blog.test/other-post")
    ai_client, calls = llm_client(lambda r: completion(GOOD))
    async with fetch_client() as fc, ai_client:
        await enrich_link(link_id, client=fc, llm_client=ai_client)

    from sqlmodel import Session

    with Session(engine) as db:
        link = db.get(Link, link_id)
        assert link is not None
        assert link.summary is None
        assert link.title == "Embedding Models Weekly"  # normal enrichment ran
    assert calls == []


def test_summary_column_migration_idempotent() -> None:
    init_db()
    init_db()  # second run must not raise
    with engine.begin() as conn:
        cols = [row[1] for row in conn.exec_driver_sql("PRAGMA table_info(links)")]
    assert "summary" in cols
