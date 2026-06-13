// WebRTC 1:1 file-transfer engine (PLAN.md §10). Framework-free: connections,
// queues and transfer state live in module scope, never in React state
// (PLAN.md §5). The engine emits events; stores/transfers.ts consumes the
// transfer ones, stores/shares.ts the pull-mode ones, and components only
// ever read those stores.
//
// Topology: ONE lazily-created RTCPeerConnection per remote device, reused
// for subsequent files, torn down on peer-offline or fatal error. Each side
// that wants to SEND creates its own persistent RTCDataChannel("pontje");
// the remote receives it via ondatachannel. Extra channels ride DCEP over
// the single SCTP association, so only the side that first builds the
// connection ever creates an offer — renegotiation never happens.
//
// Glare: if both devices happen to build the connection simultaneously, both
// send offers. The device with the lexicographically smaller deviceId wins;
// the loser rolls back its local offer and answers — its already-created data
// channel still opens over the winner's association. Stale ICE candidates
// from the rolled-back attempt fail addIceCandidate and are ignored.
//
// Wire protocol per channel (sender side created it):
//   sender → receiver  {t:'meta',…} · [binary chunk]×N · {t:'done'} · {t:'cancel'}
//   receiver → sender  {t:'accept'} · {t:'reject'} · {t:'received'} · {t:'cancel'}
//
// Pull mode (PLAN.md §10.2, Phase 5): the PULLER initiates and asks for a
// shared offer on its own channel; the sharer serves it back through the
// normal send machinery on its own channel (meta gains sharedFileId so the
// puller can correlate), or declines:
//   puller → sharer    {t:'pull', sharedFileId}
//   sharer → puller    {t:'unavailable', sharedFileId, reason:'gone'|'needs-grant'}

import { deviceId } from "../device"
import { canAutoSave, openSink, SaveCanceledError, type Sink } from "../save"
import { NeedsGrantError, resolveShare } from "../shares/persistence"
import { onWs } from "../ws/bus"
import { sendWs } from "../ws/socket"
import { fileSource } from "./fileSource"
import {
  isTerminal,
  type EngineEvent,
  type NetworkPath,
  type SendSource,
  type TransferSnapshot,
  type TransferStatus,
} from "./types"

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  iceTransportPolicy: "all",
}

const CHANNEL_LABEL = "pontje"
const MAX_BUFFERED = 1024 * 1024 // pause the send loop above this (PLAN.md §10.2)
const BUFFERED_LOW_THRESHOLD = 256 * 1024
const OPEN_TIMEOUT_MS = 30_000 // offer sent but channel never opened (e.g. AP isolation)
const PULL_TIMEOUT_MS = 30_000 // pull sent but the correlated meta never arrived
const AUTO_ACCEPT_KEY = "pontje.autoAccept"

// ---------------------------------------------------------------------------
// Engine events

type Listener = (e: EngineEvent) => void
const listeners = new Set<Listener>()

