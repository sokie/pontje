"""Async link enrichment with a per-hop SSRF guard (PLAN.md §12).

Runs on the event loop (scheduled via app.loop.submit from the links router).
Every redirect hop re-resolves the target host and rejects private/loopback/
link-local/reserved/multicast/unspecified addresses — auto-follow would only
validate the first hop, which is exactly the SSRF bypass we're guarding
against. Failures leave the row as inserted (hostname title) and log at debug.
"""

import asyncio
import ipaddress
import logging
import socket
from typing import Any
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup
from sqlmodel import Session

from app.config import settings
from app.db import engine
from app.models import Link
from app.services import llm, session_scope
from app.services.categorize import categorize

logger = logging.getLogger(__name__)

MAX_REDIRECTS = 3
TOTAL_TIMEOUT_SECONDS = 5.0
MAX_BODY_BYTES = 512 * 1024


def resolve_host(host: str) -> list[str]:
    """All addresses the host resolves to. Module-level so tests can patch it."""
    infos = socket.getaddrinfo(host, None)
    return [info[4][0] for info in infos]


def validate_host(host: str) -> bool:
    """True iff EVERY resolved address is publicly routable (SSRF guard)."""
    try:
        addresses = resolve_host(host)
    except OSError:
        return False
    if not addresses:
        return False
    for raw in addresses:
        try:
            # getaddrinfo may return zone-scoped IPv6 ("fe80::1%en0").
            ip = ipaddress.ip_address(raw.split("%")[0])
        except ValueError:
            return False
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return False
    return True


def link_payload(link: Link) -> dict[str, Any]:
    """Serialized link — shared by REST responses and WS broadcasts."""
    return {
        "id": link.id,
        "url": link.url,
        "title": link.title,
        "category": link.category,
        "summary": link.summary,
        "from_device": link.from_device,
        "created_at": link.created_at.isoformat(),
    }


async def _fetch_html(url: str, client: httpx.AsyncClient | None) -> tuple[str, bytes] | None:
    """Manual redirect loop (≤ MAX_REDIRECTS hops), per-hop host validation.

    Returns (final_url, body bytes capped at MAX_BODY_BYTES) or None on any
    policy violation (non-http(s), private target, non-HTML, too many hops).
    """
    owns_client = client is None
    if client is None:
        client = httpx.AsyncClient(
            follow_redirects=False, timeout=httpx.Timeout(TOTAL_TIMEOUT_SECONDS)
        )
    try:
        current = url
        for _hop in range(MAX_REDIRECTS + 1):
            parsed = urlparse(current)
            if parsed.scheme not in ("http", "https") or not parsed.hostname:
                return None  # non-http(s) redirect target → abort
            if not await asyncio.to_thread(validate_host, parsed.hostname):
                return None  # private/loopback/… target → abort
            response = await client.send(client.build_request("GET", current), stream=True)
            try:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        return None
                    current = urljoin(current, location)
                    continue
                if response.status_code != 200:
                    return None
                content_type = response.headers.get("content-type", "")
                if "text/html" not in content_type.lower():
                    return None
                body = bytearray()
                async for chunk in response.aiter_bytes():
                    body.extend(chunk)
                    if len(body) >= MAX_BODY_BYTES:
                        break
                return current, bytes(body[:MAX_BODY_BYTES])
            finally:
                await response.aclose()
        return None  # redirect chain longer than MAX_REDIRECTS → abort
    finally:
        if owns_client:
            await client.aclose()


