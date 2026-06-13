import { create } from "zustand"

import { api } from "@/api/client"
import type { components } from "@/api/schema"
import { onWs } from "@/lib/ws/bus"

type TransferOut = components["schemas"]["TransferOut"]

/** One transfer-history row (PLAN.md §14.3) — metadata only, bytes never
 * touch the server. category is derived server-side (PLAN.md §14.4). */
export type TransferRecord = {
  id: string
  fileName: string
  mime: string | null
  sizeBytes: number | null
  category: string
  fromDevice: string | null
  toDevice: string | null
  networkPath: string | null
  status: string // completed | failed | rejected | canceled
  createdAt: string
}

function fromOut(t: TransferOut): TransferRecord {
  return {
    id: t.id,
    fileName: t.file_name,
    mime: t.mime ?? null,
    sizeBytes: t.size_bytes ?? null,
    category: t.category,
    fromDevice: t.from_device ?? null,
    toDevice: t.to_device ?? null,
    networkPath: t.network_path ?? null,
    status: t.status,
    createdAt: t.created_at,
  }
}

type FilesState = {
  /** Newest first — the server orders by created_at desc, live rows prepend. */
  records: TransferRecord[]
  loaded: boolean
  load: () => Promise<void>
}

export const useFiles = create<FilesState>((set) => ({
  records: [],
  loaded: false,

  load: async () => {
    const { data } = await api.GET("/api/v1/transfers")
    if (data) set({ records: data.map(fromOut), loaded: true })
  },
}))

// ---- Module-scope WS subscription (engine outside the React tree, PLAN.md
// §5). The sender's own POST response is deliberately ignored — every device,
// the sender included, ingests rows through this one broadcast. Dedupe by id
// covers a broadcast racing a load() refresh.

onWs("transfer-logged", (msg) => {
  const out = msg.transfer as TransferOut | undefined
  if (!out || typeof out.id !== "string") return
  useFiles.setState((s) =>
    s.records.some((r) => r.id === out.id) ? s : { records: [fromOut(out), ...s.records] },
  )
})
