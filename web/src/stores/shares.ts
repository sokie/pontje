import { create } from "zustand"

import { api } from "@/api/client"
import type { components } from "@/api/schema"
import { deviceId } from "@/lib/device"
import { onEngineEvent, pullShared } from "@/lib/rtc/engine"
import {
  gcShares,
  grantShare,
  localShareInfo,
  persistShare,
  removeShare,
  type ShareDurability,
  type ShareInput,
} from "@/lib/shares/persistence"
import { shareInputMeta } from "@/lib/shares/pick"
import { onWs } from "@/lib/ws/bus"

type SharedFileOut = components["schemas"]["SharedFileOut"]

/** One pull-able offer (PLAN.md §14.1) — metadata only, the bytes live on the
 * sharing device. category is derived server-side (PLAN.md §14.4). */
export type SharedOffer = {
  id: string
  fileName: string
  mime: string | null
  sizeBytes: number | null
  category: string
  fromDevice: string
  status: "active" | "stale"
  createdAt: string
}

/** Sharer-side: a pull hit a permission wall — re-authorize via a click. */
export type RegrantPrompt = { sharedFileId: string; name: string }

function fromOut(f: SharedFileOut): SharedOffer {
  return {
    id: f.id,
    fileName: f.file_name,
    mime: f.mime ?? null,
    sizeBytes: f.size_bytes ?? null,
    category: f.category,
    fromDevice: f.from_device,
    status: f.status === "stale" ? "stale" : "active",
    createdAt: f.created_at,
  }
}

function markStale(id: string): void {
  void api
    .POST("/api/v1/shared-files/{shared_file_id}/stale", {
      params: { path: { shared_file_id: id } },
    })
    .catch(() => undefined) // fire-and-forget — the next puller will report again
}

type SharesState = {
  /** Newest first — the server orders by created_at desc, live rows prepend. */
  offers: SharedOffer[]
  loaded: boolean
  /** Persistence-tier label for offers shared BY THIS DEVICE (offer id → label). */
  durability: Record<string, ShareDurability>
  regrants: RegrantPrompt[]
  load: () => Promise<void>
  /**
   * Publish one offer per input (POST + persistShare keyed by the returned
   * id; a failed stash retracts the offer). Returns the first error message
   * (or null) plus the durability of what WAS published, for the hint.
   */
  publish: (inputs: ShareInput[]) => Promise<{
    error: string | null
    durabilities: ShareDurability[]
  }>
  unshare: (id: string) => Promise<void>
  /**
   * Pull over WebRTC — call from the Download click (it's the save gesture).
   * Progress lives in the transfers store; rows carry sharedFileId so the
   * Files view can tie them back to the offer.
   */
  pull: (offer: SharedOffer) => void
  /** MUST run from a click handler — requestPermission needs the gesture. */
  grant: (sharedFileId: string) => Promise<void>
  dismissRegrant: (sharedFileId: string) => void
}

function upsertOffer(offers: SharedOffer[], offer: SharedOffer): SharedOffer[] {
  return offers.some((o) => o.id === offer.id)
    ? offers.map((o) => (o.id === offer.id ? offer : o))
    : [offer, ...offers]
}