def parse_html(body: bytes) -> dict[str, str | None]:
    """Extract <title>, og:title, og:site_name, og:type (bs4 sniffs the charset)."""
    soup = BeautifulSoup(body, "html.parser")

    def og(prop: str) -> str | None:
        tag = soup.find("meta", attrs={"property": prop})
        content = tag.get("content") if tag else None
        return content.strip() if isinstance(content, str) and content.strip() else None

    title_tag = soup.title.get_text(strip=True) if soup.title else None

    # Main-text extraction for the optional LLM stage: meta description plus
    # paragraph text, capped — display-only downstream, but keep it lean.
    description = og("og:description")
    if not description:
        meta_desc = soup.find("meta", attrs={"name": "description"})
        content = meta_desc.get("content") if meta_desc else None
        description = content.strip() if isinstance(content, str) and content.strip() else None
    chunks: list[str] = [description] if description else []
    total = sum(len(c) for c in chunks)
    for p in soup.find_all("p"):
        text = p.get_text(" ", strip=True)
        if not text:
            continue
        chunks.append(text)
        total += len(text)
        if total >= llm.MAX_INPUT_CHARS:
            break

    return {
        "title": title_tag or None,
        "og_title": og("og:title"),
        "og_site_name": og("og:site_name"),
        "og_type": og("og:type"),
        "text": "\n".join(chunks)[: llm.MAX_INPUT_CHARS],
    }


def _load_link(link_id: str) -> Link | None:
    with Session(engine) as db:
        return db.get(Link, link_id)


def _apply_enrichment(
    link_id: str, title: str | None, category: str
) -> tuple[int, dict[str, Any]] | None:
    """UPDATE the row; returns (user_id, payload) or None if the link is gone."""
    with Session(engine) as db:
        link = db.get(Link, link_id)
        if link is None:
            return None
        if title:
            link.title = title
        link.category = category
        db.add(link)
        db.commit()
        db.refresh(link)
        return link.user_id, link_payload(link)


def _apply_ai(
    link_id: str, category: str | None, summary: str | None
) -> tuple[int, dict[str, Any]] | None:
    """Second-stage UPDATE from the LLM result; returns (user_id, payload)."""
    with Session(engine) as db:
        link = db.get(Link, link_id)
        if link is None:
            return None
        if category:
            link.category = category
        if summary:
            link.summary = summary
        db.add(link)
        db.commit()
        db.refresh(link)
        return link.user_id, link_payload(link)


async def enrich_link(
    link_id: str,
    client: httpx.AsyncClient | None = None,
    llm_client: httpx.AsyncClient | None = None,
) -> None:
    link = await asyncio.to_thread(_load_link, link_id)
    if link is None:
        return
    parsed = urlparse(link.url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return

    try:
        async with asyncio.timeout(TOTAL_TIMEOUT_SECONDS):
            fetched = await _fetch_html(link.url, client)
    except Exception:
        logger.debug("enrichment fetch failed for link %s", link_id, exc_info=True)
        return
    if fetched is None:
        return

    final_url, body = fetched
    try:
        meta = parse_html(body)
    except Exception:
        logger.debug("enrichment parse failed for link %s", link_id, exc_info=True)
        return

    # Title precedence: og:title > <title> > keep the hostname placeholder.
    title = meta["og_title"] or meta["title"]
    final_host = urlparse(final_url).hostname or parsed.hostname
    category = categorize(final_host, meta["og_type"])

    updated = await asyncio.to_thread(_apply_enrichment, link_id, title, category)
    if updated is None:
        return
    user_id, payload = updated
    # Session-scoped links fan out to member devices across users (PLAN.md §15).
    await session_scope.send_link_updated(user_id, payload)

    # Optional AI stage (settings.ai_enabled — PONTJE_AI_DISABLED hard-kills
    # it): summary always; category only when the rules/og stage said "other"
    # (host rules stay authoritative). Failures change nothing.
    if not settings.ai_enabled:
        return
    ai = await llm.summarize_and_categorize(
        final_url, payload["title"], str(meta.get("text") or ""), client=llm_client
    )
    if ai is None:
        return
    ai_category = ai["category"] if category == "other" else None
    if ai_category is None and ai["summary"] is None:
        return
    refined = await asyncio.to_thread(_apply_ai, link_id, ai_category, ai["summary"])
    if refined is None:
        return
    user_id, payload = refined
    await session_scope.send_link_updated(user_id, payload)
