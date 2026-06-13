// Picking files for "Share for later" (PLAN.md §14.2). On Chromium we want
// FileSystemFileHandles (the top persistence tier — zero-copy, survives
// restarts); everywhere else plain Files. Framework-free by design.

import type { ShareInput } from "./persistence"

// File System Access picker (Chromium-only) — not in TS's lib.dom.
type OpenFilePickerOptions = { multiple?: boolean }
declare global {
  interface Window {
    showOpenFilePicker?: (options?: OpenFilePickerOptions) => Promise<FileSystemFileHandle[]>
  }
}

type ItemWithHandle = DataTransferItem & {
  getAsFileSystemHandle?: () => Promise<unknown>
}

export function supportsOpenFilePicker(): boolean {
  return window.isSecureContext && typeof window.showOpenFilePicker === "function"
}

/**
 * Chromium picker → handles (top tier). Resolves null when unsupported or the
 * user cancels — callers fall back to the hidden <input type="file" multiple>.
 */
export async function pickShareInputs(): Promise<ShareInput[] | null> {
  if (!supportsOpenFilePicker() || !window.showOpenFilePicker) return null
  try {
    return await window.showOpenFilePicker({ multiple: true })
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return null
    return null // SecurityError etc. — nothing picked
  }
}

/**
 * Dropped items → handles where the browser hands them out (Chromium), else
 * Files. MUST be called synchronously from the drop handler — both
 * getAsFileSystemHandle() and getAsFile() return null once the DataTransfer
 * goes stale. Directories are skipped: an offer is always a single file.
 */
export function collectShareDrop(dt: DataTransfer): Promise<ShareInput[]> {
  const collected: Promise<ShareInput | null>[] = []
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue
    // Snapshot the File NOW — it stays the fallback if the handle path
    // resolves to null (drags that don't originate from the local filesystem).
    const file = item.getAsFile()
    const withHandle = item as ItemWithHandle
    // isSecureContext guard is load-bearing: Chromium still EXPOSES
    // getAsFileSystemHandle on insecure origins (http://<lan-ip> dev), but
    // CALLING it there kills the tab with RESULT_CODE_KILLED_BAD_MESSAGE
    // (same bug uppy#4133 hit; their fix is this exact check).
    if (window.isSecureContext && typeof withHandle.getAsFileSystemHandle === "function") {
      collected.push(
        withHandle.getAsFileSystemHandle().then(
          (h) => {
            const handle = h as { kind?: string } | null
            if (handle?.kind === "file") return h as FileSystemFileHandle
            if (handle?.kind === "directory") return null // folders can't be offers
            return file
          },
          () => file,
        ),
      )
    } else if (file) {
      collected.push(Promise.resolve(file))
    }
  }
  return Promise.all(collected).then((list) =>
    list.filter((input): input is ShareInput => input !== null),
  )
}

/** Offer metadata for the POST — reads it off the live file behind a handle. */
export async function shareInputMeta(
  input: ShareInput,
): Promise<{ name: string; mime: string | null; size: number } | null> {
  try {
    const file = input instanceof File ? input : await input.getFile()
    return { name: file.name, mime: file.type || null, size: file.size }
  } catch {
    return null // handle unreadable already — don't publish a dud offer
  }
}
