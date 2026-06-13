// Sharer-side persistence ladder for shared-file offers (PLAN.md §14.2):
// the sharing BROWSER must be able to produce the bytes when a pull arrives
// later — possibly after a reload. Hand-rolled IndexedDB in the shareStash.ts
// style; framework-free by design (PLAN.md §5).
//
//   tier      what is stored                          survives reload?
//   handle    FileSystemFileHandle (structured clone) ✅ zero-copy, any size;
//             pulls may need a one-click permission re-grant (NeedsGrantError)
//   opfs      byte copy in the origin private FS      ✅ ≤ 200 MiB, no prompts
//   idb       byte copy as an IndexedDB blob record   ✅ ≤ 200 MiB, no prompts
//   memory    the File object, held in a module Map   ❌ — resolution fails
//             permanently after a reload → the offer goes stale

import { CHUNK_SIZE } from "../rtc/fileSource"
import type { SendSource } from "../rtc/types"

export type ShareStrategy = "handle" | "opfs" | "idb" | "memory"
export type ShareDurability = "survives restarts" | "until this tab closes"
export type ShareInput = File | FileSystemFileHandle

/** The handle exists but reading needs a user-gesture requestPermission. */
export class NeedsGrantError extends Error {
  shareName: string
  constructor(shareName: string) {
    super("needs a permission re-grant")
    this.name = "NeedsGrantError"
    this.shareName = shareName
  }
}

/** The bytes can never be produced again (file moved/deleted, reload, …). */
export class GoneError extends Error {
  constructor(msg = "share is no longer available") {
    super(msg)
    this.name = "GoneError"
  }
}

const MAX_COPY_BYTES = 200 * 1024 * 1024 // byte-copy tiers cap (PLAN.md §14.2)
const DB_NAME = "pontje-shares"
const STORE = "shares"
const OPFS_DIR = "shares"

// queryPermission/requestPermission aren't in lib.dom (Chromium-only API).
type HandlePermissions = {
  queryPermission?: (desc: { mode: "read" | "readwrite" }) => Promise<PermissionState>
  requestPermission?: (desc: { mode: "read" | "readwrite" }) => Promise<PermissionState>
}

type ShareRecord = {
  sharedFileId: string
  name: string
  size: number
  mime: string | null
  strategy: ShareStrategy
  handle?: FileSystemFileHandle
  blob?: Blob
  opfsName?: string
}

/** memory tier — lost on reload by definition. */
const memoryShares = new Map<string, File>()

// ---------------------------------------------------------------------------
// IndexedDB plumbing (shareStash.ts style)

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: "sharedFileId" })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"))
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error("indexedDB tx failed"))
    tx.onabort = () => reject(tx.error ?? new Error("indexedDB tx aborted"))
  })
}

function result<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error("indexedDB request failed"))
  })
}

async function putRecord(rec: ShareRecord): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).put(rec)
    await done(tx)
  } finally {
    db.close()
  }
}

async function getRecord(sharedFileId: string): Promise<ShareRecord | null> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, "readonly")
    const value = await result(
      tx.objectStore(STORE).get(sharedFileId) as IDBRequest<ShareRecord | undefined>,
    )
    await done(tx)
    return value ?? null
  } finally {
    db.close()
  }
}

async function deleteRecord(sharedFileId: string): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).delete(sharedFileId)
    await done(tx)
  } finally {
    db.close()
  }
}

async function allRecords(): Promise<ShareRecord[]> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, "readonly")
    const value = await result(tx.objectStore(STORE).getAll() as IDBRequest<ShareRecord[]>)
    await done(tx)
    return value
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// OPFS plumbing — feature-detected; Safari < 17.4 lacks createWritable

async function opfsDir(create: boolean): Promise<FileSystemDirectoryHandle> {
  if (typeof navigator.storage?.getDirectory !== "function") {
    throw new Error("OPFS unavailable")
  }
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(OPFS_DIR, { create })
}

async function opfsWrite(name: string, file: File): Promise<void> {
  const dir = await opfsDir(true)
  const handle = await dir.getFileHandle(name, { create: true })
  if (typeof handle.createWritable !== "function") throw new Error("OPFS not writable")
  const writable = await handle.createWritable()
  try {
    // pipeTo closes the sink on success and aborts it on failure — true
    // streaming, so the copy holds no more than a chunk in memory.
    await file.stream().pipeTo(writable)
  } catch (e) {
    await dir.removeEntry(name).catch(() => undefined)
    throw e
  }
}

