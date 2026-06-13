"""WS message catalog (PLAN.md §9). All messages: {"t": <type>, ...payload}."""

from typing import Any

PROTOCOL_VERSION = 1


def peers(peer_list: list[dict[str, Any]]) -> dict[str, Any]:
    return {"t": "peers", "protocolVersion": PROTOCOL_VERSION, "peers": peer_list}


def peer_online(device_id: str) -> dict[str, Any]:
    return {"t": "peer-online", "deviceId": device_id}


def peer_offline(device_id: str, last_seen: str | None) -> dict[str, Any]:
    return {"t": "peer-offline", "deviceId": device_id, "lastSeen": last_seen}


def link_new(link: dict[str, Any]) -> dict[str, Any]:
    return {"t": "link-new", "link": link}


def link_updated(link: dict[str, Any]) -> dict[str, Any]:
    return {"t": "link-updated", "link": link}


def link_deleted(link_id: str) -> dict[str, Any]:
    return {"t": "link-deleted", "id": link_id}


def snippet_new(snippet: dict[str, Any]) -> dict[str, Any]:
    return {"t": "snippet-new", "snippet": snippet}


def snippet_deleted(snippet_id: str, revealed_by: str | None = None) -> dict[str, Any]:
    msg: dict[str, Any] = {"t": "snippet-deleted", "id": snippet_id}
    if revealed_by is not None:
        msg["revealedBy"] = revealed_by
    return msg


def device_linked(device_name: str, at: str) -> dict[str, Any]:
    return {"t": "device-linked", "deviceName": device_name, "at": at}


def transfer_logged(transfer: dict[str, Any]) -> dict[str, Any]:
    return {"t": "transfer-logged", "transfer": transfer}


def file_shared(shared_file: dict[str, Any]) -> dict[str, Any]:
    return {"t": "file-shared", "sharedFile": shared_file}


def file_unshared(file_id: str) -> dict[str, Any]:
    return {"t": "file-unshared", "id": file_id}


def file_stale(file_id: str) -> dict[str, Any]:
    return {"t": "file-stale", "id": file_id}


def session_state(session: dict[str, Any] | None, members: list[dict[str, Any]]) -> dict[str, Any]:
    return {"t": "session-state", "session": session, "members": members}


def error(code: str, msg: str) -> dict[str, Any]:
    return {"t": "error", "code": code, "msg": msg}
