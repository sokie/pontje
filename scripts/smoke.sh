#!/bin/bash
# Pontje merged-phases smoke test: dev-login → devices → links → secrets → QR link → Bearer.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BASE=http://localhost:5173
J1=/tmp/pj-c1.txt; J2=/tmp/pj-c2.txt; rm -f $J1 $J2
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS: $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL: $1"; }

pkill -f "uvicorn app.main:app" 2>/dev/null; pkill -f "vite" 2>/dev/null; sleep 1

cd $ROOT/server
rm -f /tmp/pontje-smoke.db*
PONTJE_DB_PATH=/tmp/pontje-smoke.db PONTJE_DEV_FAKE_LOGIN=1 PONTJE_ALLOWED_EMAILS=sokysrm@gmail.com \
  uv run uvicorn app.main:app --port 8000 >/tmp/pj-api.log 2>&1 &
API_PID=$!
cd $ROOT/web
./node_modules/.bin/vite --port 5173 >/tmp/pj-vite.log 2>&1 &
VITE_PID=$!

for i in $(seq 1 20); do
  curl -sf $BASE/api/v1/healthz >/dev/null 2>&1 && break; sleep 1
done

H='-H Content-Type:application/json'
X='-H X-Pontje:1'

# 1. dev-login sets cookie + returns bearer token
R=$(curl -sf -c $J1 $X $H -d '{"email":"sokysrm@gmail.com"}' $BASE/api/v1/auth/dev-login)
TOKEN=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null)
[ -n "$TOKEN" ] && ok "dev-login returns token" || bad "dev-login: $R"

# 2. me via cookie
EMAIL=$(curl -sf -b $J1 $BASE/api/v1/auth/me | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["email"])' 2>/dev/null)
[ "$EMAIL" = "sokysrm@gmail.com" ] && ok "auth/me via cookie" || bad "auth/me: $EMAIL"

# 3. me via Bearer, no cookie
EMAIL=$(curl -sf -H "Authorization: Bearer $TOKEN" $BASE/api/v1/auth/me | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["email"])' 2>/dev/null)
[ "$EMAIL" = "sokysrm@gmail.com" ] && ok "auth/me via Bearer (Android path)" || bad "bearer me: $EMAIL"

# 4. CSRF: cookie mutation without X-Pontje → 403
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b $J1 $H -d '{"id":"d-smoke","name":"X"}' $BASE/api/v1/devices)
[ "$CODE" = "403" ] && ok "CSRF header enforced" || bad "CSRF expected 403 got $CODE"

# 5. register device
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b $J1 $X $H -d '{"id":"d-smoke","name":"Smoke Desktop","platform":"mac"}' $BASE/api/v1/devices)
[ "$CODE" = "200" ] && ok "device registered" || bad "register: $CODE"

# 6. link insert → immediate hostname title, async enrichment may improve it
R=$(curl -sf -b $J1 $X $H -d '{"url":"https://github.com/sokie/pontje"}' $BASE/api/v1/links)
T0=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["title"])' 2>/dev/null)
[ "$T0" = "github.com" ] && ok "link inserted with hostname title" || bad "link insert title: $T0"
sleep 3
R=$(curl -sf -b $J1 $BASE/api/v1/links)
CAT=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["category"])' 2>/dev/null)
T1=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["title"])' 2>/dev/null)
[ "$CAT" = "dev" ] && ok "link categorized as dev (enrichment ran)" || echo "NOTE: enrichment category=$CAT title=$T1 (network-dependent)"

# 7. secret snippet: redacted in list, reveal once, then 410
R=$(curl -sf -b $J1 $X $H -d '{"content":"hunter2-super-secret","kind":"secret"}' $BASE/api/v1/snippets)
SID=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' 2>/dev/null)
C=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["content"])' 2>/dev/null)
[ "$C" = "None" ] && ok "secret content redacted in POST response" || bad "secret POST leaked: $C"
C=$(curl -sf -b $J1 $BASE/api/v1/snippets | python3 -c 'import sys,json;print(json.load(sys.stdin)[0]["content"])' 2>/dev/null)
[ "$C" = "None" ] && ok "secret content redacted in list" || bad "secret list leaked: $C"
C=$(curl -sf -b $J1 $X -X POST $BASE/api/v1/snippets/$SID/reveal | python3 -c 'import sys,json;print(json.load(sys.stdin)["content"])' 2>/dev/null)
[ "$C" = "hunter2-super-secret" ] && ok "reveal returns plaintext once" || bad "reveal: $C"
CODE=$(curl -s -o /dev/null -w '%{http_code}' -b $J1 $X -X POST $BASE/api/v1/snippets/$SID/reveal)
[ "$CODE" = "410" ] && ok "second reveal → 410 (burned)" || bad "second reveal: $CODE"

# 8. text snippet visible
R=$(curl -sf -b $J1 $X $H -d '{"content":"plain clipboard text","kind":"text"}' $BASE/api/v1/snippets)
C=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["content"])' 2>/dev/null)
[ "$C" = "plain clipboard text" ] && ok "text snippet round-trips" || bad "text snippet: $C"

# 9. QR device-link: mint → claim (fresh jar) → 410 on reuse
R=$(curl -sf -b $J1 $X -X POST $BASE/api/v1/auth/device-link)
LT=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null)
LURL=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["link_url"])' 2>/dev/null)
echo "$LURL" | grep -q "/link#lt=" && ok "device-link mint returns fragment URL" || bad "mint: $R"
R=$(curl -sf -c $J2 $X $H -d "{\"token\":\"$LT\"}" $BASE/api/v1/auth/device-link/claim)
T2=$(echo "$R" | python3 -c 'import sys,json;print(json.load(sys.stdin)["token"])' 2>/dev/null)
[ -n "$T2" ] && ok "claim succeeds, new session minted" || bad "claim: $R"
CODE=$(curl -s -o /dev/null -w '%{http_code}' $X $H -d "{\"token\":\"$LT\"}" $BASE/api/v1/auth/device-link/claim)
[ "$CODE" = "410" ] && ok "claim reuse → 410 (one-time)" || bad "claim reuse: $CODE"
EMAIL=$(curl -sf -b $J2 $BASE/api/v1/auth/me | python3 -c 'import sys,json;print(json.load(sys.stdin)["user"]["email"])' 2>/dev/null)
[ "$EMAIL" = "sokysrm@gmail.com" ] && ok "linked device session works" || bad "linked me: $EMAIL"

# 10. SPA served through vite with /link route (SPA fallback)
CODE=$(curl -s -o /dev/null -w '%{http_code}' $BASE/link)
[ "$CODE" = "200" ] && ok "SPA /link route served" || bad "/link: $CODE"

kill $API_PID $VITE_PID 2>/dev/null
pkill -f "uvicorn app.main:app" 2>/dev/null; pkill -f "vite --port 5173" 2>/dev/null
echo "=== RESULT: $PASS passed, $FAIL failed ==="