async function opfsDelete(name: string): Promise<void> {
  try {
    const dir = await opfsDir(false)
    await dir.removeEntry(name)
  } catch {
    // no OPFS / already gone
  }
}

/** Async iteration isn't in this TS lib's FileSystemDirectoryHandle yet. */
async function opfsNames(): Promise<string[]> {
  try {
    const dir = (await opfsDir(false)) as FileSystemDirectoryHandle & {
      keys?: () => AsyncIterable<string>
    }
    if (typeof dir.keys !== "function") return []
    const names: string[] = []
    for await (const name of dir.keys()) names.push(name)
    return names
  } catch {
    return [] // no OPFS directory yet
  }
}

// ---------------------------------------------------------------------------
// Public API

/**
 * Best-effort durability for the byte-copy tiers — without it the browser may
 * evict IDB/OPFS under storage pressure. Result deliberately ignored
 * (PLAN.md §14.2); insecure LAN-IP origins have no navigator.storage at all.
 */
function requestPersistentStorage(): void {
  try {
    if (typeof navigator.storage?.persist === "function") {
      void navigator.storage.persist().catch(() => undefined)
    }
  } catch {
    // not available — eviction risk accepted
  }
}

requestPersistentStorage() // once at module init

/**
 * Stash the bytes (or a handle to them) under the server-issued offer id,
 * picking the highest tier available: handle → byte copy (≤ 200 MiB) → memory.
 */
export async function persistShare(
  sharedFileId: string,
  input: ShareInput,
): Promise<{ strategy: ShareStrategy; durability: ShareDurability }> {
  let file: File
  if (input instanceof File) {
    file = input
  } else {
    // Top tier: structured-clone the FileSystemFileHandle — zero-copy, any
    // size, survives restarts (pulls re-check permission at resolve time).
    const meta = await input.getFile() // also verifies the handle is readable now
    try {
      await putRecord({
        sharedFileId,
        name: meta.name,
        size: meta.size,
        mime: meta.type || null,
        strategy: "handle",
        handle: input,
      })
      return { strategy: "handle", durability: "survives restarts" }
    } catch {
      file = meta // a browser that can't clone handles falls down the ladder
    }
  }

  const base = {
    sharedFileId,
    name: file.name,
    size: file.size,
    mime: file.type || null,
  }

  if (file.size <= MAX_COPY_BYTES) {
    try {
      await opfsWrite(sharedFileId, file)
      await putRecord({ ...base, strategy: "opfs", opfsName: sharedFileId })
      return { strategy: "opfs", durability: "survives restarts" }
    } catch {
      // no OPFS (or quota) — try a plain IndexedDB blob record
    }
    try {
      // Copy the bytes for real: Chromium stores File objects in IndexedDB as
      // references to the on-disk original, which break if it changes.
      const blob = new Blob([await file.arrayBuffer()], {
        type: file.type || "application/octet-stream",
      })
      await putRecord({ ...base, strategy: "idb", blob })
      return { strategy: "idb", durability: "survives restarts" }
    } catch {
      // quota/unavailable — memory is the last resort
    }
  }

  // Bottom tier: hold the File in memory. Serves pulls until this tab closes;
  // after a reload resolution fails permanently and the offer goes stale.
  memoryShares.set(sharedFileId, file)
  try {
    await putRecord({ ...base, strategy: "memory" })
  } catch {
    // record is only bookkeeping here — the Map alone still serves this session
  }
  return { strategy: "memory", durability: "until this tab closes" }
}

/**
 * Produce a SendSource for a pull. Throws NeedsGrantError when a handle needs
 * a user-gesture re-grant, GoneError when the bytes can't be produced anymore.
 */
export async function resolveShare(sharedFileId: string): Promise<SendSource> {
  let rec: ShareRecord | null = null
  try {
    rec = await getRecord(sharedFileId)
  } catch {
    rec = null
  }
  if (!rec) {
    // No record but a live memory entry (its bookkeeping put failed) still serves.
    const held = memoryShares.get(sharedFileId)
    if (held) return blobSource(held.name, held.type || null, held)
    throw new GoneError("no local record for this share")
  }

  switch (rec.strategy) {
    case "handle": {
      const handle = rec.handle
      if (!handle) throw new GoneError()
      const perms = handle as FileSystemFileHandle & HandlePermissions
      if (typeof perms.queryPermission === "function") {
        const state = await perms.queryPermission({ mode: "read" })
        // "denied" also gets the re-grant prompt: a click-time requestPermission
        // may still re-ask where the permission was merely dismissed.
        if (state !== "granted") throw new NeedsGrantError(rec.name)
      }
      let file: File
      try {
        file = await handle.getFile()
      } catch {
        throw new GoneError("the file was moved or deleted") // NotFoundError etc.
      }
      return blobSource(rec.name, rec.mime, file)
    }
    case "opfs": {
      try {
        const dir = await opfsDir(false)
        const handle = await dir.getFileHandle(rec.opfsName ?? rec.sharedFileId)
        return blobSource(rec.name, rec.mime, await handle.getFile())
      } catch {
        throw new GoneError("the stashed copy is gone")
      }
    }
    case "idb": {
      if (!rec.blob) throw new GoneError("the stashed copy is gone")
      return blobSource(rec.name, rec.mime, rec.blob)
    }
    case "memory": {
      const held = memoryShares.get(sharedFileId)
      if (!held) throw new GoneError("the file was only held in memory and the page reloaded")
      return blobSource(rec.name, rec.mime, held)
    }
  }
}

