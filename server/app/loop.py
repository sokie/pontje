"""Bridge from sync (threadpool) endpoint code to the event loop.

Single worker, single loop (PLAN.md §18): the lifespan registers the running
loop; sync endpoints schedule broadcasts/tasks onto it thread-safely.
"""

import asyncio
import contextlib
import logging
from collections.abc import Coroutine
from typing import Any

from app.ws.presence import hub

logger = logging.getLogger(__name__)

_loop: asyncio.AbstractEventLoop | None = None


def set_main_loop(loop: asyncio.AbstractEventLoop | None) -> None:
    global _loop
    _loop = loop


def submit(coro: Coroutine[Any, Any, Any]) -> None:
    """Fire-and-forget a coroutine on the main loop from any thread."""
    if _loop is None or _loop.is_closed():
        coro.close()
        return
    future = asyncio.run_coroutine_threadsafe(coro, _loop)
    future.add_done_callback(_log_failure)


def _log_failure(future: Any) -> None:
    with contextlib.suppress(Exception):
        exc = future.exception()
        if exc is not None:
            logger.error("loop-submitted task failed: %r", exc)


def broadcast_to_user(
    user_id: int, payload: dict[str, Any], exclude_device: str | None = None
) -> None:
    """Thread-safe WS broadcast to all of a user's connected devices."""
    submit(hub.send_to_user(user_id, payload, exclude_device=exclude_device))
