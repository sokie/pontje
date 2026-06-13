/// <reference lib="webworker" />
// Service worker (vite-plugin-pwa injectManifest build, PLAN.md §16).

import { precacheAndRoute } from "workbox-precaching"

import { putShareStash } from "./lib/shareStash"

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null } | string>
}

// Android share-target: intercept POST /share, stash the payload in IndexedDB,
// bounce into the app. Caddy's `redir /share / 303` covers the cold-start case
// where this SW isn't controlling the scope yet (payload lost — documented §16).
self.addEventListener("fetch", (event: FetchEvent) => {
  const url = new URL(event.request.url)
  if (event.request.method !== "POST" || url.pathname !== "/share") return
  event.respondWith(
    (async () => {
      let target = "/?share=1"
      try {
        const form = await event.request.formData()
        const field = (name: string): string | null => {
          const v = form.get(name)
          return typeof v === "string" && v ? v : null
        }
        // The OS share sheet attaches files under the manifest's `files` field.
        const files = form.getAll("files").filter((v): v is File => v instanceof File)
        await putShareStash({
          title: field("title"),
          text: field("text"),
          url: field("url"),
          files,
          at: Date.now(),
        })
        // Route by content: file shares land on Devices (pick a target or
        // share-for-later), plain text/URL stays on the Clips paste box.
        // Encoding the destination in the redirect lets the app route
        // synchronously — no read race between this stash and the paste box's
        // own consumer, since each reads a different `?share=` value.
        if (files.length > 0) target = "/?share=files"
      } catch {
        // Rare payload loss is documented and acceptable (§16) — still open the app.
      }
      return Response.redirect(target, 303)
    })(),
  )
})

// --- Streaming downloads (PLAN.md §10.4, save strategy 2) -------------------
// Self-hosted StreamSaver replacement: the page registers a one-time download
// id (+ a MessagePort) here, then points a hidden iframe at /_download/<id>;
// we answer with a ReadableStream fed by chunks the page posts over the port.
// Flow control is credit-based — every stream pull() grants the page one
// chunk of credit — so download backpressure propagates to the DataChannel.
// Page-side counterpart: src/lib/save.ts (swSink).

type PendingDownload = { name: string; size: number; port: MessagePort }

const pendingDownloads = new Map<string, PendingDownload>()

self.addEventListener("message", (event: ExtendableMessageEvent) => {
  const data = event.data as { type?: unknown; id?: unknown; name?: unknown; size?: unknown } | null
  if (!data || typeof data !== "object") return
  // "pontje-ping" needs no handling: the message event itself resets the
  // worker's idle timer during long transfers.
  if (data.type !== "pontje-download" || typeof data.id !== "string") return
  const port = event.ports[0]
  if (!port) return
  pendingDownloads.set(data.id, {
    name: typeof data.name === "string" && data.name ? data.name : "download",
    size: typeof data.size === "number" && Number.isFinite(data.size) && data.size >= 0 ? data.size : 0,
    port,
  })
  port.postMessage({ type: "ready" })
})

function downloadResponse(dl: PendingDownload): Response {
  const { port } = dl
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        port.onmessage = (ev: MessageEvent) => {
          const m = ev.data as { type?: unknown; buf?: unknown } | null
          if (!m || typeof m !== "object") return
          if (m.type === "chunk" && m.buf instanceof ArrayBuffer) {
            try {
              controller.enqueue(new Uint8Array(m.buf))
            } catch {
              port.close() // stream already canceled/errored
            }
          } else if (m.type === "end") {
            try {
              controller.close()
            } catch {
              // already errored
            }
            port.close()
          } else if (m.type === "abort") {
            try {
              controller.error(new Error("transfer aborted"))
            } catch {
              // already closed
            }
            port.close()
          }
        }
        port.postMessage({ type: "go" })
      },
      pull() {
        port.postMessage({ type: "pull" }) // +1 chunk credit for the page
      },
      cancel() {
        port.postMessage({ type: "cancel" }) // user canceled the browser download
        port.close()
      },
    },
    new CountQueuingStrategy({ highWaterMark: 8 }), // ≈ 512 KiB of 64 KiB chunks
  )
  const asciiName = dl.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_")
  const utf8Name = encodeURIComponent(dl.name).replace(
    /['()]/g,
    (c) => `%${c.charCodeAt(0).toString(16)}`,
  )
  return new Response(stream, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${asciiName}"; filename*=UTF-8''${utf8Name}`,
      "Content-Length": String(dl.size),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  })
}

self.addEventListener("fetch", (event: FetchEvent) => {
  if (event.request.method !== "GET") return
  const url = new URL(event.request.url)
  if (url.origin !== location.origin || !url.pathname.startsWith("/_download/")) return
  const id = url.pathname.slice("/_download/".length)
  const dl = pendingDownloads.get(id)
  if (!dl) {
    // SW restarted, or a stale iframe reload — ids are strictly one-time.
    event.respondWith(new Response("This download has expired.", { status: 404 }))
    return
  }
  pendingDownloads.delete(id)
  event.respondWith(downloadResponse(dl))
})

precacheAndRoute(self.__WB_MANIFEST)

// registerType "autoUpdate" with injectManifest: take over immediately.
void self.skipWaiting()
self.addEventListener("activate", (event: ExtendableEvent) => {
  event.waitUntil(self.clients.claim())
})
