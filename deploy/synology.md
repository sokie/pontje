# Deploying Pontje on a Synology NAS (DSM 7 + Portainer)

Architecture: **DSM's built-in reverse proxy** terminates HTTPS with your
Synology-managed Let's Encrypt certificate and forwards to Pontje's Caddy
container on plain HTTP `:8080`. You keep exactly one cert-renewal mechanism
(DSM's, which you already have) and zero new port-forwards.

```
phone/PC ── https://pontje.YOU.synology.me ──▶ router :443 ──▶ DSM reverse proxy
                                                                  │ (TLS, WS headers)
                                                  caddy :8080 ◀───┘
                                                  │  SPA + /api + /ws
                                                  ▼
                                                  api :8000 ──▶ SQLite volume
```

## 0. What you already have (prerequisites)

- DDNS `YOU.synology.me` with a Synology Let's Encrypt certificate
  (per the mariushosting HTTPS guide) — meaning your router already forwards
  **80 + 443** to the NAS.
- Portainer.

## 1. Get a wildcard certificate (one-time, recommended)

So Pontje gets its own hostname (`pontje.YOU.synology.me`) without touching
DSM's:

1. **Control Panel → Security → Certificate → Add → Get a certificate from
   Let's Encrypt**, domain `YOU.synology.me`, and enable the **wildcard**
   option (`*.YOU.synology.me`). Synology handles the DNS challenge itself for
   `.synology.me` names.
2. Synology DDNS resolves `*.YOU.synology.me` automatically — no DNS work.

(Alternative if you skip this: run Pontje on `https://YOU.synology.me:8443` —
DSM proxy rule on source port 8443 with your existing cert; Google accepts
redirect URIs with explicit ports. The wildcard route is prettier.)

## 2. Deploy the stack in Portainer

**Stacks → Add stack → Repository:**

- Repository URL: `https://github.com/sokie/pontje`
- Reference: `refs/heads/main`
- Compose path: `docker-compose.synology.yml`
- Environment variables:

| Variable | Value |
|---|---|
| `PONTJE_PUBLIC_BASE_URL` | `https://pontje.YOU.synology.me` |
| `PONTJE_GOOGLE_CLIENT_ID` | from Google Console |
| `PONTJE_GOOGLE_CLIENT_SECRET` | from Google Console |
| `PONTJE_ALLOWED_EMAILS` | `sokysrm@gmail.com` |
| `PONTJE_SESSION_SECRET` | `python3 -c "import secrets; print(secrets.token_urlsafe(32))"` |
| `PONTJE_SECRET_KEY` | `python3 -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |

Deploy. The first build compiles the SPA on the NAS (`npm ci` + vite) — give a
weaker NAS a few minutes. Optional later upgrade: build images in GitHub
Actions → GHCR and switch the stack to `image:` instead of `build:`.
Enable Portainer's GitOps polling on the stack if you want auto-redeploy on
push to `main`.

## 3. DSM reverse proxy rule

**Control Panel → Login Portal → Advanced → Reverse Proxy → Create:**

- Name: `Pontje`
- Source: protocol **HTTPS**, hostname `pontje.YOU.synology.me`, port **443**
  (optionally enable HSTS)
- Destination: protocol **HTTP**, hostname `localhost`, port **8080**

Then — **required for live presence/transfers** — open the rule's **Custom
Header** tab → **Create → WebSocket** (adds the `Upgrade`/`Connection`
headers; without this `/ws` connections die and everything looks offline).

## 4. Assign the certificate

**Control Panel → Security → Certificate → Settings**: map the
`pontje.YOU.synology.me` service to the wildcard certificate.

## 5. Google Console

Add the production redirect URI to your existing OAuth client:
`https://pontje.YOU.synology.me/api/v1/auth/callback`
(keep the localhost ones for dev).

## 6. Verify

1. `https://pontje.YOU.synology.me/api/v1/healthz` → `{"status":"ok",…}`
2. Sign in with Google, register the device, open a second device — green
   presence dots prove `/ws` (and your WebSocket header) work.
3. Transfer a file between two LAN devices → badge should show **⚡ Local**
   (bytes never leave your network; only signaling crosses the proxy).
4. Phone on 5G: install the PWA from the public URL, QR-link it, transfer →
   **🌐 Direct**.

**LAN caveat:** if `pontje.YOU.synology.me` doesn't load from *inside* your
LAN, your router lacks NAT loopback — since DSM HTTPS already works for you
externally and internally, you're almost certainly fine; otherwise add a local
DNS override pointing the name at the NAS LAN IP.

## Operations

- **Update:** push to `main` → Portainer stack *Pull and redeploy* (or GitOps).
- **Backup:** the `pontje-data` volume holds `pontje.db`. It's low-stakes —
  links/snippets/history expire after 48 h and accounts are just Google
  identities — but Hyper Backup can include the Docker volume path if you want.
- **Never** add `--workers` or a second api container (PLAN.md §18).
- Keep `PONTJE_DEV_FAKE_LOGIN` unset here.
