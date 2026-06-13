// File-backed SendSource: 64 KiB chunks read lazily via slice().arrayBuffer()
// — constant memory regardless of file size (PLAN.md §10.2).

import type { SendSource } from "./types"

export const CHUNK_SIZE = 64 * 1024

export function fileSource(file: File): SendSource {
  let offset = 0
  return {
    name: file.name,
    size: file.size,
    mime: file.type || "application/octet-stream",
    kind: "file",
    next: async () => {
      if (offset >= file.size) return null
      const end = Math.min(offset + CHUNK_SIZE, file.size)
      const buf = await file.slice(offset, end).arrayBuffer()
      offset = end
      return buf
    },
  }
}
