# Pontje ⛴️

> Self-hosted, peer-to-peer file · link · clipboard relay between your own devices.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)

Pontje moves files **directly device-to-device over WebRTC DataChannels** — the
server only does auth, signaling, and tiny metadata, and **never touches your
file bytes**. Same-LAN transfers stay on the LAN even when the server runs in the
cloud; nothing is relayed unless a NAT genuinely forces it.

Think AirDrop that also spans Windows ↔ Android ↔ macOS ↔ Linux — plus a synced
clipboard, a self-categorizing link stash, and burn-on-read secrets, all behind
your own Google sign-in with an email allowlist.

## Features

- **Files, peer-to-peer** — drag/drop or pick files and folders; send to one
  device or fan out to all at once. Folders stream as a single zip. A live badge
  shows the path each transfer took: ⚡ LAN · 🌐 direct · ↪ relayed.
- **Share for later** — offer files your other devices pull on demand,
  presence-aware (● online / "offline since…"), at the best durability each
  browser allows (file handle → byte copy → in-memory).
- **Links** — paste a URL; it's auto-categorized and asynchronously enriched with
  a title (and an optional one-line LLM summary). Outbound fetches are SSRF-guarded.
- **Clips & secrets** — sync plain text, or mark it **secret**: Fernet-encrypted
  at rest, revealed exactly once, then burned (atomic and race-safe).
- **Cross-user sessions** — share a short code / QR to temporarily beam files,
  links, and clips with someone else's account; auto-expires.
- **Devices** — Google OAuth (allowlist) on the first device, then **QR
  device-linking** for the rest — no repeated OAuth. Live presence, rename,
  remove. Opaque sessions, a CSRF header, and Bearer-token auth (Android-ready).
- **Installable PWA** — add to the home screen; on Android it registers as a
  share target for text, URLs, and files.
- **Optional AI** — link summaries via any OpenAI-compatible endpoint (Ollama,
  LM Studio, OpenRouter…). Off by default.

## How it works

A small **FastAPI** server handles Google auth, WebRTC signaling, and lightweight
metadata (the device list, link/clip records, transfer history). **File bytes
always travel peer-to-peer** over a DataChannel negotiated through the signaling
socket. The practical consequences:

- Same-LAN devices transfer at LAN speed even when the server is in the cloud.
- A NAS deployment keeps same-LAN transfers working even with no internet.
- The server is **single-worker / single-instance by design** — presence and
  signaling live in-process, so never add `--workers` or replicas.

**Stack:** FastAPI · SQLModel/SQLite · Authlib (Google OIDC) on the back end;
React 19 · Vite · TypeScript · Tailwind · Zustand on the front end, with a typed
API client generated from the server's OpenAPI schema.

## Platform capabilities

The browser sandbox shapes what each platform can do — Pontje never sees file
paths or `file://` URLs. It works with **handles** (opaque, persistable
capabilities), **byte copies** in origin storage, or live in-memory `File`
objects, and always picks the best tier available.

| Platform · browser | Send | Receive | Share-for-later | Share sheet | Install |
|---|---|---|---|---|---|
| Win/Linux · Chrome/Edge | ✅ files + folders | 🥇 save picker, any size | 🥇 handle — zero-copy, any size, survives restarts | — | ✅ |
| macOS · Chrome/Edge/Arc | ✅ files + folders | 🥇 save picker, any size | 🥇 handle (as above) | — | ✅ |
| macOS · Safari | ✅ (folders via input) | SW stream / blob ≤ 200 MiB | copy ≤ 200 MiB, else until the tab closes | — | ✅ (Dock) |
| any · Firefox | ✅ (folders via input) | SW stream / blob ≤ 200 MiB | copy ≤ 200 MiB, else until the tab closes | — | ❌ |
| Android · Chrome (PWA) | ✅ files (no folder picker) | SW stream / blob | copy ≤ 200 MiB, else until the app restarts | ✅ | ✅ |
| iOS · Safari | ✅ files | blob ≤ 200 MiB | copy ≤ 200 MiB | ❌ | ✅ (Add to Home Screen) |

**Share-for-later durability**, best available wins: **handle** (desktop
Chromium) keeps the file where it is — any size, survives restarts, one
re-authorize click after a restart; **copy** (everything else, ≤ 200 MiB) streams
bytes into the origin's own storage — durable, re-pullable; **memory** (big files
on Safari/Firefox/mobile) serves while the tab/app lives.

**Rule of thumb:** put a Chromium browser on the desktops that act as file
*sources* (gold-tier sharing + a real save picker); receivers can be anything; on
Android install the PWA; iOS is a fine receiver/clips client without share-sheet
integration. Wake lock (keeps the screen on mid-transfer) needs HTTPS or
localhost; folder zips drop empty directories (a platform limit); the network
badge, clips, secrets, QR linking, and presence work everywhere.

## Quick start (development)

Requires [uv](https://docs.astral.sh/uv/) (Python 3.13+) and Node 20+.

```sh
# Terminal 1 — API on :8000
cd server && uv sync
PONTJE_DEV_FAKE_LOGIN=1 PONTJE_ALLOWED_EMAILS=you@gmail.com \
  uv run uvicorn app.main:app --reload

# Terminal 2 — SPA on :5173 (proxies /api + /ws to :8000)
cd web && npm install && npm run dev
```

Open <http://localhost:5173>. The SPA and API **must share one origin** (cookies +
the `X-Pontje` CSRF header are built around that) — in dev, Vite's proxy plays
that role. `http://localhost` is a secure context, so WebRTC, secrets, and QR
linking all work without real HTTPS.

