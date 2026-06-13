"""Enrichment + SSRF guard tests — MockTransport for HTTP, patched resolver for DNS."""

import httpx
import pytest
from sqlmodel import Session

from app.db import engine
from app.models import Link, User
from app.services import enrichment

PUBLIC_IP = "93.184.216.34"

# Hostname → resolved addresses, installed via the patched resolver below.
RESOLVE_MAP = {
    "public.example": [PUBLIC_IP],
    "hop2.example": [PUBLIC_IP],
    "hop3.example": [PUBLIC_IP],
    "hop4.example": [PUBLIC_IP],
    "hop5.example": [PUBLIC_IP],
    "internal.example": ["10.0.0.5"],
    "www.youtube.com": [PUBLIC_IP],
}


@pytest.fixture
def patched_resolver(monkeypatch: pytest.MonkeyPatch):
    def fake_resolve(host: str) -> list[str]:
        if host in RESOLVE_MAP:
            return RESOLVE_MAP[host]
        raise OSError(f"unresolvable test host {host!r}")

    monkeypatch.setattr(enrichment, "resolve_host", fake_resolve)


def make_link(url: str, title: str) -> str:
    with Session(engine) as db:
        user = User(google_sub="dev:enrich@example.com", email="enrich@example.com")
        db.add(user)
        db.flush()
        link = Link(user_id=user.id, url=url, title=title)
        db.add(link)
        db.commit()
        return link.id


def get_link(link_id: str) -> Link | None:
    with Session(engine) as db:
        return db.get(Link, link_id)


@pytest.mark.parametrize(
    "address",
    ["127.0.0.1", "10.0.0.5", "192.168.1.1", "169.254.1.1", "::1", "0.0.0.0"],
)
def test_validate_host_rejects_internal(monkeypatch: pytest.MonkeyPatch, address: str) -> None:
    monkeypatch.setattr(enrichment, "resolve_host", lambda host: [address])
    assert enrichment.validate_host("evil.example") is False


def test_validate_host_rejects_if_any_address_internal(monkeypatch: pytest.MonkeyPatch) -> None:
    # DNS answers with one public and one private record → still rejected.
    monkeypatch.setattr(enrichment, "resolve_host", lambda host: [PUBLIC_IP, "127.0.0.1"])
    assert enrichment.validate_host("evil.example") is False


def test_validate_host_accepts_public(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(enrichment, "resolve_host", lambda host: [PUBLIC_IP])
    assert enrichment.validate_host("public.example") is True


def test_validate_host_resolution_failure(monkeypatch: pytest.MonkeyPatch) -> None:
    def boom(host: str) -> list[str]:
        raise OSError("NXDOMAIN")

    monkeypatch.setattr(enrichment, "resolve_host", boom)
    assert enrichment.validate_host("nope.invalid") is False


async def test_redirect_to_internal_host_aborts(patched_resolver) -> None:
    """Hop 2 points at a private address — the per-hop guard must abort."""
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.host)
        if request.url.host == "public.example":
            return httpx.Response(302, headers={"location": "http://internal.example/secret"})
        return httpx.Response(200, headers={"content-type": "text/html"}, text="<title>x</title>")

    link_id = make_link("http://public.example/start", "public.example")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    await enrichment.enrich_link(link_id, client=client)
    await client.aclose()

    assert requested == ["public.example"]  # internal.example was never contacted
    link = get_link(link_id)
    assert link is not None
    assert link.title == "public.example"  # untouched
    assert link.category == "other"


async def test_redirect_chain_longer_than_three_hops_aborts(patched_resolver) -> None:
    chain = {
        "public.example": "http://hop2.example/",
        "hop2.example": "http://hop3.example/",
        "hop3.example": "http://hop4.example/",
        "hop4.example": "http://hop5.example/",
    }
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(request.url.host)
        nxt = chain.get(request.url.host)
        if nxt:
            return httpx.Response(301, headers={"location": nxt})
        return httpx.Response(
            200, headers={"content-type": "text/html"}, text="<title>too far</title>"
        )

    link_id = make_link("http://public.example/", "public.example")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    await enrichment.enrich_link(link_id, client=client)
    await client.aclose()

    # Initial request + 3 followed redirects = 4; the 4th answer redirects again → abort.
    assert requested == ["public.example", "hop2.example", "hop3.example", "hop4.example"]
    link = get_link(link_id)
    assert link is not None
    assert link.title == "public.example"


async def test_non_http_redirect_target_aborts(patched_resolver) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "file:///etc/passwd"})

    link_id = make_link("http://public.example/", "public.example")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    await enrichment.enrich_link(link_id, client=client)
    await client.aclose()

    link = get_link(link_id)
    assert link is not None
    assert link.title == "public.example"


async def test_non_html_content_type_ignored(patched_resolver) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, headers={"content-type": "application/json"}, text='{"title": "nope"}'
        )

    link_id = make_link("http://public.example/data", "public.example")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    await enrichment.enrich_link(link_id, client=client)
    await client.aclose()

    link = get_link(link_id)
    assert link is not None
    assert link.title == "public.example"


async def test_happy_path_extracts_title_and_category(patched_resolver) -> None:
    """One public redirect, then HTML with og tags → title + og:type category."""
    html = """
    <html><head>
      <title>Fallback Title</title>
      <meta property="og:title" content="A Great Video" />
      <meta property="og:site_name" content="Example Site" />
      <meta property="og:type" content="video.other" />
    </head><body>hi</body></html>
    """

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "public.example":
            return httpx.Response(302, headers={"location": "http://hop2.example/page"})
        return httpx.Response(
            200, headers={"content-type": "text/html; charset=utf-8"}, text=html
        )

    link_id = make_link("http://public.example/v/1", "public.example")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    await enrichment.enrich_link(link_id, client=client)
    await client.aclose()

    link = get_link(link_id)
    assert link is not None
    assert link.title == "A Great Video"  # og:title beats <title>
    assert link.category == "video"  # og:type fallback (host not in rules)


async def test_happy_path_host_rule_and_title_fallback(patched_resolver) -> None:
    """No og:title → <title> used; categorized off the FINAL url's hostname."""

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.host == "public.example":
            return httpx.Response(301, headers={"location": "https://www.youtube.com/watch?v=x"})
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            text="<html><head><title>Never Gonna</title></head></html>",
        )

    link_id = make_link("http://public.example/short", "public.example")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    await enrichment.enrich_link(link_id, client=client)
    await client.aclose()

    link = get_link(link_id)
    assert link is not None
    assert link.title == "Never Gonna"
    assert link.category == "video"  # youtube.com host rule on the final URL


async def test_body_cap_truncates_but_still_parses(patched_resolver) -> None:
    head = "<html><head><title>Capped</title></head><body>"
    filler = "x" * (enrichment.MAX_BODY_BYTES + 4096)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/html"}, text=head + filler)

    link_id = make_link("http://public.example/big", "public.example")
    client = httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=False)
    await enrichment.enrich_link(link_id, client=client)
    await client.aclose()

    link = get_link(link_id)
    assert link is not None
    assert link.title == "Capped"