export function onEngineEvent(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(e: EngineEvent): void {
  for (const l of listeners) l(e)
}

function emitUpsert(snap: TransferSnapshot): void {
  emit({ type: "upsert", transfer: { ...snap } })
  updateWakeLock()
}

// ---------------------------------------------------------------------------
// Internal state

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

type ProgressTrack = {
  lastEmitT: number
  lastEmitBytes: number
  lastRateT: number
  lastRateBytes: number
}

const freshTrack = (): ProgressTrack => ({
  lastEmitT: 0,
  lastEmitBytes: 0,
  lastRateT: 0,
  lastRateBytes: 0,
})

type Outgoing = ProgressTrack & {
  snap: TransferSnapshot
  source: SendSource
  sent: number
  metaSent: boolean
  aborted: boolean
  abort: Deferred<"aborted">
  decision: Deferred<"accept" | "reject" | "aborted">
  received: Deferred<"received" | "aborted">
}

type Incoming = ProgressTrack & {
  snap: TransferSnapshot
  sink: Sink | null
  received: number
  writeChain: Promise<void>
  writeError: unknown
  aborted: boolean
  /** True while an Accept click's sink (picker) is opening — blocks re-entry. */
  deciding: boolean
}

/** A pull we sent, waiting for the correlated meta (or `unavailable`).
 * `aborted` keeps a canceled pull around as a tombstone until meta/timeout so
 * a late serve gets rejected instead of auto-accepted. */
type PendingPull = {
  sharedFileId: string
  snap: TransferSnapshot
  timer: ReturnType<typeof setTimeout>
  aborted: boolean
}

type Peer = {
  id: string
  pc: RTCPeerConnection
  outDc: RTCDataChannel | null
  outOpen: Deferred<"open" | "aborted"> | null
  openTimer: ReturnType<typeof setTimeout> | null
  inDc: RTCDataChannel | null
  pendingIce: RTCIceCandidateInit[]
  queue: Outgoing[]
  active: Outgoing | null
  incoming: Incoming | null
  /** Outstanding pulls by sharedFileId (puller side). */
  pulls: Map<string, PendingPull>
  pumping: boolean
  closed: boolean
  networkPath: NetworkPath | null
}

const peers = new Map<string, Peer>()

const myId = () => deviceId()

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ---------------------------------------------------------------------------
// Public API (called by stores/transfers.ts)

export function sendFiles(targetDeviceId: string, files: File[]): void {
  for (const file of files) sendFromSource(targetDeviceId, fileSource(file))
}

/** Generic entry point — Phase 4 feeds zip streams through the same path;
 * Phase 5 pull-serves pass sharedFileId so the puller can correlate the meta. */
export function sendFromSource(
  targetDeviceId: string,
  source: SendSource,
  sharedFileId?: string,
): string {
  const snap: TransferSnapshot = {
    id: randomId(),
    direction: "send",
    peerDeviceId: targetDeviceId,
    name: source.name,
    size: source.size,
    mime: source.mime,
    kind: source.kind,
    ...(source.fileCount !== undefined && { fileCount: source.fileCount }),
    ...(sharedFileId !== undefined && { sharedFileId }), // pull-serve correlation
    status: "connecting",
    bytes: 0,
    rate: 0,
  }
  const t: Outgoing = {
    ...freshTrack(),
    snap,
    source,
    sent: 0,
    metaSent: false,
    aborted: false,
    abort: deferred(),
    decision: deferred(),
    received: deferred(),
  }
  if (targetDeviceId === myId()) {
    // UI disables self-targeting; fail fast if something slips through.
    emitUpsert(snap)
    abortOutgoing(null, t, "failed", "can't send a file to this device itself", false)
    return snap.id
  }
  const peer = getPeer(targetDeviceId)
  peer.queue.push(t)
  emitUpsert(snap)
  ensureSenderChannel(peer)
  pump(peer)
  return snap.id
}

export type SharedOfferRef = {
  id: string
  fileName: string
  mime: string | null
  sizeBytes: number | null
}

/**
 * Pull a shared offer from its sharer (PLAN.md §10.2 pull mode): ensure a
 * channel, send {t:'pull'}, then await the correlated meta. The placeholder
 * row fails on timeout / `unavailable` / teardown; when the meta arrives it
 * is superseded by the real incoming transfer, which is auto-accepted (the
 * Download click was the gesture). Returns the placeholder transfer id.
 */
export function pullShared(sharerDeviceId: string, offer: SharedOfferRef): string {
  const snap: TransferSnapshot = {
    id: randomId(),
    direction: "recv",
    peerDeviceId: sharerDeviceId,
    name: offer.fileName,
    size: offer.sizeBytes ?? 0,
    mime: offer.mime ?? "application/octet-stream",
    kind: "file",
    sharedFileId: offer.id,
    status: "connecting",
    bytes: 0,
    rate: 0,
  }
  if (sharerDeviceId === myId()) {
    // The UI never offers a Download for this device's own offers.
    emitUpsert(snap)
    setStatus({ snap }, "failed", "this device is the one sharing the file")
    return snap.id
  }
  const peer = getPeer(sharerDeviceId)
  const existing = peer.pulls.get(offer.id)
  if (existing && !existing.aborted && !isTerminal(existing.snap.status)) {
    return existing.snap.id // this offer is already being pulled — don't double up
  }
  if (existing) clearTimeout(existing.timer) // replacing a canceled tombstone — disarm it
  const pull: PendingPull = {
    sharedFileId: offer.id,
    snap,
    aborted: false,
    timer: setTimeout(() => {
      // Identity check: this entry may have been replaced by a retry.
      if (peer.pulls.get(offer.id) === pull) peer.pulls.delete(offer.id)
      setStatus(pull, "failed", "the sharing device did not respond")
    }, PULL_TIMEOUT_MS),
  }
  peer.pulls.set(offer.id, pull)
  emitUpsert(snap)
  ensureSenderChannel(peer)
  void sendPullWhenOpen(peer, pull)
  return snap.id
}

async function sendPullWhenOpen(peer: Peer, pull: PendingPull): Promise<void> {
  const dc = peer.outDc
  const open = peer.outOpen
  if (!dc || !open) {
    settlePullFailed(peer, pull, "no connection")
    return
  }
  if (dc.readyState !== "open") {
    const r = await open.promise
    // "aborted" = teardown already failed this pull; bail quietly.
    if (r !== "open" || pull.aborted || isTerminal(pull.snap.status)) return
  }
  if (!trySendJson(peer.outDc, { t: "pull", sharedFileId: pull.sharedFileId })) {
    settlePullFailed(peer, pull, "connection lost")
  }
}

/** Remove a pending pull and land its placeholder in a terminal state. */
function settlePullFailed(peer: Peer, pull: PendingPull, error: string): void {
  clearTimeout(pull.timer)
  if (peer.pulls.get(pull.sharedFileId) === pull) peer.pulls.delete(pull.sharedFileId)
  setStatus(pull, "failed", error)
}

/**
 * Accept an incoming transfer from the prompt. MUST be called synchronously
 * from the click handler: openSink runs the save-file picker inside the
 * user's gesture (PLAN.md §10.4).
 */
export function acceptIncoming(id: string): void {
  const found = findIncoming(id)
  if (!found) return
  const [peer, inc] = found
  if (inc.snap.status !== "awaiting-accept" || inc.deciding) return
  inc.deciding = true
  const sinkPromise = openSink(
    { name: inc.snap.name, size: inc.snap.size, mime: inc.snap.mime },
    { gestureAvailable: true },
  )
  void sinkPromise.then(
    (sink) => {
      // Reject/cancel may have raced the picker — don't resurrect.
      if (inc.aborted || inc.snap.status !== "awaiting-accept") {
        void sink.abort()
        return
      }
      startReceiving(peer, inc, sink)
    },
    (err) => {
      if (inc.aborted || inc.snap.status !== "awaiting-accept") return
      inc.deciding = false
      if (err instanceof SaveCanceledError) {
        // The user dismissed the picker — treat as a rejection.
        rejectIncoming(id)
      } else {
        trySendJson(peer.inDc, { t: "reject", fileId: id })
        inc.aborted = true
        setStatus(inc, "failed", `could not save: ${errMsg(err)}`)
        clearIncoming(peer, inc)
      }
    },
  )
}

export function rejectIncoming(id: string): void {
  const found = findIncoming(id)
  if (!found) return
  const [peer, inc] = found
  if (inc.snap.status !== "awaiting-accept") return
  trySendJson(peer.inDc, { t: "reject", fileId: id })
  inc.aborted = true
  setStatus(inc, "rejected")
  clearIncoming(peer, inc)
}

/** Cancel any transfer (either direction, any non-terminal state). */
export function cancelTransfer(id: string): void {
  for (const peer of peers.values()) {
    const queued = peer.queue.findIndex((t) => t.snap.id === id)
    if (queued !== -1) {
      const [t] = peer.queue.splice(queued, 1)
      abortOutgoing(peer, t, "canceled", undefined, false) // meta never sent
      return
    }
    if (peer.active?.snap.id === id) {
      // Pre-accept this rescinds the offer: the receiver's prompt disappears.
      abortOutgoing(peer, peer.active, "canceled", undefined, true)
      return
    }
    if (peer.incoming?.snap.id === id) {
      abortIncoming(peer, peer.incoming, "canceled", undefined, true)
      return
    }
    for (const pull of peer.pulls.values()) {
      if (pull.snap.id === id) {
        // Tombstone until meta/timeout: a serve that still arrives is rejected
        // in handleMeta instead of being auto-accepted.
        pull.aborted = true
        setStatus(pull, "canceled")
        return
      }
    }
  }
}

export function autoAcceptEnabled(): boolean {
  try {
    return localStorage.getItem(AUTO_ACCEPT_KEY) !== "0" // default ON
  } catch {
    return true
  }
}

// Per-sender auto-accept policy (PLAN.md §10.2): "auto-accept from my own
// devices" — session guests ALWAYS get a prompt. stores/transfers.ts installs
// a predicate that checks the sender against the user's own device list; the
// default is permissive so the engine works standalone.
let autoAcceptPeerGuard: (peerDeviceId: string) => boolean = () => true

export function setAutoAcceptPeerGuard(guard: (peerDeviceId: string) => boolean): void {
  autoAcceptPeerGuard = guard
}

export function setAutoAccept(on: boolean): void {
  try {
    localStorage.setItem(AUTO_ACCEPT_KEY, on ? "1" : "0")
  } catch {
    // storage unavailable — the toggle just won't persist
  }
}

// ---------------------------------------------------------------------------
// Peer lifecycle

function getPeer(id: string): Peer {
  const existing = peers.get(id)
  if (existing) return existing
  const pc = new RTCPeerConnection(RTC_CONFIG)
  const peer: Peer = {
    id,
    pc,
    outDc: null,
    outOpen: null,
    openTimer: null,
    inDc: null,
    pendingIce: [],
    queue: [],
    active: null,
    incoming: null,
    pulls: new Map(),
    pumping: false,
    closed: false,
    networkPath: null,
  }
  pc.onicecandidate = (ev) => {
    if (ev.candidate) sendSignal("rtc-ice", id, { candidate: ev.candidate.toJSON() })
  }
  pc.ondatachannel = (ev) => attachInbound(peer, ev.channel)
  pc.oniceconnectionstatechange = () => {
    if (peer.closed) return
    const state = pc.iceConnectionState
    if (state === "failed") teardownPeer(id, "peer connection failed")
    // Re-check the path on connect AND on migrations (PLAN.md §10.5).
    else if (state === "connected" || state === "completed") void refreshNetworkPath(peer)
  }
  pc.onconnectionstatechange = () => {
    if (peer.closed) return
    if (pc.connectionState === "failed") teardownPeer(id, "peer connection failed")
  }
  peers.set(id, peer)
  return peer
}

/** Fail every transfer touching this peer and drop the connection. */
function teardownPeer(id: string, reason: string): void {
  const peer = peers.get(id)
  if (!peer || peer.closed) return
  peer.closed = true
  peers.delete(id)
  if (peer.openTimer) {
    clearTimeout(peer.openTimer)
    peer.openTimer = null
  }
  peer.outOpen?.resolve("aborted")
  const queued = peer.queue.splice(0)
  for (const t of queued) abortOutgoing(null, t, "failed", reason, false)
  if (peer.active) abortOutgoing(null, peer.active, "failed", reason, false)
  if (peer.incoming) abortIncoming(peer, peer.incoming, "failed", reason, false)
  for (const pull of peer.pulls.values()) {
    clearTimeout(pull.timer)
    setStatus(pull, "failed", reason) // no-op for already-canceled tombstones
  }
  peer.pulls.clear()
  try {
    peer.outDc?.close()
  } catch {
    // already closed
  }
  try {
    peer.inDc?.close()
  } catch {
    // already closed
  }
  try {
    peer.pc.close()
  } catch {
    // already closed
  }
}

function sendSignal(
  t: "rtc-offer" | "rtc-answer" | "rtc-ice",
  to: string,
  payload: Record<string, unknown>,
): boolean {
  return sendWs({ t, to, from: myId(), ...payload })
}

// ---------------------------------------------------------------------------
// Outbound channel + negotiation (sender side)

function ensureSenderChannel(peer: Peer): void {
  if (peer.outDc) return
  // Only a brand-new connection needs an offer; on an established (or
  // establishing) one the channel opens in-band via DCEP.
  const needsOffer = peer.pc.signalingState === "stable" && peer.pc.remoteDescription === null
  const dc = peer.pc.createDataChannel(CHANNEL_LABEL, { ordered: true })
  peer.outDc = dc
  peer.outOpen = deferred()
  attachOutbound(peer, dc)
  peer.openTimer = setTimeout(() => {
    if (dc.readyState !== "open") {
      teardownPeer(peer.id, "could not reach the device (connection timed out)")
    }
  }, OPEN_TIMEOUT_MS)
  if (needsOffer) void negotiate(peer)
}

async function negotiate(peer: Peer): Promise<void> {
  try {
    const offer = await peer.pc.createOffer()
    if (peer.closed) return
    await peer.pc.setLocalDescription(offer)
    if (peer.closed) return
    if (!sendSignal("rtc-offer", peer.id, { sdp: { type: offer.type, sdp: offer.sdp } })) {
      teardownPeer(peer.id, "not connected to the server")
    }
  } catch (e) {
    teardownPeer(peer.id, `could not start the connection: ${errMsg(e)}`)
  }
}

function attachOutbound(peer: Peer, dc: RTCDataChannel): void {
  dc.binaryType = "arraybuffer"
  dc.bufferedAmountLowThreshold = BUFFERED_LOW_THRESHOLD
  dc.onopen = () => {
    if (peer.openTimer) {
      clearTimeout(peer.openTimer)
      peer.openTimer = null
    }
    peer.outOpen?.resolve("open")
    void refreshNetworkPath(peer)
  }
  dc.onclose = () => {
    // Guard against zombie channels: only the CURRENT channel may tear down.
    if (!peer.closed && peer.outDc === dc) teardownPeer(peer.id, "connection closed")
  }
  dc.onerror = () => {
    if (!peer.closed && peer.outDc === dc) teardownPeer(peer.id, "data channel error")
  }
  // The receiver talks back on the sender's channel: accept/reject/received/
  // cancel — and, in pull mode, the sharer's `unavailable` verdicts.
  dc.onmessage = (ev) => {
    if (typeof ev.data !== "string") return // receivers never send binary
    const msg = parseControl(ev.data)
    if (!msg) return
    if (msg.t === "unavailable") {
      handleUnavailable(peer, msg)
      return
    }
    const t = peer.active
    if (!t || msg.fileId !== t.snap.id) return
    switch (msg.t) {
      case "accept":
        t.decision.resolve("accept")
        break
      case "reject":
        t.decision.resolve("reject")
        break
      case "received":
        t.received.resolve("received")
        break
      case "cancel":
        abortOutgoing(peer, t, "canceled", "canceled by the receiver", false)
        break
    }
  }
}

// Not every control frame carries fileId (pull/unavailable are keyed by
// sharedFileId) — handlers narrow the fields they need.
function parseControl(data: string): ({ t: string } & Record<string, unknown>) | null {
  try {
    const msg = JSON.parse(data) as Record<string, unknown>
    if (typeof msg !== "object" || msg === null) return null
    if (typeof msg.t !== "string") return null
    return msg as { t: string } & Record<string, unknown>
  } catch {
    return null
  }
}

function trySendJson(dc: RTCDataChannel | null, msg: Record<string, unknown>): boolean {
  if (!dc || dc.readyState !== "open") return false
  try {
    dc.send(JSON.stringify(msg))
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Send loop — per-target FIFO, one file in flight per channel

function pump(peer: Peer): void {
  if (peer.pumping) return
  peer.pumping = true
  void (async () => {
    try {
      let t: Outgoing | undefined
      while ((t = peer.queue.shift())) {
        if (t.aborted || isTerminal(t.snap.status)) continue
        peer.active = t
        try {
          await runSend(peer, t)
        } catch (e) {
          abortOutgoing(peer, t, "failed", errMsg(e), true)
        } finally {
          // Whatever happened, the transfer must land in a terminal state.
          if (!isTerminal(t.snap.status)) {
            abortOutgoing(peer, t, "failed", "transfer interrupted", false)
          }
          peer.active = null
        }
      }
    } finally {
      peer.pumping = false
    }
  })()
}

async function runSend(peer: Peer, t: Outgoing): Promise<void> {
  const dc = peer.outDc
  const open = peer.outOpen
  if (!dc || !open) {
    abortOutgoing(peer, t, "failed", "no connection", false)
    return
  }

  if (dc.readyState !== "open") {
    const r = await Promise.race([open.promise, t.abort.promise])
    if (r !== "open" || t.aborted) return // canceled or torn down while connecting
  }

  const meta: Record<string, unknown> = {
    t: "meta",
    fileId: t.snap.id,
    name: t.snap.name,
    size: t.snap.size,
    mime: t.snap.mime,
    kind: t.snap.kind,
  }
  if (t.snap.fileCount !== undefined) meta.fileCount = t.snap.fileCount
  if (t.snap.sharedFileId !== undefined) meta.sharedFileId = t.snap.sharedFileId // pull mode
  if (!trySendJson(dc, meta)) {
    abortOutgoing(peer, t, "failed", "connection lost", false)
    return
  }
  t.metaSent = true
  setStatus(t, "awaiting-accept")

  const decision = await t.decision.promise
  if (decision === "aborted" || t.aborted) return
  if (decision === "reject") {
    setStatus(t, "rejected")
    return
  }

  if (peer.networkPath) t.snap.networkPath = peer.networkPath
  setStatus(t, "transferring")

  // Sender progress = bytesSent − bufferedAmount (PLAN.md §10.2); a light
  // ticker keeps it moving while the buffer drains between chunks.
  const ticker = setInterval(() => {
    if (dc.readyState === "open" && !t.aborted) {
      pushProgress(t, Math.max(0, t.sent - dc.bufferedAmount))
    }
  }, 250)

  try {
    for (;;) {
      if (t.aborted) return
      let chunk: ArrayBuffer | null
      try {
        chunk = await t.source.next()
      } catch (e) {
        abortOutgoing(peer, t, "failed", `reading the file failed: ${errMsg(e)}`, true)
        return
      }
      if (t.aborted) return
      if (chunk === null) break
      while (dc.bufferedAmount > MAX_BUFFERED) {
        const r = await waitDrain(dc, t)
        if (r === "aborted" || t.aborted) return
      }
      try {
        dc.send(chunk)
      } catch (e) {
        abortOutgoing(peer, t, "failed", `sending failed: ${errMsg(e)}`, false)
        return
      }
      t.sent += chunk.byteLength
    }

    if (!trySendJson(dc, { t: "done", fileId: t.snap.id })) {
      abortOutgoing(peer, t, "failed", "connection lost", false)
      return
    }
    const fin = await t.received.promise
    if (fin === "aborted" || t.aborted) return
    pushProgress(t, t.snap.size, true)
    setStatus(t, "done")
  } finally {
    clearInterval(ticker)
  }
}

/** Resolve on bufferedamountlow OR transfer abort — never leaks the listener. */
function waitDrain(dc: RTCDataChannel, t: Outgoing): Promise<"low" | "aborted"> {
  return new Promise((resolve) => {
    const onLow = () => {
      cleanup()
      resolve("low")
    }
    const cleanup = () => dc.removeEventListener("bufferedamountlow", onLow)
    dc.addEventListener("bufferedamountlow", onLow)
    void t.abort.promise.then(() => {
      cleanup()
      resolve("aborted")
    })
  })
}

function abortOutgoing(
  peer: Peer | null,
  t: Outgoing,
  status: "canceled" | "failed" | "rejected",
  error: string | undefined,
  sendCancelFrame: boolean,
): void {
  if (isTerminal(t.snap.status)) return
  t.aborted = true
  if (sendCancelFrame && t.metaSent) {
    trySendJson(peer?.outDc ?? null, { t: "cancel", fileId: t.snap.id })
  }
  t.decision.resolve("aborted")
  t.received.resolve("aborted")
  t.abort.resolve("aborted")
  setStatus(t, status, error)
}

// ---------------------------------------------------------------------------
// Inbound channel — receive state machine

function attachInbound(peer: Peer, dc: RTCDataChannel): void {
  if (peer.inDc && peer.inDc !== dc) {
    // The sender re-created its channel — defuse the old one and fail any
    // file that was mid-stream on it.
    peer.inDc.onmessage = null
    peer.inDc.onclose = null
    if (peer.incoming) {
      abortIncoming(peer, peer.incoming, "failed", "channel reset by the sender", false)
    }
  }
  peer.inDc = dc
  dc.binaryType = "arraybuffer"
  dc.onopen = () => void refreshNetworkPath(peer)
  dc.onclose = () => {
    if (!peer.closed && peer.inDc === dc) teardownPeer(peer.id, "connection closed")
  }
  dc.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      const msg = parseControl(ev.data)
      if (!msg) return
      if (msg.t === "pull") {
        // Pull mode (PLAN.md §10.2): resolve the share and serve it through
        // the normal send machinery, or answer `unavailable`.
        if (typeof msg.sharedFileId === "string") void handlePull(peer, msg.sharedFileId)
        return
      }
      if (typeof msg.fileId !== "string") return
      const fileId = msg.fileId
      if (msg.t === "meta") {
        handleMeta(peer, dc, fileId, msg)
      } else if (msg.t === "done") {
        void finishIncoming(peer, fileId)
      } else if (msg.t === "cancel") {
        const inc = peer.incoming
        if (inc && inc.snap.id === fileId) {
          // Mid-transfer abort, or the sender rescinding a pending prompt.
          abortIncoming(peer, inc, "canceled", "canceled by the sender", false)
        }
      }
    } else {
      onChunk(peer, ev.data as ArrayBuffer | Blob)
    }
  }
}

function handleMeta(
  peer: Peer,
  dc: RTCDataChannel,
  fileId: string,
  msg: { t: string } & Record<string, unknown>,
): void {
  const size =
    typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size >= 0
      ? Math.floor(msg.size)
      : null
  // Pull correlation (PLAN.md §10.2): a meta carrying sharedFileId may be the
  // sharer answering one of OUR pending pulls.
  const pull =
    typeof msg.sharedFileId === "string" ? peer.pulls.get(msg.sharedFileId) : undefined
  if (pull) {
    clearTimeout(pull.timer)
    peer.pulls.delete(pull.sharedFileId)
  }
  if (size === null || peer.incoming) {
    // Malformed meta, or a second file while one is in flight (protocol says
    // one per channel) — refuse without disturbing current state.
    trySendJson(dc, { t: "reject", fileId })
    if (pull) setStatus(pull, "failed", "the download could not start")
    return
  }
  if (pull && (pull.aborted || isTerminal(pull.snap.status))) {
    // The pull was canceled before the sharer answered — refuse the serve.
    trySendJson(dc, { t: "reject", fileId })
    return
  }
  // The real incoming row supersedes the pull placeholder.
  if (pull) emit({ type: "remove", id: pull.snap.id })
  const snap: TransferSnapshot = {
    id: fileId,
    direction: "recv",
    peerDeviceId: peer.id,
    name: typeof msg.name === "string" && msg.name ? msg.name : "unnamed",
    size,
    mime: typeof msg.mime === "string" && msg.mime ? msg.mime : "application/octet-stream",
    // Phase 4 sends kind:'folder' + fileCount — pass them through to the UI.
    kind: msg.kind === "folder" ? "folder" : "file",
    ...(typeof msg.fileCount === "number" && { fileCount: msg.fileCount }),
    ...(pull !== undefined && { sharedFileId: pull.sharedFileId }),
    status: "connecting",
    bytes: 0,
    rate: 0,
  }
  if (peer.networkPath) snap.networkPath = peer.networkPath
  const inc: Incoming = {
    ...freshTrack(),
    snap,
    sink: null,
    received: 0,
    writeChain: Promise.resolve(),
    writeError: null,
    aborted: false,
    deciding: false,
  }
  peer.incoming = inc

  if (pull) {
    // Pulled files skip the prompt — the Download click was the gesture
    // (PLAN.md §10.2 pull mode). If transient activation has already expired,
    // openSink's picker attempt fails and the save ladder falls through to
    // its gesture-free strategies.
    emitUpsert(snap)
    void openSink({ name: snap.name, size, mime: snap.mime }, { gestureAvailable: true }).then(
      (sink) => {
        if (inc.aborted || isTerminal(inc.snap.status)) {
          void sink.abort()
          return
        }
        startReceiving(peer, inc, sink)
      },
      (err) => {
        if (inc.aborted || isTerminal(inc.snap.status)) return
        if (err instanceof SaveCanceledError) {
          // The user dismissed the save picker — treat the pull as rejected.
          trySendJson(peer.inDc, { t: "reject", fileId: inc.snap.id })
          inc.aborted = true
          setStatus(inc, "rejected")
          clearIncoming(peer, inc)
        } else {
          // No sink without a fresh gesture — the manual Accept provides one.
          setStatus(inc, "awaiting-accept")
        }
      },
    )
    return
  }

  if (autoAcceptEnabled() && autoAcceptPeerGuard(peer.id) && canAutoSave(size)) {
    emitUpsert(snap) // "connecting" while the gesture-free sink opens
    void openSink({ name: snap.name, size, mime: snap.mime }, { gestureAvailable: false }).then(
      (sink) => {
        if (inc.aborted || isTerminal(inc.snap.status)) {
          void sink.abort()
          return
        }
        startReceiving(peer, inc, sink)
      },
      () => {
        // No gesture-free sink after all — demote to the manual prompt.
        if (!inc.aborted && !isTerminal(inc.snap.status)) setStatus(inc, "awaiting-accept")
      },
    )
  } else {
    snap.status = "awaiting-accept" // surfaces the Accept/Reject prompt
    emitUpsert(snap)
  }
}

function startReceiving(peer: Peer, inc: Incoming, sink: Sink): void {
  inc.sink = sink
  inc.snap.sinkKind = sink.kind
  if (peer.networkPath) inc.snap.networkPath = peer.networkPath
  if (!trySendJson(peer.inDc, { t: "accept", fileId: inc.snap.id })) {
    void sink.abort()
    abortIncoming(peer, inc, "failed", "connection lost", false)
    return
  }
  setStatus(inc, "transferring")
}

function onChunk(peer: Peer, data: ArrayBuffer | Blob): void {
  const inc = peer.incoming
  // Stray bytes after a cancel/reject race are expected — drop them.
  if (!inc || inc.snap.status !== "transferring") return
  const sink = inc.sink
  if (!sink) return
  const len = data instanceof Blob ? data.size : data.byteLength
  inc.received += len
  if (inc.received > inc.snap.size) {
    abortIncoming(peer, inc, "failed", "received more bytes than announced", true)
    return
  }
  // Serialize writes; track the first failure (surfaced on the next chunk or
  // at done) — the chain itself never rejects, so no unhandled rejections.
  inc.writeChain = inc.writeChain
    .then(async () => {
      if (inc.aborted) return
      const buf = data instanceof Blob ? await data.arrayBuffer() : data
      await sink.write(buf)
    })
    .catch((e: unknown) => {
      inc.writeError ??= e ?? new Error("write failed")
    })
  pushProgress(inc, inc.received)
  if (inc.writeError) {
    abortIncoming(peer, inc, "failed", `saving failed: ${errMsg(inc.writeError)}`, true)
  }
}

async function finishIncoming(peer: Peer, fileId: string): Promise<void> {
  const inc = peer.incoming
  if (!inc || inc.snap.id !== fileId || inc.snap.status !== "transferring") return
  await inc.writeChain
  if (inc.aborted || isTerminal(inc.snap.status)) return
  if (inc.writeError) {
    abortIncoming(peer, inc, "failed", `saving failed: ${errMsg(inc.writeError)}`, true)
    return
  }
  if (inc.received !== inc.snap.size) {
    abortIncoming(
      peer,
      inc,
      "failed",
      `size mismatch: got ${inc.received} of ${inc.snap.size} bytes`,
      true,
    )
    return
  }
  try {
    await inc.sink?.close()
  } catch (e) {
    abortIncoming(peer, inc, "failed", `saving failed: ${errMsg(e)}`, true)
    return
  }
  trySendJson(peer.inDc, { t: "received", fileId })
  pushProgress(inc, inc.received, true)
  setStatus(inc, "done")
  clearIncoming(peer, inc)
}

function abortIncoming(
  peer: Peer,
  inc: Incoming,
  status: "canceled" | "failed",
  error: string | undefined,
  sendCancelFrame: boolean,
): void {
  if (isTerminal(inc.snap.status)) return
  inc.aborted = true
  if (sendCancelFrame) trySendJson(peer.inDc, { t: "cancel", fileId: inc.snap.id })
  const sink = inc.sink
  inc.sink = null
  if (sink) void sink.abort().catch(() => undefined)
  setStatus(inc, status, error)
  clearIncoming(peer, inc)
}

function clearIncoming(peer: Peer, inc: Incoming): void {
  if (peer.incoming === inc) peer.incoming = null
}

function findIncoming(id: string): [Peer, Incoming] | null {
  for (const peer of peers.values()) {
    if (peer.incoming?.snap.id === id) return [peer, peer.incoming]
  }
  return null
}

// ---------------------------------------------------------------------------
// Pull mode (PLAN.md §10.2, §14.2)

/**
 * Sharer side: a peer asked for one of our offers. Resolve the bytes through
 * the persistence ladder and serve them via the NORMAL send machinery (the
 * per-channel queue keeps one file in flight; a busy channel just queues the
 * serve). Resolution failures answer `unavailable`:
 *   needs-grant — the persisted handle wants a user-gesture re-grant; also
 *                 surface a local prompt so the user can re-authorize.
 *   gone        — the bytes can never be produced again; the puller reports
 *                 the offer stale.
 */
async function handlePull(peer: Peer, sharedFileId: string): Promise<void> {
  let source: SendSource
  try {
    source = await resolveShare(sharedFileId)
  } catch (e) {
    if (e instanceof NeedsGrantError) {
      trySendJson(peer.inDc, { t: "unavailable", sharedFileId, reason: "needs-grant" })
      emit({ type: "share-needs-grant", sharedFileId, name: e.shareName })
    } else {
      // GoneError — or any unexpected resolver failure; either way the bytes
      // aren't coming, which the wire expresses as "gone".
      trySendJson(peer.inDc, { t: "unavailable", sharedFileId, reason: "gone" })
    }
    return
  }
  if (peer.closed) return // torn down while resolving
  // Completed serves are logged to /api/v1/transfers like any send — the
  // transfers store logs every terminal direction:"send" snapshot.
  sendFromSource(peer.id, source, sharedFileId)
}

/** Puller side: the sharer can't produce the bytes for our pending pull. */
function handleUnavailable(peer: Peer, msg: Record<string, unknown>): void {
  const sharedFileId = typeof msg.sharedFileId === "string" ? msg.sharedFileId : null
  if (!sharedFileId) return
  const pull = peer.pulls.get(sharedFileId)
  if (!pull) return
  clearTimeout(pull.timer)
  peer.pulls.delete(sharedFileId)
  const reason = msg.reason === "needs-grant" ? "needs-grant" : "gone"
  // stores/shares.ts POSTs /shared-files/{id}/stale for "gone" — even if the
  // local row was already canceled, everyone benefits from the offer greying.
  emit({ type: "pull-unavailable", sharedFileId, reason })
  setStatus(
    pull,
    "failed",
    reason === "gone"
      ? "no longer available on the sharing device"
      : "the sharing device needs to re-authorize this file — ask it, then retry",
  )
}

// ---------------------------------------------------------------------------
// Status + progress plumbing

function setStatus(
  rec: { snap: TransferSnapshot },
  status: TransferStatus,
  error?: string,
): void {
  const snap = rec.snap
  if (isTerminal(snap.status)) return // terminal states are final
  snap.status = status
  if (error !== undefined) snap.error = error
  if (status === "done") snap.bytes = snap.size
  emitUpsert(snap)
}

/** Throttled: ≥100 ms apart or ≥1 % delta (PLAN.md §5); rate EMA ≤2×/s. */
function pushProgress(rec: ProgressTrack & { snap: TransferSnapshot }, bytes: number, force = false): void {
  const snap = rec.snap
  if (!force && snap.status !== "transferring") return
  const now = Date.now()
  if (!force && now - rec.lastEmitT < 100 && bytes - rec.lastEmitBytes < snap.size / 100) return
  if (rec.lastRateT === 0) {
    rec.lastRateT = now
    rec.lastRateBytes = bytes
  } else if (now - rec.lastRateT >= 500) {
    const inst = ((bytes - rec.lastRateBytes) * 1000) / (now - rec.lastRateT)
    snap.rate = snap.rate > 0 ? 0.3 * inst + 0.7 * snap.rate : inst
    rec.lastRateT = now
    rec.lastRateBytes = bytes
  }
  rec.lastEmitT = now
  rec.lastEmitBytes = bytes
  snap.bytes = bytes
  emit({ type: "progress", id: snap.id, bytes, rate: snap.rate })
}

// ---------------------------------------------------------------------------
// Network-path badge (PLAN.md §10.5)

async function refreshNetworkPath(peer: Peer): Promise<void> {
  if (peer.closed) return
  let report: RTCStatsReport
  try {
    report = await peer.pc.getStats()
  } catch {
    return
  }
  // RTCStatsReport only exposes forEach in lib.dom — index it locally.
  const byId = new Map<string, Record<string, unknown>>()
  report.forEach((value: Record<string, unknown>, key: string) => byId.set(key, value))

  let pair: Record<string, unknown> | undefined
  for (const stat of byId.values()) {
    if (stat.type === "transport" && typeof stat.selectedCandidatePairId === "string") {
      pair = byId.get(stat.selectedCandidatePairId)
      if (pair) break
    }
  }
  if (!pair) {
    for (const stat of byId.values()) {
      if (stat.type === "candidate-pair" && (stat.selected === true || stat.state === "succeeded")) {
        pair = stat
        break
      }
    }
  }
  if (!pair) return
  const local = byId.get(pair.localCandidateId as string)
  const remote = byId.get(pair.remoteCandidateId as string)
  const lt = local?.candidateType
  const rt = remote?.candidateType
  if (typeof lt !== "string" || typeof rt !== "string") return
  const path: NetworkPath =
    lt === "relay" || rt === "relay" ? "relay" : lt === "host" && rt === "host" ? "lan" : "internet"
  if (peer.networkPath === path) return
  peer.networkPath = path
  if (peer.active && !isTerminal(peer.active.snap.status)) {
    peer.active.snap.networkPath = path
    emitUpsert(peer.active.snap)
  }
  if (peer.incoming && !isTerminal(peer.incoming.snap.status)) {
    peer.incoming.snap.networkPath = path
    emitUpsert(peer.incoming.snap)
  }
}

// ---------------------------------------------------------------------------
// Wake lock (PLAN.md §10.4): held while ≥1 transfer is active

let wakeSentinel: WakeLockSentinel | null = null
let wakeWanted = false
let wakeAcquiring = false

function anyTransferActive(): boolean {
  for (const p of peers.values()) {
    if (p.queue.some((t) => !isTerminal(t.snap.status))) return true
    if (p.active && !isTerminal(p.active.snap.status)) return true
    if (p.incoming && !isTerminal(p.incoming.snap.status)) return true
    for (const pull of p.pulls.values()) {
      if (!isTerminal(pull.snap.status)) return true
    }
  }
  return false
}

function updateWakeLock(): void {
  wakeWanted = anyTransferActive()
  if (wakeWanted) {
    void acquireWakeLock()
  } else if (wakeSentinel) {
    const s = wakeSentinel
    wakeSentinel = null
    void s.release().catch(() => undefined)
  }
}

async function acquireWakeLock(): Promise<void> {
  if (wakeSentinel || wakeAcquiring) return
  // Guarded: insecure LAN-IP origins have no wakeLock at all.
  const wakeLock = (navigator as Navigator & { wakeLock?: WakeLock }).wakeLock
  if (!wakeLock || document.visibilityState !== "visible") return
  wakeAcquiring = true
  try {
    const sentinel = await wakeLock.request("screen")
    if (!wakeWanted) {
      void sentinel.release().catch(() => undefined)
      return
    }
    wakeSentinel = sentinel
    sentinel.addEventListener("release", () => {
      if (wakeSentinel === sentinel) wakeSentinel = null
    })
  } catch {
    // denied/unsupported — transfers still work, the screen may just sleep
  } finally {
    wakeAcquiring = false
  }
}

// ---------------------------------------------------------------------------
// Signaling (WS relay, PLAN.md §9) — incoming side

async function handleOffer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
  let peer = peers.get(from)
  if (peer && peer.pc.signalingState === "have-local-offer") {
    // Glare: both sides offered at once. Smaller deviceId wins (see header).
    if (myId() < from) return // we win — they'll roll back and answer ours
    try {
      await peer.pc.setLocalDescription({ type: "rollback" })
    } catch (e) {
      teardownPeer(from, `negotiation failed: ${errMsg(e)}`)
      peer = undefined
    }
  }
  peer ??= getPeer(from)
  try {
    await peer.pc.setRemoteDescription(sdp)
    await flushPendingIce(peer)
    const answer = await peer.pc.createAnswer()
    if (peer.closed) return
    await peer.pc.setLocalDescription(answer)
    if (peer.closed) return
    sendSignal("rtc-answer", from, { sdp: { type: answer.type, sdp: answer.sdp } })
  } catch (e) {
    teardownPeer(from, `negotiation failed: ${errMsg(e)}`)
  }
}

