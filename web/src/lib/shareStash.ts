// Hand-rolled IndexedDB stash for the Android share-target payload (PLAN.md §16).
// Written by the service worker on POST /share, read+cleared by the app.
// Framework-free and importable from both contexts.

export type ShareStash = {
  title: string | null
  text: string | null
  url: string | null
  // Shared attachments (PLAN.md §22 Phase 7). IndexedDB structured-clone stores
  // File/Blob natively, so no encoding — empty for plain text/URL shares.
  files: File[]
  at: number
}

const DB_NAME = "pontje-share"
const STORE = "stash"
const KEY = "latest"

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE)
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

export async function putShareStash(stash: ShareStash): Promise<void> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, "readwrite")
    tx.objectStore(STORE).put(stash, KEY)
    await done(tx)
  } finally {
    db.close()
  }
}

/** Read AND clear in one transaction — at most one consumer wins. */
export async function takeShareStash(): Promise<ShareStash | null> {
  const db = await openDb()
  try {
    const tx = db.transaction(STORE, "readwrite")
    const store = tx.objectStore(STORE)
    const value = await result(store.get(KEY) as IDBRequest<ShareStash | undefined>)
    store.delete(KEY)
    await done(tx)
    return value ?? null
  } finally {
    db.close()
  }
}
