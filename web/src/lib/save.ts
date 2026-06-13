// Saving received bytes to disk, large-file safe (PLAN.md §10.4).
// Framework-free; the strategy ladder is encapsulated behind openSink():
//
//   1. fs-api     showSaveFilePicker → FileSystemWritableFileStream. True
//                 streaming, any size — but the picker needs a user gesture,
//                 so it's only tried when the user just clicked Accept.
//   2. sw-stream  Our own service worker streams a download response fed by
//                 the page over a MessagePort (no StreamSaver, no third-party
//                 iframe). Works without a gesture; any size.
//   3. blob       In-memory assembly, hard-capped at BLOB_CAP — last resort.
//
// The engine asks canAutoSave() BEFORE auto-accepting: if only the blob
// strategy is available and the file exceeds the cap, the transfer falls back
// to the manual prompt (whose Accept click provides the gesture for #1).

export type SinkKind = "fs-api" | "sw-stream" | "blob"

export type Sink = {
  kind: SinkKind
  write(buf: ArrayBuffer): Promise<void>
  close(): Promise<void>
  abort(): Promise<void>
}

export type SinkMeta = { name: string; size: number; mime: string }

/** The user dismissed the save-file picker — treat as a rejection, not an error. */
export class SaveCanceledError extends Error {
  constructor() {
    super("save canceled")
    this.name = "SaveCanceledError"
  }
}

export const BLOB_CAP = 200 * 1024 * 1024 // 200 MiB

// File System Access API (Chromium-only) — not in TS's lib.dom yet.
type SaveFilePickerOptions = {
  suggestedName?: string
  types?: Array<{ description?: string; accept: Record<string, string[]> }>
}
declare global {
  interface Window {
    showSaveFilePicker?: (options?: SaveFilePickerOptions) => Promise<FileSystemFileHandle>
  }
}

export function swStreamAvailable(): boolean {
  return "serviceWorker" in navigator && navigator.serviceWorker.controller != null
}

/** Can we save this WITHOUT a user gesture (auto-accept)? */
export function canAutoSave(size: number): boolean {
  return swStreamAvailable() || size <= BLOB_CAP
}

export async function openSink(
  meta: SinkMeta,
  opts: { gestureAvailable: boolean },
): Promise<Sink> {
  if (opts.gestureAvailable && typeof window.showSaveFilePicker === "function") {
    try {
      return await fsSink(meta)
    } catch (e) {
      // User closed the picker → bubble up as an explicit cancel.
      if (e instanceof DOMException && e.name === "AbortError") throw new SaveCanceledError()
      // Gesture already consumed / permission denied → try the next strategy.
    }
  }
  if (swStreamAvailable()) {
    try {
      return await swSink(meta)
    } catch {
      // SW didn't answer the handshake — fall through.
    }
  }
  if (meta.size <= BLOB_CAP) return blobSink(meta)
  throw new Error("file too large to save in this browser (no streaming support)")
}

// ---- Strategy 1: File System Access API --------------------------------

async function fsSink(meta: SinkMeta): Promise<Sink> {
  const options: SaveFilePickerOptions = { suggestedName: meta.name }
  const ext = fileExtension(meta.name)
  if (ext) {
    // Give the picker an explicit accept type for the suggested name's
    // extension. Without it, Windows Chrome rejects extensions it doesn't
    // natively know (e.g. .heic) with an AbortError we'd misread as a user
    // cancel — so the transfer fails instead of saving. The MIME only has to be
    // a syntactically valid type; it needn't be registered on the OS.
    options.types = [{ accept: { [meta.mime || "application/octet-stream"]: [ext] } }]
  }
  const handle = await window.showSaveFilePicker!(options)
  const writable = await handle.createWritable()
  return {
    kind: "fs-api",
    write: (buf) => writable.write(buf),
    close: () => writable.close(),
    abort: async () => {
      try {
        await writable.abort()
      } catch {
        // already closed/errored
      }
    },
  }
}

