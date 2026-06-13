"""In-memory fixed-window rate limiter (PLAN.md §18).

In-process BY DESIGN: the server runs a single worker (§18), so a dict is the
whole story. Applied only to auth + device-link endpoints.
"""

import threading
import time
from collections.abc import Callable

from fastapi import Depends, HTTPException, Request

from app.auth.deps import AuthContext, current_auth

# key -> (window index, count). Endpoints run in the threadpool, hence the lock.
_buckets: dict[str, tuple[int, int]] = {}
_lock = threading.Lock()


def _now() -> float:  # separate fn so tests can pin the clock
    return time.time()


def allow(key: str, limit: int, window_s: int) -> bool:
    window = int(_now() // window_s)
    with _lock:
        idx, count = _buckets.get(key, (window, 0))
        if idx != window:
            idx, count = window, 0
        if count >= limit:
            return False
        _buckets[key] = (idx, count + 1)
        return True


def reset() -> None:
    """Forget all counters (test helper)."""
    with _lock:
        _buckets.clear()


def limit_by_user(scope: str, limit: int, window_s: int) -> Callable[..., None]:
    """Dependency factory: fixed window keyed by the authenticated user id."""

    def dep(auth: AuthContext = Depends(current_auth)) -> None:
        if not allow(f"{scope}:user:{auth.user.id}", limit, window_s):
            raise HTTPException(status_code=429, detail="rate_limited")

    return dep


def limit_by_ip(scope: str, limit: int, window_s: int) -> Callable[..., None]:
    """Dependency factory: fixed window keyed by the client IP."""

    def dep(request: Request) -> None:
        host = request.client.host if request.client else "unknown"
        if not allow(f"{scope}:ip:{host}", limit, window_s):
            raise HTTPException(status_code=429, detail="rate_limited")

    return dep
