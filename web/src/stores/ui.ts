import { create } from "zustand"

// App-level navigation state. Lives in a store (not component state) so views
// can navigate — e.g. the paste box's "Saved to Links → View" jump chip.

export type TabKey = "devices" | "files" | "links" | "clips"
export type FilesSegment = "available" | "history"

type UiState = {
  tab: TabKey
  /** Files tab segment — survives tab switches within the session. */
  filesSegment: FilesSegment
  setTab: (tab: TabKey) => void
  setFilesSegment: (segment: FilesSegment) => void
}

export const useUi = create<UiState>((set) => ({
  // Android share-target routing (PLAN.md §16, §22 Phase 7): a text/URL share
  // (/?share=1) lands on Clips with the paste box prefilled; a file share
  // (/?share=files) falls through to the Devices default, where the staged
  // attachments surface (stores/pendingShare.ts consumes them on boot).
  tab: location.search.includes("share=1") ? "clips" : "devices",
  filesSegment: "available",
  setTab: (tab) => set({ tab }),
  setFilesSegment: (filesSegment) => set({ filesSegment }),
}))
