#!/bin/bash
# Make the dev servers reachable from your phone on the same Wi-Fi (QR
# device-link testing). The QR encodes whatever origin the desktop browser is
# on, so: browse http://<lan-ip>:5173 when you want phone-scannable QRs, and
# http://localhost:5173 when you want Google login. Both work at the same time.
# Usage: scripts/dev-lan.sh [lan-ip]   (auto-detects the IP if omitted)
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)

IP=${1:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || hostname -I 2>/dev/null | awk '{print $1}' || true)}
if [ -z "${IP:-}" ]; then
  echo "Could not auto-detect a LAN IP — pass it explicitly: scripts/dev-lan.sh 192.168.1.23"
  exit 1
fi

pkill -f "uvicorn app.main:app" 2>/dev/null || true
pkill -f "node_modules/.bin/vite" 2>/dev/null || true
sleep 1

cd "$ROOT/server"
nohup uv run uvicorn app.main:app --reload --port 8000 > /tmp/pontje-dev-api.log 2>&1 &
cd "$ROOT/web"
nohup ./node_modules/.bin/vite --host --port 5173 > /tmp/pontje-dev-vite.log 2>&1 &

for i in $(seq 1 20); do
  curl -sf http://localhost:5173/api/v1/healthz >/dev/null 2>&1 && break
  sleep 1
done
curl -sf http://localhost:5173/api/v1/healthz >/dev/null || { echo "servers did not come up — see /tmp/pontje-dev-*.log"; exit 1; }

echo "✓ Pontje dev is up"
echo "  Google login + general dev:   http://localhost:5173"
echo "  Phone-scannable QR linking:   http://$IP:5173  (open THIS on the desktop, then Link a device)"
echo "  Logs: /tmp/pontje-dev-{api,vite}.log"
