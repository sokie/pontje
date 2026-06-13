"""Dual-transport auth dependency: Bearer first, else cookie (PLAN.md §19).

CSRF: cookie-authenticated mutations must carry `X-Pontje: 1`; the Bearer path
is exempt (PLAN.md §7.1).
"""

from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request
from sqlmodel import Session

from app.auth.sessions import COOKIE_NAME, resolve_session
from app.db import get_db
from app.models import AuthSession, User

CSRF_HEADER = "x-pontje"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}


@dataclass
class AuthContext:
    user: User
    session: AuthSession


def extract_token(request: Request) -> tuple[str | None, bool]:
    """Returns (token, via_cookie)."""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip(), False
    cookie = request.cookies.get(COOKIE_NAME)
    if cookie:
        return cookie, True
    return None, False


def current_auth(request: Request, db: Session = Depends(get_db)) -> AuthContext:
    token, via_cookie = extract_token(request)
    if not token:
        raise HTTPException(status_code=401, detail="not_authenticated")
    sess = resolve_session(db, token)
    if sess is None:
        raise HTTPException(status_code=401, detail="invalid_session")
    if (
        via_cookie
        and request.method not in SAFE_METHODS
        and request.headers.get(CSRF_HEADER) != "1"
    ):
        raise HTTPException(status_code=403, detail="missing_csrf_header")
    user = db.get(User, sess.user_id)
    if user is None:
        raise HTTPException(status_code=401, detail="invalid_session")
    return AuthContext(user=user, session=sess)
