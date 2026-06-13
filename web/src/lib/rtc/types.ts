// Shared transfer types for the WebRTC engine (PLAN.md §10).
// Framework-free by design (PLAN.md §5): no React imports anywhere in lib/rtc.

import type { SinkKind } from "../save"

export type TransferKind = "file" | "folder"
export type TransferDirection = "send" | "recv"
export type NetworkPath = "lan" | "internet" | "relay"

export type TransferStatus =
  | "connecting"
  | "awaiting-accept"
  | "transferring"
  | "done"
  | "failed"
  | "rejected"
  | "canceled"

const TERMINAL = new Set<TransferStatus>(["done", "failed", "rejected", "canceled"])

export function isTerminal(status: TransferStatus): boolean {
  return TERMINAL.has(status)
}

/**
 * Pull-based byte source the send loop drains — the seam Phase 4 plugs its
 * streaming folder-zip into (zip streams can't random-access, hence the
 * sequential pull shape).
 */
export type SendSource = {
  name: string
  size: number
  mime: string
  kind: TransferKind
  fileCount?: number
  /** Sequential pull: resolves the next chunk, or null at EOF. */
  next(): Promise<ArrayBuffer | null>
}

/** What the engine exposes to the store — components never see engine internals. */
export type TransferSnapshot = {
  id: string
  direction: TransferDirection
  peerDeviceId: string
  name: string
  size: number
  mime: string
  kind: TransferKind
  fileCount?: number
  /** Phase 5 pull mode: set on pull placeholders, pulled receives and
   * pull-serves — lets the UI tie a transfer back to its offer. */
  sharedFileId?: string
  status: TransferStatus
  /** sentBytes for direction "send", recvBytes for direction "recv". */
  bytes: number
  /** Throughput EMA in bytes/s, recomputed at most 2×/s. */
  rate: number
  networkPath?: NetworkPath
  /** Which save strategy the receiver picked (PLAN.md §10.4). */
  sinkKind?: SinkKind
  error?: string
}

export type EngineEvent =
  | { type: "upsert"; transfer: TransferSnapshot }
  | { type: "progress"; id: string; bytes: number; rate: number }
  /** Phase 5 pull: the placeholder row was superseded by the real incoming
   * transfer (correlated meta arrived) — drop it without a terminal state. */
  | { type: "remove"; id: string }
  /** Phase 5, sharer side: a pull hit a permission wall — surface the
   * re-grant prompt (stores/shares.ts). */
  | { type: "share-needs-grant"; sharedFileId: string; name: string }
  /** Phase 5, puller side: the sharer answered `unavailable` —
   * stores/shares.ts reports the offer stale when the reason is "gone". */
  | { type: "pull-unavailable"; sharedFileId: string; reason: "gone" | "needs-grant" }
