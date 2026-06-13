// Singleton reconnecting WebSocket — lives in module scope, never in React
// state (PLAN.md §5). Idempotent init (StrictMode-safe).

import { emitWs, type WsMessage } from "./bus"

let socket: WebSocket | null = null
let currentDeviceId: string | null = null
let reconnectDelay = 1000
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let closedByUs = false

function wsUrl(deviceId: string): string {
  const proto = location.protocol === "https:" ? "wss" : "ws"
  return `${proto}://${location.host}/ws?device=${encodeURIComponent(deviceId)}`
}

export function ensureSocket(deviceId: string): void {
  if (socket && currentDeviceId === deviceId) return
  closeSocket()
  closedByUs = false
  currentDeviceId = deviceId
  connect()
}

function connect(): void {
  if (!currentDeviceId || closedByUs) return
  const ws = new WebSocket(wsUrl(currentDeviceId))
  socket = ws

  ws.onopen = () => {
    reconnectDelay = 1000
  }
  ws.onmessage = (ev) => {
    try {
      emitWs(JSON.parse(ev.data) as WsMessage)
    } catch {
      // ignore malformed frames
    }
  }
  ws.onclose = (ev) => {
    if (socket === ws) socket = null
    // 4401/4404: auth/device problem — reconnecting won't help.
    if (closedByUs || ev.code === 4401 || ev.code === 4404) return
    reconnectTimer = setTimeout(connect, reconnectDelay)
    reconnectDelay = Math.min(reconnectDelay * 2, 30_000)
  }
}

export function sendWs(msg: WsMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  socket.send(JSON.stringify(msg))
  return true
}

export function closeSocket(): void {
  closedByUs = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  socket?.close()
  socket = null
  currentDeviceId = null
}