// ---- Strategy 2: service-worker streaming download ----------------------
// Handshake (page ↔ SW, see src/sw.ts):
//   page  → SW    postMessage {type:"pontje-download", id, name, size} + port
//   SW    → page  {type:"ready"} — id registered
//   page          points a hidden iframe at /_download/<id>
//   SW    → page  {type:"go"} — fetch arrived, stream started
//   SW    → page  {type:"pull"} per stream pull → +1 chunk credit
//   page  → SW    {type:"chunk", buf} (transferred) / {type:"end"} / {type:"abort"}
//   SW    → page  {type:"cancel"} — the user canceled the browser download
// Credit-based flow control: the page only sends when it holds credit, so
// backpressure propagates from the disk all the way to the DataChannel.

const SW_INITIAL_CREDIT = 4

async function swSink(meta: SinkMeta): Promise<Sink> {
  const ctrl = navigator.serviceWorker.controller
  if (!ctrl) throw new Error("no controlling service worker")

  const id = randomToken()
  const channel = new MessageChannel()
  const port = channel.port1

  let credit = 0
  let failure: Error | null = null
  let wakeWaiter: (() => void) | null = null
  const wake = () => {
    wakeWaiter?.()
    wakeWaiter = null
  }

  let readyResolve!: () => void
  let goResolve!: () => void
  const ready = new Promise<void>((r) => (readyResolve = r))
  const go = new Promise<void>((r) => (goResolve = r))

  port.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { type?: unknown } | null
    switch (m?.type) {
      case "ready":
        readyResolve()
        break
      case "go":
        credit += SW_INITIAL_CREDIT
        goResolve()
        wake()
        break
      case "pull":
        credit += 1
        wake()
        break
      case "cancel":
        failure = new Error("download canceled in the browser")
        wake()
        break
    }
  }

  ctrl.postMessage(
    { type: "pontje-download", id, name: meta.name, size: meta.size, mime: meta.mime },
    [channel.port2],
  )
  await withTimeout(ready, 3000, "service worker did not acknowledge the download")

  const iframe = document.createElement("iframe")
  iframe.hidden = true
  iframe.src = `/_download/${id}`
  document.body.appendChild(iframe)

  try {
    await withTimeout(go, 8000, "download stream did not start")
  } catch (e) {
    iframe.remove()
    port.close()
    throw e
  }

  // Keep the SW alive during long transfers: real message events reset its
  // idle timer (MessagePort traffic alone doesn't, in Chromium).
  const ping = setInterval(() => {
    navigator.serviceWorker.controller?.postMessage({ type: "pontje-ping" })
  }, 10_000)

  let finished = false
  const cleanup = (delayMs: number) => {
    if (finished) return
    finished = true
    clearInterval(ping)
    setTimeout(() => {
      iframe.remove()
      port.close()
    }, delayMs)
  }

  return {
    kind: "sw-stream",
    async write(buf) {
      if (failure) throw failure
      while (credit <= 0) {
        await new Promise<void>((r) => (wakeWaiter = r))
        if (failure) throw failure
      }
      credit -= 1
      port.postMessage({ type: "chunk", buf }, [buf])
    },
    async close() {
      if (failure) throw failure
      port.postMessage({ type: "end" })
      cleanup(5000) // give the browser a beat to finalize the download
    },
    async abort() {
      failure ??= new Error("aborted")
      wake() // unblock a writer waiting for credit
      port.postMessage({ type: "abort" })
      cleanup(0)
    },
  }
}

// ---- Strategy 3: in-memory blob (capped) --------------------------------

function blobSink(meta: SinkMeta): Sink {
  const parts: ArrayBuffer[] = []
  let aborted = false
  return {
    kind: "blob",
    write(buf) {
      if (!aborted) parts.push(buf)
      return Promise.resolve()
    },
    close() {
      if (aborted) return Promise.resolve()
      const blob = new Blob(parts, { type: meta.mime || "application/octet-stream" })
      parts.length = 0
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = meta.name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
      return Promise.resolve()
    },
    abort() {
      aborted = true
      parts.length = 0
      return Promise.resolve()
    },
  }
}

// ---- helpers -------------------------------------------------------------

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
}

/** Lowercased ".ext" from a filename, or "" when there's no usable extension. */
function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".")
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : ""
}

function withTimeout(p: Promise<void>, ms: number, msg: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(msg)), ms)
    void p.then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}
