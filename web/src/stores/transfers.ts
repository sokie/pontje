import { create } from "zustand"

import { api } from "@/api/client"
import { deviceId } from "@/lib/device"
import {
  acceptIncoming as engineAcceptIncoming,
  autoAcceptEnabled,
  cancelTransfer as engineCancelTransfer,
  initTransferEngine,
  onEngineEvent,
  rejectIncoming as engineRejectIncoming,
  sendFiles as engineSendFiles,
  sendFromSource as engineSendFromSource,
  setAutoAccept as engineSetAutoAccept,
  setAutoAcceptPeerGuard,
} from "@/lib/rtc/engine"
import { folderSource, type PickedFolder } from "@/lib/rtc/folderSource"
import { isTerminal, type TransferSnapshot, type TransferStatus } from "@/lib/rtc/types"
import { useDevices } from "@/stores/devices"

export type Transfer = TransferSnapshot

/** Done/failed/rejected/canceled rows linger briefly, then clear (PLAN.md §17). */
const LINGER_MS = 5000

type TransfersState = {
  /** Live transfers keyed by id — the ONLY transfer state components read. */
  transfers: Record<string, Transfer>
  /** "Auto-accept from my own devices" (PLAN.md §10.2), persisted by the engine. */
  autoAccept: boolean
  sendFiles: (deviceId: string, files: File[]) => void
  /** Each folder streams as one zip through the engine (PLAN.md §11). */
  sendFolders: (deviceId: string, folders: PickedFolder[]) => void
  /**
   * Fan out to every ONLINE device except this one (PLAN.md §10.3). Engine
   * queues are per-target with independent backpressure, and every target
   * gets its OWN folder source — a zip stream can only be consumed once.
   */
  sendToAll: (files: File[], folders: PickedFolder[]) => void
  /**
   * Call DIRECTLY from the Accept click handler: the engine opens the save
   * picker inside the user's gesture (PLAN.md §10.4).
   */
  acceptIncoming: (id: string) => void
  rejectIncoming: (id: string) => void
  cancel: (id: string) => void
  setAutoAccept: (on: boolean) => void
}

export const useTransfers = create<TransfersState>((set) => ({
  transfers: {},
  autoAccept: autoAcceptEnabled(),

  sendFiles: (deviceId, files) => engineSendFiles(deviceId, files),
  sendFolders: (deviceId, folders) => {
    for (const folder of folders) engineSendFromSource(deviceId, folderSource(folder))
  },
  sendToAll: (files, folders) => {
    const self = deviceId()
    const targets = useDevices.getState().devices.filter((d) => d.online && d.id !== self)
    for (const target of targets) {
      if (files.length > 0) engineSendFiles(target.id, files)
      // Fresh source per target: N independent zip streams over the same Files.
      for (const folder of folders) engineSendFromSource(target.id, folderSource(folder))
    }
  },
  acceptIncoming: (id) => engineAcceptIncoming(id),
  rejectIncoming: (id) => engineRejectIncoming(id),
  cancel: (id) => engineCancelTransfer(id),

  setAutoAccept: (on) => {
    engineSetAutoAccept(on)
    set({ autoAccept: on })
  },
}))

// ---- Module-scope engine wiring (engine outside the React tree, PLAN.md §5).
// Both calls are idempotent/once-per-module, so StrictMode double-effects
// can't double-register anything.

initTransferEngine()

// Session guests ALWAYS get a prompt (PLAN.md §10.2): the auto-accept toggle
// only ever applies when the sender is one of MY OWN devices. The devices
// store is user-scoped, so a cross-user session member's device is never in
// it — and an empty (not-yet-loaded) list safely falls back to prompting.
setAutoAcceptPeerGuard((peerDeviceId) =>
  useDevices.getState().devices.some((d) => d.id === peerDeviceId),
)

// ---- Sender-side history logging (PLAN.md §14.3). When one of OUR sends
// reaches a terminal state, POST its metadata to /api/v1/transfers exactly
// once. The engine emits a single terminal upsert per transfer (terminal
// states are final), but dedupe by id anyway — double-logging must be
// impossible. Receivers never log: the server's transfer-logged broadcast
// reaches every device of the user, this one included (stores/files.ts).

const LOG_STATUS: Partial<Record<TransferStatus, string>> = {
  done: "completed",
  failed: "failed",
  rejected: "rejected",
  canceled: "canceled",
}

const loggedTransferIds = new Set<string>()

function logTerminalSend(t: Transfer): void {
  const status = LOG_STATUS[t.status]
  if (!status || t.direction !== "send" || loggedTransferIds.has(t.id)) return
  loggedTransferIds.add(t.id)
  void api
    .POST("/api/v1/transfers", {
      body: {
        file_name: t.name,
        mime: t.mime,
        size_bytes: t.size,
        to_device: t.peerDeviceId,
        network_path: t.networkPath ?? null,
        status,
      },
    })
    .catch(() => {
      // Server unreachable — this row is simply missing from history.
    })
}

const lingerTimers = new Map<string, ReturnType<typeof setTimeout>>()

onEngineEvent((e) => {
  if (e.type === "upsert") {
    const transfer = e.transfer
    logTerminalSend(transfer)
    useTransfers.setState((s) => ({ transfers: { ...s.transfers, [transfer.id]: transfer } }))
    const pending = lingerTimers.get(transfer.id)
    if (pending) {
      clearTimeout(pending)
      lingerTimers.delete(transfer.id)
    }
    if (isTerminal(transfer.status)) {
      lingerTimers.set(
        transfer.id,
        setTimeout(() => {
          lingerTimers.delete(transfer.id)
          useTransfers.setState((s) => {
            if (!(transfer.id in s.transfers)) return s
            const next = { ...s.transfers }
            delete next[transfer.id]
            return { transfers: next }
          })
        }, LINGER_MS),
      )
    }
    return
  }
  if (e.type === "remove") {
    // Phase 5 pull: the placeholder row was superseded by the real incoming
    // transfer — drop it without a terminal state.
    const pending = lingerTimers.get(e.id)
    if (pending) {
      clearTimeout(pending)
      lingerTimers.delete(e.id)
    }
    useTransfers.setState((s) => {
      if (!(e.id in s.transfers)) return s
      const next = { ...s.transfers }
      delete next[e.id]
      return { transfers: next }
    })
    return
  }
  if (e.type !== "progress") return // pull-mode events belong to stores/shares.ts
  // progress — engine already throttles (≥100 ms or ≥1 % delta)
  useTransfers.setState((s) => {
    const current = s.transfers[e.id]
    if (!current || (current.bytes === e.bytes && current.rate === e.rate)) return s
    return { transfers: { ...s.transfers, [e.id]: { ...current, bytes: e.bytes, rate: e.rate } } }
  })
})
