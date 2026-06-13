"""Google OIDC client via Authlib (PLAN.md §7.1).

The endpoints live in app/routers/auth.py. Authlib stores the OAuth state/nonce
in the transient `pontje_oauth` session cookie (SessionMiddleware in main.py) —
never used for app auth.
"""

from authlib.integrations.starlette_client import OAuth

from app.config import settings

GOOGLE_METADATA_URL = "https://accounts.google.com/.well-known/openid-configuration"

oauth = OAuth()
oauth.register(
    name="google",
    client_id=settings.google_client_id,
    client_secret=settings.google_client_secret,
    server_metadata_url=GOOGLE_METADATA_URL,
    client_kwargs={"scope": "openid email profile"},
)