async function handleAnswer(from: string, sdp: RTCSessionDescriptionInit): Promise<void> {
  const peer = peers.get(from)
  if (!peer || peer.pc.signalingState !== "have-local-offer") return // stale/glare leftover
  try {
    await peer.pc.setRemoteDescription(sdp)
    await flushPendingIce(peer)
  } catch (e) {
    teardownPeer(from, `negotiation failed: ${errMsg(e)}`)
  }
}

async function handleIce(from: string, candidate: RTCIceCandidateInit): Promise<void> {
  const peer = peers.get(from)
  if (!peer || peer.closed) return // stray candidate for a connection we dropped
  if (!peer.pc.remoteDescription) {
    peer.pendingIce.push(candidate) // buffer until the remote description lands
    return
  }
  try {
    await peer.pc.addIceCandidate(candidate)
  } catch {
    // stale candidate from a rolled-back glare offer — safe to ignore
  }
}

async function flushPendingIce(peer: Peer): Promise<void> {
  const queued = peer.pendingIce.splice(0)
  for (const candidate of queued) {
    try {
      await peer.pc.addIceCandidate(candidate)
    } catch {
      // stale glare candidate — ignore
    }
  }
}

function asSdp(value: unknown): RTCSessionDescriptionInit | null {
  if (typeof value !== "object" || value === null) return null
  const v = value as { type?: unknown; sdp?: unknown }
  if (v.type !== "offer" && v.type !== "answer") return null
  return { type: v.type, sdp: typeof v.sdp === "string" ? v.sdp : "" }
}

