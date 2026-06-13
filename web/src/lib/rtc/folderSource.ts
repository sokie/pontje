// Folder → streaming-zip SendSource (PLAN.md §11). client-zip works in STORE
// mode (no compression) with Zip64, so predictLength() gives the EXACT archive
// size upfront — the engine's meta → accept → chunks → done protocol and its
// progress % work unchanged. Framework-free by design: no React in lib/rtc.
//
// Each SendSource owns its own zip stream and a zip stream can only be
// consumed ONCE — fan-out (send to all) must therefore build one source per
// target (stores/transfers.ts does).
//
// Known limitation, by design: EMPTY DIRECTORIES are not preserved — the
// webkitdirectory input only yields files, the drag-drop walk skips childless
// directories, and receivers just unzip a plain archive anyway (PLAN.md §11).

import { downloadZip, predictLength } from "client-zip"

import { CHUNK_SIZE } from "./fileSource"
import type { SendSource } from "./types"

/** One file of a picked/dropped folder; path is relative and INCLUDES the
 * folder name ("Folder/sub/file.ext") so the zip unpacks into one directory. */
export type FolderFile = { path: string; file: File }

export type PickedFolder = { name: string; files: FolderFile[] }

export function folderSource(folder: PickedFolder): SendSource {
  // predictLength needs the same names in the same order as the real entries
  // (filename bytes count toward the zip size). bigint → number is exact up
  // to 2^53 bytes (8 PiB) — far past anything a browser will ever stream.
  const size = Number(
    predictLength(folder.files.map(({ path, file }) => ({ name: path, size: file.size }))),
  )

  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  const pending: Uint8Array[] = [] // leftover reader output between pulls
  let buffered = 0
  let streamed = 0
  let eof = false

  return {
    name: `${folder.name}.zip`,
    size,
    mime: "application/zip",
    kind: "folder",
    fileCount: folder.files.length,
    next: async () => {
      // Open the stream lazily on the first pull: fan-out targets queue behind
      // each other per peer, and idle queue entries must not hold open streams.
      if (!reader) {
        const body = downloadZip(
          folder.files.map(({ path, file }) => ({
            name: path,
            lastModified: file.lastModified,
            input: file,
          })),
        ).body
        if (!body) throw new Error("zip stream could not be created")
        reader = body.getReader()
      }
      // Re-chunk the reader's arbitrarily-sized output to ≤CHUNK_SIZE. Reading
      // only happens inside next(), so DataChannel backpressure propagates all
      // the way down to the file reads — memory stays flat at any folder size.
      while (buffered < CHUNK_SIZE && !eof) {
        const result = await reader.read()
        if (result.done) {
          eof = true
        } else if (result.value.byteLength > 0) {
          pending.push(result.value)
          buffered += result.value.byteLength
        }
      }
      if (buffered === 0) {
        if (streamed !== size) {
          // A file changed or vanished since picking — fail the transfer
          // loudly rather than hand the receiver a corrupt zip.
          throw new Error(
            `zip stream produced ${streamed} of the predicted ${size} bytes — did the folder change?`,
          )
        }
        return null
      }
      const take = Math.min(CHUNK_SIZE, buffered)
      const out = new Uint8Array(take)
      let filled = 0
      while (filled < take) {
        const head = pending[0]
        const want = take - filled
        if (head.byteLength <= want) {
          out.set(head, filled)
          filled += head.byteLength
          pending.shift()
        } else {
          out.set(head.subarray(0, want), filled)
          pending[0] = head.subarray(want)
          filled += want
        }
      }
      buffered -= take
      streamed += take
      return out.buffer
    },
  }
}

// ---------------------------------------------------------------------------
// Picking & walking — every entry path funnels into PickedFolder