/** Re-grant read access to a handle-tier share. MUST run from a click handler. */
export async function grantShare(sharedFileId: string): Promise<boolean> {
  let rec: ShareRecord | null = null
  try {
    rec = await getRecord(sharedFileId)
  } catch {
    return false
  }
  const handle = rec?.handle as (FileSystemFileHandle & HandlePermissions) | undefined
  if (!handle || typeof handle.requestPermission !== "function") return false
  try {
    return (await handle.requestPermission({ mode: "read" })) === "granted"
  } catch {
    return false
  }
}

/** Drop everything held for an offer (unshare / stale / expired). */
export async function removeShare(sharedFileId: string): Promise<void> {
  memoryShares.delete(sharedFileId)
  let rec: ShareRecord | null = null
  try {
    rec = await getRecord(sharedFileId)
  } catch {
    rec = null
  }
  if (rec?.opfsName) await opfsDelete(rec.opfsName)
  try {
    await deleteRecord(sharedFileId)
  } catch {
    // already gone / IDB unavailable
  }
}

/**
 * Called once on app load with the server's CURRENT offer ids: deletes
 * records orphaned by the 48 h sweeper (and their OPFS files), plus OPFS
 * leftovers from a crash between the OPFS write and the record put.
 */
export async function gcShares(validIds: string[]): Promise<void> {
  const valid = new Set(validIds)
  let records: ShareRecord[] = []
  try {
    records = await allRecords()
  } catch {
    return // IDB unavailable — nothing persisted, nothing to collect
  }
  const keepOpfs = new Set<string>()
  for (const rec of records) {
    if (valid.has(rec.sharedFileId)) {
      if (rec.opfsName) keepOpfs.add(rec.opfsName)
    } else {
      await removeShare(rec.sharedFileId)
    }
  }
  for (const name of await opfsNames()) {
    if (!keepOpfs.has(name)) await opfsDelete(name)
  }
  for (const id of [...memoryShares.keys()]) {
    if (!valid.has(id)) memoryShares.delete(id)
  }
}

export type LocalShareInfo = {
  strategy: ShareStrategy
  durability: ShareDurability
  /** False for memory-tier records whose File was lost to a reload. */
  servable: boolean
}

/** What this device still holds locally, keyed by offer id (own offers). */
export async function localShareInfo(): Promise<Map<string, LocalShareInfo>> {
  const out = new Map<string, LocalShareInfo>()
  let records: ShareRecord[] = []
  try {
    records = await allRecords()
  } catch {
    records = []
  }
  for (const rec of records) {
    const inMemory = rec.strategy === "memory"
    out.set(rec.sharedFileId, {
      strategy: rec.strategy,
      durability: inMemory ? "until this tab closes" : "survives restarts",
      servable: !inMemory || memoryShares.has(rec.sharedFileId),
    })
  }
  // Record-less memory shares (their bookkeeping put failed) still serve.
  for (const id of memoryShares.keys()) {
    if (!out.has(id)) {
      out.set(id, { strategy: "memory", durability: "until this tab closes", servable: true })
    }
  }
  return out
}

// ---------------------------------------------------------------------------

/** Blob/File → SendSource, re-chunked to ≤ CHUNK_SIZE like fileSource. */
function blobSource(name: string, mime: string | null, blob: Blob): SendSource {
  let offset = 0
  return {
    name,
    size: blob.size,
    mime: mime || blob.type || "application/octet-stream",
    kind: "file",
    next: async () => {
      if (offset >= blob.size) return null
      const end = Math.min(offset + CHUNK_SIZE, blob.size)
      const buf = await blob.slice(offset, end).arrayBuffer()
      offset = end
      return buf
    },
  }
}
