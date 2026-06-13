"""In-process presence registry — THE reason the server runs one worker (PLAN.md §18).

Loop-confined: only the event loop touches _conns, and mutations never span an
`await`, so no locks are needed.
"""

import contextlib
from typing import Any

from fastapi import WebSocket


class PresenceHub:
    def __init__(self) -> None:
        self._conns: dict[int, dict[str, WebSocket]] = {}

    def register(self, user_id: int, device_id: str, ws: WebSocket) -> WebSocket | None:
        """Returns a previous socket for the same device (caller should close it)."""
        user_conns = self._conns.setdefault(user_id, {})
        old = user_conns.get(device_id)
        user_conns[device_id] = ws
        return old

    def unregister(self, user_id: int, device_id: str, ws: WebSocket) -> bool:
        """Drops the mapping only if `ws` is still the registered socket."""
        user_conns = self._conns.get(user_id)
        if user_conns is None or user_conns.get(device_id) is not ws:
            return False
        del user_conns[device_id]
        if not user_conns:
            del self._conns[user_id]
        return True

    def online_device_ids(self, user_id: int) -> set[str]:
        return set(self._conns.get(user_id, {}))

    def is_online(self, user_id: int, device_id: str) -> bool:
        return device_id in self._conns.get(user_id, {})

    def socket_for(self, user_id: int, device_id: str) -> WebSocket | None:
        return self._conns.get(user_id, {}).get(device_id)

    async def send_to_user(
        self, user_id: int, payload: dict[str, Any], exclude_device: str | None = None
    ) -> None:
        for device_id, ws in list(self._conns.get(user_id, {}).items()):
            if device_id == exclude_device:
                continue
            # A dying socket must not break the fan-out loop.
            with contextlib.suppress(Exception):
                await ws.send_json(payload)

    async def send_to_device(self, user_id: int, device_id: str, payload: dict[str, Any]) -> bool:
        ws = self.socket_for(user_id, device_id)
        if ws is None:
            return False
        try:
            await ws.send_json(payload)
        except Exception:
            return False
        return True


hub = PresenceHub()