Sign in two ways:

- **Dev login** — the login card shows a password-less form when
  `PONTJE_DEV_FAKE_LOGIN=1` and your email is in `PONTJE_ALLOWED_EMAILS`. The
  endpoint 404s unless explicitly enabled — never turn it on in production.
- **Real Google** — create an OAuth client, register
  `http://localhost:5173/api/v1/auth/callback` (localhost is exempt from Google's
  HTTPS rule), and set `PONTJE_GOOGLE_CLIENT_ID` / `PONTJE_GOOGLE_CLIENT_SECRET`.

**Test from a phone on your LAN:**

```sh
bash scripts/dev-lan.sh   # auto-detects your LAN IP, restarts both servers bound to it
```

The QR encodes whatever origin the desktop is on, so open `http://<lan-ip>:5173`,
sign in, then **Devices → Link a device** and scan with the phone camera — only
the first device per account ever talks to Google.

Need a real HTTPS origin on the phone (Google login on the device itself, PWA
install, or share-target testing)? Run the production-shaped Caddy stack locally
(`docker compose up --build` with `PONTJE_DOMAIN=localhost` issues a cert from
Caddy's internal CA), or front the dev server with a tunnel
(`ngrok http 5173`).

## Build & test

```sh
# Server — lint + tests
cd server && uv run ruff check && uv run pytest

# Web — typecheck + production build
cd web && npm run build

# Regenerate the typed API client after any endpoint change (commit the result)
cd web && npm run gen:api

# End-to-end smoke test (starts and stops its own servers)
bash scripts/smoke.sh
```

CI (`.github/workflows/ci.yml`) runs the server lint/tests and the web build on
every push, and fails if the committed API client has drifted from the server's
OpenAPI schema.

## Configuration

All configuration is `PONTJE_*` environment variables (or a `server/.env` file in
dev). The essentials:

| Variable | Purpose |
|---|---|
| `PONTJE_PUBLIC_BASE_URL` | Public origin. An `https://…` value flips the app into **production** mode (Secure cookies + the boot-time checks below). |
| `PONTJE_GOOGLE_CLIENT_ID` / `_SECRET` | Google OAuth client credentials. |
| `PONTJE_ALLOWED_EMAILS` | Comma-separated allowlist of Google accounts. |
| `PONTJE_SESSION_SECRET` | Signs the transient OAuth-state cookie. |
| `PONTJE_SECRET_KEY` | Fernet key encrypting secret snippets at rest. |
| `PONTJE_DEV_FAKE_LOGIN` | Dev-only password-less login. Never set in production. |
| `PONTJE_LLM_BASE_URL` / `_MODEL` / `_API_KEY` | Optional AI (see below). |

See [`.env.example`](.env.example) for the full set with generation commands.

**Production requires HTTPS** — Secure cookies, the service worker / PWA install,
WebRTC, and the Android share target all need a secure context. With an `https`
base URL the server **fails fast at boot** unless the secrets, Google credentials,
and allowlist are set and `PONTJE_DEV_FAKE_LOGIN` is off, so misconfiguration is
loud rather than silent. The only blessed plain-http contexts are
`http://localhost` (still a secure context) and the LAN-IP dev script above.

## Deploy

Three supported shapes — pick one:

| Target | Guide | TLS terminated by |
|---|---|---|
| **Synology NAS** (DSM 7 + Portainer) | [deploy/synology.md](deploy/synology.md) | DSM's reverse proxy |
| **Railway** (single container) | [deploy/railway.md](deploy/railway.md) | Railway's edge |
| **Generic box** (your own domain) | below | Caddy + Let's Encrypt |

Generic Caddy box:

```sh
cp .env.example .env   # real domain, Google client, allowlist, secrets
docker compose up -d --build
```

Caddy serves the built SPA and terminates HTTPS for `$PONTJE_DOMAIN` via Let's
Encrypt — forward ports 443 (and 80 for the ACME challenge) to the host. Leave
`PONTJE_DEV_FAKE_LOGIN` unset, set a real `PONTJE_SECRET_KEY`, and remember the
API is single-worker/single-instance by design.

## AI features (optional, off by default)

Links can get a one-line **LLM summary** plus categorization for hosts the rules
don't recognize, computed inside the existing async enrichment — a slow model just
means the summary appears a few seconds later via the live update.

- **Hard kill-switch:** `PONTJE_AI_DISABLED=1` disables every AI feature
  unconditionally, regardless of any other setting.
- Otherwise AI activates only when **both** of these are set; any
  OpenAI-compatible chat endpoint works:

```sh
PONTJE_LLM_BASE_URL=http://localhost:11434/v1   # Ollama / LM Studio / OpenRouter…
PONTJE_LLM_MODEL=qwen3:1.7b
# PONTJE_LLM_API_KEY=...                         # cloud endpoints only
```

Self-host with Ollama on the NAS and page text never leaves your infrastructure.
Output is strictly validated server-side (fixed category taxonomy, clamped
summary) and treated as display-only text.

## License

[GNU AGPL-3.0-or-later](LICENSE). Pontje is free software — use it, study it,
share it, and modify it freely. The one catch that matters for a server: if you
run a **modified** version as a network service, you must offer your users its
corresponding source. Full terms in [LICENSE](LICENSE).