export const useShares = create<SharesState>((set) => ({
  offers: [],
  loaded: false,
  durability: {},
  regrants: [],

  load: async () => {
    const { data } = await api.GET("/api/v1/shared-files")
    if (!data) return
    const offers = data.map(fromOut)
    set({ offers, loaded: true })
    await reconcileLocal(offers)
  },

  publish: async (inputs) => {
    let error: string | null = null
    const durabilities: ShareDurability[] = []
    for (const input of inputs) {
      const meta = await shareInputMeta(input)
      if (!meta) {
        error ??= "could not read the file"
        continue
      }
      const { data, error: postError } = await api.POST("/api/v1/shared-files", {
        body: { file_name: meta.name, mime: meta.mime, size_bytes: meta.size },
      })
      if (postError || !data) {
        error ??= "could not publish the offer"
        continue
      }
      const offer = fromOut(data)
      set((s) => ({ offers: upsertOffer(s.offers, offer) })) // broadcast may race — upsert
      try {
        const persisted = await persistShare(offer.id, input)
        durabilities.push(persisted.durability)
        set((s) => ({ durability: { ...s.durability, [offer.id]: persisted.durability } }))
      } catch {
        // Nowhere to keep the bytes — retract the offer rather than leave a dud.
        void api
          .DELETE("/api/v1/shared-files/{shared_file_id}", {
            params: { path: { shared_file_id: offer.id } },
          })
          .catch(() => undefined)
        set((s) => ({ offers: s.offers.filter((o) => o.id !== offer.id) }))
        error ??= "could not stash the file for later"
      }
    }
    return { error, durabilities }
  },

  unshare: async (id) => {
    const { response } = await api.DELETE("/api/v1/shared-files/{shared_file_id}", {
      params: { path: { shared_file_id: id } },
    })
    // 404 = already gone elsewhere — drop it locally either way.
    if (response.ok || response.status === 404) {
      set((s) => ({ offers: s.offers.filter((o) => o.id !== id) }))
      await removeShare(id)
    }
  },

  pull: (offer) => {
    pullShared(offer.fromDevice, {
      id: offer.id,
      fileName: offer.fileName,
      mime: offer.mime,
      sizeBytes: offer.sizeBytes,
    })
  },

  grant: async (sharedFileId) => {
    if (await grantShare(sharedFileId)) {
      set((s) => ({
        regrants: s.regrants.filter((r) => r.sharedFileId !== sharedFileId),
      }))
    }
    // Denied/dismissed → the prompt card stays for another try.
  },

  dismissRegrant: (sharedFileId) => {
    set((s) => ({ regrants: s.regrants.filter((r) => r.sharedFileId !== sharedFileId) }))
  },
}))

// ---- One-time local reconciliation (PLAN.md §14.2): gc stash records the
// 48 h sweeper orphaned, restore durability labels for own offers, and
// proactively report own offers this device can no longer serve (memory-tier
// files lost to a reload) instead of letting the first pull discover it.

let reconciled = false

async function reconcileLocal(offers: SharedOffer[]): Promise<void> {
  if (reconciled) return
  reconciled = true
  try {
    await gcShares(offers.map((o) => o.id))
    const local = await localShareInfo()
    const durability: Record<string, ShareDurability> = {}
    const self = deviceId()
    for (const offer of offers) {
      if (offer.fromDevice !== self) continue
      const info = local.get(offer.id)
      if (!info) continue // no record — let a pull discover it (GoneError → stale)
      durability[offer.id] = info.durability
      // A record-backed memory share whose File didn't survive the reload can
      // NEVER serve again — report it stale now instead of at the first pull.
      if (!info.servable && offer.status === "active") markStale(offer.id)
    }
    useShares.setState({ durability })
  } catch {
    // persistence unavailable — labels just won't show; pulls will still
    // resolve (or fail honestly) through the engine
  }
}

// ---- Module-scope subscriptions (engine outside the React tree, PLAN.md §5).

onWs("file-shared", (msg) => {
  const out = msg.sharedFile as SharedFileOut | undefined
  if (!out || typeof out.id !== "string") return
  useShares.setState((s) => ({ offers: upsertOffer(s.offers, fromOut(out)) }))
})

onWs("file-unshared", (msg) => {
  if (typeof msg.id !== "string") return
  const id = msg.id
  useShares.setState((s) => ({ offers: s.offers.filter((o) => o.id !== id) }))
  void removeShare(id) // no-op on devices that never held the bytes
})

onWs("file-stale", (msg) => {
  if (typeof msg.id !== "string") return
  const id = msg.id
  useShares.setState((s) => ({
    offers: s.offers.map((o) => (o.id === id ? { ...o, status: "stale" as const } : o)),
  }))
  void removeShare(id) // a stale offer can never be served again — drop the stash
})

// Refresh on every `peers` snapshot: it arrives once per socket (re)connect,
// catching offer broadcasts missed while disconnected — and it doubles as the
// "app load" trigger for the one-time reconciliation above.
onWs("peers", () => {
  void useShares.getState().load()
})

onEngineEvent((e) => {
  if (e.type === "share-needs-grant") {
    useShares.setState((s) => {
      if (s.regrants.some((r) => r.sharedFileId === e.sharedFileId)) return s
      const name =
        e.name || s.offers.find((o) => o.id === e.sharedFileId)?.fileName || "a shared file"
      return { regrants: [...s.regrants, { sharedFileId: e.sharedFileId, name }] }
    })
  } else if (e.type === "pull-unavailable" && e.reason === "gone") {
    // The sharer answered gone → grey the offer out everywhere. needs-grant
    // deliberately does NOT mark stale — a re-grant on the sharer fixes it.
    markStale(e.sharedFileId)
  }
})
