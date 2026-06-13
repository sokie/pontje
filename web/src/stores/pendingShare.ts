import { create } from "zustand"

import { takeShareStash } from "@/lib/shareStash"
import { useUi } from "@/stores/ui"

// Files staged from an Android share-target POST that carried attachments
// (PLAN.md §22 Phase 7). The SW redirects file shares to /?share=files; the
// boot consumer below lifts them out of the IndexedDB stash and parks them
// here for DevicesView to offer up — send to a device, or share for later.

type PendingShareState = {
  files: File[]
  setFiles: (files: File[]) => void
  clear: () => void
}

export const usePendingShare = create<PendingShareState>((set) => ({
  files: [],
  setFiles: (files) => set({ files }),
  clear: () => set({ files: [] }),
}))

/** Consume the staged files (returns and clears) — for callers outside React. */
export function takePendingShareFiles(): File[] {
  const { files, clear } = usePendingShare.getState()
  if (files.length > 0) clear()
  return files
}

/**
 * On boot, if the SW routed a file share here (/?share=files), read the stash
 * and park the attachments for DevicesView. The plain text/URL share path
 * (/?share=1) is left untouched — the Clips paste box consumes that itself, and
 * the distinct `?share=` value means the two consumers never race over the
 * single stash. Safe to call more than once: the stash read is a one-shot take
 * and the flag is scrubbed from the URL afterwards.
 */
export async function consumePendingShare(): Promise<void> {
  if (new URLSearchParams(location.search).get("share") !== "files") return
  let stash = null
  try {
    stash = await takeShareStash()
  } catch {
    // IndexedDB unavailable — nothing to stage; still scrub the flag below.
  }
  history.replaceState(null, "", location.pathname)
  const files = (stash?.files ?? []).filter((f): f is File => f instanceof File)
  if (files.length === 0) return
  usePendingShare.getState().setFiles(files)
  useUi.getState().setTab("devices")
}