// File System Access API (Chromium-only) — directory iteration isn't in this
// project's TS libs, so declare the minimal shape (same approach as
// showSaveFilePicker in lib/save.ts).
type FileHandle = { kind: "file"; name: string; getFile(): Promise<File> }
type DirectoryHandle = {
  kind: "directory"
  name: string
  values(): AsyncIterable<FileHandle | DirectoryHandle>
}
declare global {
  interface Window {
    showDirectoryPicker?: (options?: { mode?: "read" | "readwrite" }) => Promise<DirectoryHandle>
  }
}

export function supportsDirectoryPicker(): boolean {
  return typeof window.showDirectoryPicker === "function"
}

/** Chromium folder picker → recursive walk. Resolves null when the user cancels. */
export async function pickFolder(): Promise<PickedFolder | null> {
  if (!window.showDirectoryPicker) return null
  let dir: DirectoryHandle
  try {
    dir = await window.showDirectoryPicker()
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null
    throw e
  }
  const files: FolderFile[] = []
  await walkHandle(dir, `${dir.name}/`, files)
  return { name: dir.name, files }
}

async function walkHandle(dir: DirectoryHandle, prefix: string, out: FolderFile[]): Promise<void> {
  for await (const entry of dir.values()) {
    if (entry.kind === "file") {
      out.push({ path: prefix + entry.name, file: await entry.getFile() })
    } else {
      await walkHandle(entry, `${prefix}${entry.name}/`, out)
    }
  }
}

/**
 * <input webkitdirectory> fallback (Firefox/Safari): every File carries
 * webkitRelativePath ("Folder/sub/file.ext"). A single pick yields a single
 * root in practice, but group by the first path segment defensively.
 */
export function foldersFromFileList(files: File[]): PickedFolder[] {
  const roots = new Map<string, FolderFile[]>()
  for (const file of files) {
    const rel = file.webkitRelativePath || file.name
    const root = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : ""
    let bucket = roots.get(root)
    if (!bucket) {
      bucket = []
      roots.set(root, bucket)
    }
    bucket.push({ path: rel, file })
  }
  return Array.from(roots, ([name, list]) => ({ name: name || "Folder", files: list }))
}

export type DropPayload = { files: File[]; folders: PickedFolder[] }

/**
 * Split a drop into plain files + folders. MUST be called synchronously from
 * the drop handler — webkitGetAsEntry()/getAsFile() return null once the
 * DataTransfer goes stale (after any await). The folder walks then run async
 * on the snapshot. A mixed drop yields both halves.
 */
export function collectDrop(dt: DataTransfer): Promise<DropPayload> {
  const files: File[] = []
  const dirs: FileSystemDirectoryEntry[] = []
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue
    const entry = typeof item.webkitGetAsEntry === "function" ? item.webkitGetAsEntry() : null
    if (entry?.isDirectory) {
      dirs.push(entry as FileSystemDirectoryEntry)
    } else {
      const file = item.getAsFile()
      if (file) files.push(file)
    }
  }
  if (files.length === 0 && dirs.length === 0) files.push(...Array.from(dt.files))
  return (async () => {
    const folders: PickedFolder[] = []
    for (const dir of dirs) {
      const out: FolderFile[] = []
      await walkEntry(dir, "", out)
      folders.push({ name: dir.name, files: out })
    }
    return { files, folders }
  })()
}

/** readEntries hands out ≤100 entries per call in Chromium — drain until empty. */
function readAllEntries(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader()
  return new Promise((resolve, reject) => {
    const acc: FileSystemEntry[] = []
    const step = () =>
      reader.readEntries((batch) => {
        if (batch.length === 0) resolve(acc)
        else {
          acc.push(...batch)
          step()
        }
      }, reject)
    step()
  })
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function walkEntry(entry: FileSystemEntry, prefix: string, out: FolderFile[]): Promise<void> {
  if (entry.isFile) {
    out.push({ path: prefix + entry.name, file: await entryFile(entry as FileSystemFileEntry) })
  } else if (entry.isDirectory) {
    const children = await readAllEntries(entry as FileSystemDirectoryEntry)
    for (const child of children) {
      await walkEntry(child, `${prefix}${entry.name}/`, out)
    }
  }
}
