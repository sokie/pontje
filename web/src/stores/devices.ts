import { create } from "zustand"

import { api } from "@/api/client"
import { deviceId, guessPlatform } from "@/lib/device"
import { onWs } from "@/lib/ws/bus"
import { ensureSocket } from "@/lib/ws/socket"
import { useSession } from "@/stores/session"

export type PeerDevice = {
  id: string
  name: string
  platform: string | null
  online: boolean
  lastSeen: string | null
}

export type LinkedBanner = { name: string; ts: number }

type DevicesState = {
  devices: PeerDevice[]
  /** True when this browser isn't registered yet — the UI shows the naming card. */
  needsNaming: boolean
  /** Transient "Pixel 8 linked just now" banner, set by the device-linked WS event. */
  linkedBanner: LinkedBanner | null
  load: () => Promise<void>
  /** Connects WS if this browser is registered; otherwise flags first-run naming. */
  ensureRegisteredAndConnected: () => Promise<void>
  /** First-run: register this browser under the given name, then connect. */
  registerThisDevice: (name: string) => Promise<string | null>
  renameDevice: (id: string, name: string) => Promise<string | null>
  removeDevice: (id: string) => Promise<string | null>
}

function errDetail(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail?: unknown }).detail
    if (typeof detail === "string") return detail
  }
  return fallback
}

export const useDevices = create<DevicesState>((set) => ({
  devices: [],
  needsNaming: false,
  linkedBanner: null,

  load: async () => {
    const { data } = await api.GET("/api/v1/devices")
    if (data) {
      set({
        devices: data.map((d) => ({
          id: d.id,
          name: d.name,
          platform: d.platform ?? null,
          online: d.online,
          lastSeen: d.last_seen ?? null,
        })),
      })
    }
  },

  ensureRegisteredAndConnected: async () => {
    const id = deviceId()
    const me = useSession.getState().me
    if (!me?.device_id || me.device_id !== id) {
      // First run on this browser: ask for a name before registering (PLAN.md §7.3).
      // No WS yet — the server closes sockets of unregistered devices (4404).
      set({ needsNaming: true })
      await useDevices.getState().load()
      return
    }
    set({ needsNaming: false })
    ensureSocket(id)
    await useDevices.getState().load()
  },

  registerThisDevice: async (name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return "Please give this device a name."
    const id = deviceId()
    const { error } = await api.POST("/api/v1/devices", {
      body: { id, name: trimmed, platform: guessPlatform() },
    })
    if (error) return errDetail(error, "Registering this device failed.")
    set({ needsNaming: false })
    await useSession.getState().fetchMe() // pick up the fresh device binding
    ensureSocket(id)
    await useDevices.getState().load()
    return null
  },

  renameDevice: async (id: string, name: string) => {
    const trimmed = name.trim()
    if (!trimmed) return "Name must not be empty."
    const { error } = await api.PATCH("/api/v1/devices/{device_id}", {
      params: { path: { device_id: id } },
      body: { name: trimmed },
    })
    if (error) return errDetail(error, "Rename failed.")
    await useDevices.getState().load()
    return null
  },

  removeDevice: async (id: string) => {
    const { error } = await api.DELETE("/api/v1/devices/{device_id}", {
      params: { path: { device_id: id } },
    })
    if (error) return errDetail(error, "Remove failed.")
    set((s) => ({ devices: s.devices.filter((d) => d.id !== id) }))
    return null
  },
}))

// Module-scope WS subscriptions (engine outside the React tree, PLAN.md §5).
onWs("peers", (msg) => {
  const peers = msg.peers as Array<{
    deviceId: string
    name: string
    platform: string | null
    online: boolean
    lastSeen: string | null
  }>
  useDevices.setState({
    devices: peers.map((p) => ({
      id: p.deviceId,
      name: p.name,
      platform: p.platform,
      online: p.online,
      lastSeen: p.lastSeen,
    })),
  })
})

onWs("peer-online", (msg) => {
  useDevices.setState((s) => ({
    devices: s.devices.map((d) => (d.id === msg.deviceId ? { ...d, online: true } : d)),
  }))
})

onWs("peer-offline", (msg) => {
  useDevices.setState((s) => ({
    devices: s.devices.map((d) =>
      d.id === msg.deviceId
        ? { ...d, online: false, lastSeen: (msg.lastSeen as string | null) ?? d.lastSeen }
        : d,
    ),
  }))
})

// A QR device-link claim finished registering on the new device → refresh the
// list and show a transient banner (PLAN.md §9 device-linked).
onWs("device-linked", (msg) => {
  const name = typeof msg.deviceName === "string" ? msg.deviceName : "A device"
  const banner: LinkedBanner = { name, ts: Date.now() }
  useDevices.setState({ linkedBanner: banner })
  void useDevices.getState().load()
  setTimeout(() => {
    if (useDevices.getState().linkedBanner?.ts === banner.ts) {
      useDevices.setState({ linkedBanner: null })
    }
  }, 8000)
})
