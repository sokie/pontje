"""Fernet encryption at rest for secret snippets (PLAN.md §13).

Key from PONTJE_SECRET_KEY. Without it (dev), an ephemeral key is generated at
import — secrets then die with the process. Threat model: protects the DB file
and its backups, not a live-compromised server. Content is never logged.
"""

import logging

from cryptography.fernet import Fernet

from app.config import settings

logger = logging.getLogger(__name__)

if settings.secret_key:
    _fernet = Fernet(settings.secret_key)
else:
    _fernet = Fernet(Fernet.generate_key())
    logger.warning(
        "PONTJE_SECRET_KEY is not set — using an ephemeral Fernet key; "
        "secret snippets will NOT survive a server restart."
    )


def encrypt(plain: str) -> str:
    return _fernet.encrypt(plain.encode()).decode()


def decrypt(token: str) -> str:
    return _fernet.decrypt(token.encode()).decode()
