import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute
from pydantic import BaseModel
from starlette.datastructures import MutableHeaders
from starlette.middleware.sessions import SessionMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from app import __version__
from app import loop as loop_bridge
from app.config import settings
from app.db import init_db
from app.routers import auth, devices, links, share_sessions, shared_files, snippets, transfers
from app.services.cleanup import sweeper_loop
from app.spa import mount_spa
from app.ws.handler import router as ws_router

API_PREFIX = "/api/v1"

# Single CSP for the whole app (PLAN.md §23). Kept byte-identical to the Caddy
# `header` block so the NAS/dev (Caddy-served) and Railway single-container
# (spa.py-served) paths emit exactly the same policy. Covers the app's REAL
# sources: same-origin API/WS, DuckDuckGo link favicons, React inline `style=`
# attributes + self-hosted fonts. `script-src 'self'` holds because
# vite-plugin-pwa emits an external registerSW.js (no inline bootstrap script).
CONTENT_SECURITY_POLICY = (
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; "
    "img-src 'self' data: https://icons.duckduckgo.com; style-src 'self' 'unsafe-inline'; "
    "script-src 'self'; connect-src 'self'; font-src 'self'"
)


class SecurityHeadersMiddleware:
    """Pure-ASGI security headers on every HTTP response (PLAN.md §23).

    Pure ASGI (not BaseHTTPMiddleware) so it never buffers streaming responses
    — the /_download SW path and large SPA assets pass straight through — and
    leaves websocket scopes untouched. HSTS rides only on https (production):
    sending it over plain-http dev would be wrong and browsers ignore it anyway.
    """

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers["Content-Security-Policy"] = CONTENT_SECURITY_POLICY
                headers["X-Content-Type-Options"] = "nosniff"
                headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
                headers["X-Frame-Options"] = "DENY"
                if settings.cookie_secure:
                    headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
            await send(message)

        await self.app(scope, receive, send_with_headers)


def generate_operation_id(route: APIRoute) -> str:
    # Clean operation ids ("healthz", not "healthz_api_v1_healthz_get") so the
    # generated TS client gets usable method names.
    return route.name


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Fail fast in production on insecure config before serving a single request.
    settings.assert_production_ready()
    init_db()
    loop_bridge.set_main_loop(asyncio.get_running_loop())
    sweeper = asyncio.create_task(sweeper_loop())
    yield
    sweeper.cancel()
    loop_bridge.set_main_loop(None)


class HealthStatus(BaseModel):
    status: str
    version: str


root_router = APIRouter(prefix=API_PREFIX)


@root_router.get("/healthz")
def healthz() -> HealthStatus:
    return HealthStatus(status="ok", version=__version__)


def create_app() -> FastAPI:
    app = FastAPI(
        title="Pontje",
        version=__version__,
        lifespan=lifespan,
        openapi_url=f"{API_PREFIX}/openapi.json",
        docs_url=f"{API_PREFIX}/docs",
        redoc_url=None,
        generate_unique_id_function=generate_operation_id,
    )
    # ONLY for the transient OAuth state/nonce cookie — never app auth (PLAN.md §7.1).
    app.add_middleware(
        SessionMiddleware,
        secret_key=settings.session_secret,
        session_cookie="pontje_oauth",
        max_age=600,
        same_site="lax",
        https_only=settings.cookie_secure,
    )
    # Added last → outermost: stamp security headers on every HTTP response,
    # SPA + API alike, regardless of what inner middleware/handlers do.
    app.add_middleware(SecurityHeadersMiddleware)
    app.include_router(root_router)
    for sub in (
        auth.router,
        devices.router,
        links.router,
        share_sessions.router,
        shared_files.router,
        snippets.router,
        transfers.router,
    ):
        app.include_router(sub, prefix=API_PREFIX)
    app.include_router(ws_router)
    if settings.static_dir:
        mount_spa(app, settings.static_dir)
    return app


app = create_app()
