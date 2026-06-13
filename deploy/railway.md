# Deploying Pontje on Railway (PRO)

Architecture: **one service, one container** built from `Dockerfile.railway` —
FastAPI serves the built SPA itself (`server/app/spa.py`), Railway's edge
terminates TLS on a `*.up.railway.app` domain (WebSockets pass through fine).
No Caddy, no cert management, push-to-deploy.

```
devices ── https://pontje-….up.railway.app ──▶ Railway edge (TLS)
                                                  │
                                                  ▼
                                   container: uvicorn (1 worker)
                                   SPA + /api + /ws ──▶ SQLite on Railway Volume
```

## 1. Create the service

1. railway.com → **New Project → Deploy from GitHub repo** → `sokie/pontje`.
2. Service **Settings → Build**: Builder **Dockerfile**, Dockerfile path
   **`Dockerfile.railway`**.

## 2. Attach a volume (SQLite)

Service → **Attach Volume**, mount path **`/data`**.
A volume pins the service to a single instance — for Pontje that's not a
limitation, it's a requirement (in-process presence; PLAN.md §18). **Never set
replicas > 1.**

## 3. Variables

| Variable | Value |
|---|---|
| `PORT` | `8000` — pins the listen port so it matches the domain's target port (step 4); Railway otherwise injects its own and the mismatch 502s |
| `PONTJE_DB_PATH` | `/data/pontje.db` |
| `PONTJE_PUBLIC_BASE_URL` | `https://<your-domain>.up.railway.app` — **required**; the var the app reads (there is **no** `PONTJE_DOMAIN` on Railway). Set it after step 4 |
| `PONTJE_GOOGLE_CLIENT_ID` / `_SECRET` | from Google Console |
| `PONTJE_ALLOWED_EMAILS` | `sokysrm@gmail.com` |
| `PONTJE_SESSION_SECRET` | `python3 -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `PONTJE_SECRET_KEY` | `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |

(The Dockerfile binds `$PORT`; pinning `PORT=8000` above keeps the app's listen
port and the domain's target port identical. Skip it and Railway injects its own
`PORT` — the app then listens elsewhere and the domain 502s. This is the #1
setup gotcha.)

(`PONTJE_PUBLIC_BASE_URL` is what the app reads for the OAuth redirect URI,
Secure cookies, and the prod fail-fast. Set it to the full https domain; if it's
unset it falls back to `http://localhost:5173` and Google sign-in redirects to
localhost. The compose deploys' `PONTJE_DOMAIN` is not used on Railway.)

## 4. Domain

**Settings → Networking → Generate Domain** — set the **target port to 8000**
(it must match the `PORT` variable above; a mismatch is the classic 502).
Pick a service name you'll keep — the domain is your app's identity (PWA
install, cookies, OAuth). Then set `PONTJE_PUBLIC_BASE_URL` to it and add the
redirect URI in Google Console:
`https://<your-domain>.up.railway.app/api/v1/auth/callback`

A custom domain later is just **Settings → Domains → Custom Domain** (CNAME) +
updating `PONTJE_PUBLIC_BASE_URL` + a new Google redirect URI.

## 5. Verify

healthz → Google login → register devices → transfer between two LAN devices:
the badge should still show **⚡ Local** — signaling goes through Railway, but
file bytes are P2P and stay on your network.

## Trade-offs vs the NAS (be aware)

- **Internet down at home = nothing works** (signaling lives in the cloud).
  The NAS deployment keeps same-LAN transfers working offline.
- **Metadata trust:** links, snippet text, and encrypted secrets sit on
  Railway's volume — and the Fernet key is in Railway env vars, so "encrypted
  at rest" protects against leaked DB files, not against the platform itself.
  On the NAS, everything stays in your home.
- **File bytes are never on Railway either way** — WebRTC is P2P; the server
  only relays SDP/ICE.
- Push to `main` auto-deploys (≈30 s of downtime per deploy; live WS
  reconnects, in-flight P2P transfers survive — the data path doesn't touch
  the server).