// ---------------------------------------------------------------------------
// Init — idempotent (StrictMode-safe), wires the WS bus exactly once

let initialized = false

export function initTransferEngine(): void {
  if (initialized) return
  initialized = true

  onWs("rtc-offer", (msg) => {
    const sdp = asSdp(msg.sdp)
    if (typeof msg.from === "string" && sdp?.type === "offer") void handleOffer(msg.from, sdp)
  })
  onWs("rtc-answer", (msg) => {
    const sdp = asSdp(msg.sdp)
    if (typeof msg.from === "string" && sdp?.type === "answer") void handleAnswer(msg.from, sdp)
  })
  onWs("rtc-ice", (msg) => {
    if (typeof msg.from === "string" && typeof msg.candidate === "object" && msg.candidate) {
      void handleIce(msg.from, msg.candidate as RTCIceCandidateInit)
    }
  })

  // Presence is the teardown trigger (PLAN.md §10.1): connections die with
  // their device, transfers fail instead of hanging in "transferring".
  onWs("peer-offline", (msg) => {
    if (typeof msg.deviceId === "string") teardownPeer(msg.deviceId, "device went offline")
  })

  // Relay errors for our signaling (target_offline / unauthorized_target):
  // the server's msg embeds the target id — fail that peer's transfers.
  onWs("error", (msg) => {
    if (msg.code !== "target_offline" && msg.code !== "unauthorized_target") return
    const reason =
      msg.code === "target_offline" ? "device is offline" : "not allowed to send to that device"
    const text = typeof msg.msg === "string" ? msg.msg : ""
    const match = /^device (.+) is (?:offline|not yours)$/.exec(text)
    if (match) {
      teardownPeer(match[1], reason)
    } else {
      // Unparseable — fail whatever is still handshaking.
      for (const peer of [...peers.values()]) {
        if (peer.pc.connectionState !== "connected") teardownPeer(peer.id, reason)
      }
    }
  })

  // Re-acquire the wake lock when the tab becomes visible again mid-transfer
  // (the browser auto-releases it on hide).
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wakeWanted && !wakeSentinel) {
      void acquireWakeLock()
    }
  })
}
