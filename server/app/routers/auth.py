"""Auth endpoints: Google OIDC, QR device-link, me / logout / dev-login (PLAN.md §7)."""

import asyncio
from typing import Any

from authlib.integrations.starlette_client import OAuthError
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlmodel import Session, select

from app import ratelimit
from app.auth.deps import AuthContext, current_auth
from app.auth.device_link import claim_link_token, mint_link_token
from app.auth.oauth import oauth
from app.auth.sessions import clear_session_cookie, mint_session, revoke_session, set_session_cookie
from app.config import settings
from app.db import engine, get_db
from app.models import User
from app.timeutil import utcnow

router = APIRouter(prefix="/auth", tags=["auth"])


# ---------------------------------------------------------------------------
# Google OIDC (PLAN.md §7.1)


@router.get("/login")
async def login(request: Request) -> RedirectResponse:
    # redirect_uri built from PONTJE_PUBLIC_BASE_URL — NEVER request.url_for:
    # behind the proxy it can resolve to http:// and fail Google's exact match.
    redirect_uri = f"{settings.public_base_url}/api/v1/auth/callback"
    return await oauth.google.authorize_redirect(request, redirect_uri)


def _oauth_login_user(claims: dict[str, Any], email: str) -> str:
    """Upsert the user by google_sub + mint a session. Sync — called via to_thread."""
    with Session(engine) as db:
        user = db.exec(select(User).where(User.google_sub == claims["sub"])).first()
        if user is None:
            user = User(google_sub=claims["sub"], email=email)
        user.email = email
        user.name = claims.get("name") or user.name
        user.picture = claims.get("picture") or user.picture
        user.last_login = utcnow()
        db.add(user)
        db.commit()
        db.refresh(user)
        token, _ = mint_session(db, user.id, created_via="oauth")
        return token


@router.get("/callback")
async def callback(request: Request) -> RedirectResponse:
    try:
        # Validates state, nonce, and the id_token signature against Google's JWKS.
        token = await oauth.google.authorize_access_token(request)
    except OAuthError:
        return RedirectResponse("/?error=oauth", status_code=302)
    claims = token.get("userinfo") or {}
    email = (claims.get("email") or "").strip().lower()
    if not claims.get("sub"):
        return RedirectResponse("/?error=oauth", status_code=302)
    if claims.get("email_verified") is not True or email not in settings.allowed_email_set:
        return RedirectResponse("/?error=not_allowed", status_code=302)
    session_token = await asyncio.to_thread(_oauth_login_user, claims, email)
    response = RedirectResponse("/", status_code=302)
    set_session_cookie(response, session_token)
    return response


# ---------------------------------------------------------------------------
# QR device-link (PLAN.md §7.3)


class DeviceLinkOut(BaseModel):
    token: str
    expires_at: str
    link_url: str  # token rides in the URL fragment — never in logs/Referer


@router.post(
    "/device-link",
    dependencies=[Depends(ratelimit.limit_by_user("device-link-mint", 10, 3600))],
)
def create_device_link(
    auth: AuthContext = Depends(current_auth), db: Session = Depends(get_db)
) -> DeviceLinkOut:
    token, row = mint_link_token(db, auth.user.id, auth.session.id)
    return DeviceLinkOut(
        token=token,
        expires_at=row.expires_at.isoformat(),
        link_url=f"{settings.public_base_url}/link#lt={token}",
    )


class DeviceLinkClaimIn(BaseModel):
    token: str


class DeviceLinkClaimOut(BaseModel):
    # The web client uses the cookie; a future Android app keeps this as Bearer.
    token: str


@router.post(
    "/device-link/claim",
    dependencies=[Depends(ratelimit.limit_by_ip("device-link-claim", 10, 60))],
)
def claim_device_link(
    body: DeviceLinkClaimIn, response: Response, db: Session = Depends(get_db)
) -> DeviceLinkClaimOut:
    user_id = claim_link_token(db, body.token)
    if user_id is None:
        raise HTTPException(status_code=410, detail="link_expired_or_used")
    token, _ = mint_session(db, user_id, created_via="device_link")
    set_session_cookie(response, token)
    return DeviceLinkClaimOut(token=token)


# ---------------------------------------------------------------------------
# Session info / logout / dev-login


class MeUser(BaseModel):
    id: int
    email: str
    name: str | None
    picture: str | None


class MeOut(BaseModel):
    user: MeUser
    device_id: str | None
    created_via: str


@router.get("/me")
def me(auth: AuthContext = Depends(current_auth)) -> MeOut:
    return MeOut(
        user=MeUser(
            id=auth.user.id,
            email=auth.user.email,
            name=auth.user.name,
            picture=auth.user.picture,
        ),
        device_id=auth.session.device_id,
        created_via=auth.session.created_via,
    )


class LogoutOut(BaseModel):
    ok: bool


@router.post("/logout")
def logout(
    response: Response,
    auth: AuthContext = Depends(current_auth),
    db: Session = Depends(get_db),
) -> LogoutOut:
    revoke_session(db, auth.session)
    clear_session_cookie(response)
    return LogoutOut(ok=True)


class DevLoginIn(BaseModel):
    email: str
    name: str | None = None


class DevLoginOut(BaseModel):
    token: str  # also usable as a Bearer token (Android-readiness smoke tests)


@router.post("/dev-login")
def dev_login(body: DevLoginIn, response: Response, db: Session = Depends(get_db)) -> DevLoginOut:
    """Local-testing bypass — only active with PONTJE_DEV_FAKE_LOGIN=1 (never in prod)."""
    if not settings.dev_fake_login:
        raise HTTPException(status_code=404)
    email = body.email.strip().lower()
    if email not in settings.allowed_email_set:
        raise HTTPException(status_code=403, detail="not_allowed")
    user = db.exec(select(User).where(User.email == email)).first()
    if user is None:
        user = User(google_sub=f"dev:{email}", email=email, name=body.name or email.split("@")[0])
        db.add(user)
    user.last_login = utcnow()
    db.add(user)
    db.commit()
    db.refresh(user)
    token, _ = mint_session(db, user.id, created_via="dev")
    set_session_cookie(response, token)
    return DevLoginOut(token=token)
