"""Optional same-process SPA serving for single-container deploys (Railway
etc.). Inert unless PONTJE_STATIC_DIR is set — the NAS deployment keeps Caddy
in front instead (PLAN.md §21).
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import RedirectResponse
from starlette.exceptions import HTTPException
from starlette.staticfiles import StaticFiles
from starlette.types import Scope


class SpaStaticFiles(StaticFiles):
    """Static files with an index.html fallback for client routes
    (/link, /share, …) — the in-process equivalent of Caddy's try_files."""

    async def get_response(self, path: str, scope: Scope):
        try:
            response = await super().get_response(path, scope)
        except HTTPException as exc:
            # Starlette raises (rather than returns) 404s for missing files.
            if exc.status_code == 404:
                return await super().get_response("index.html", scope)
            raise
        if response.status_code == 404:
            return await super().get_response("index.html", scope)
        return response


def mount_spa(app: FastAPI, static_dir: str) -> None:
    root = Path(static_dir)
    if not root.is_dir():
        return

    # Share-target cold-start fallback (PLAN.md §16) — Caddy's `redir /share / 303`.
    @app.post("/share", include_in_schema=False)
    async def share_fallback() -> RedirectResponse:
        return RedirectResponse("/", status_code=303)

    # Mounted LAST in create_app, so /api/* and /ws (registered earlier) win.
    app.mount("/", SpaStaticFiles(directory=root, html=True), name="spa")
