import { create } from "zustand"

import { api } from "@/api/client"
import type { components } from "@/api/schema"
import { deviceId } from "@/lib/device"
import { parseUtc } from "@/lib/time"
import { onWs } from "@/lib/ws/bus"

type LinkOut = components["schemas"]["LinkOut"]
type SnippetOut = components["schemas"]["SnippetOut"]

export type LinkClip = {
  type: "link"
  id: string
  url: string
  title: string | null
  category: string
  summary: string | null // LLM one-liner — null unless the AI feature is on
  fromDevice: string | null
  createdAt: string
}

export type SnippetClip = {
  type: "snippet"
  id: string
  kind: "text" | "secret"
  content: string | null // always null for secrets
  fromDevice: string | null
  createdAt: string
}

export type Clip = LinkClip | SnippetClip

export type RevealResult = { kind: "ok"; content: string } | { kind: "gone" }

/** What the paste box created — drives the cross-tab "Saved to …" feedback. */
export type PasteSaveResult = { saved: "link" | "text" | "secret" } | { error: string }

function fromLink(l: LinkOut): LinkClip {
  return {
    type: "link",
    id: l.id,
    url: l.url,
    title: l.title ?? null,
    category: l.category,
    summary: l.summary ?? null,
    fromDevice: l.from_device ?? null,
    createdAt: l.created_at,
  }
}

function fromSnippet(s: SnippetOut): SnippetClip {
  return {
    type: "snippet",
    id: s.id,
    kind: s.kind === "secret" ? "secret" : "text",
    content: s.content ?? null,
    fromDevice: s.from_device ?? null,
    createdAt: s.created_at,
  }
}

const byNewest = (a: Clip, b: Clip) =>
  parseUtc(b.createdAt).getTime() - parseUtc(a.createdAt).getTime()

/** Single token that looks like a URL → normalized URL, else null. */
export function detectUrl(text: string): string | null {
  const trimmed = text.trim()
  if (!trimmed || /\s/.test(trimmed)) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^www\./i.test(trimmed)) return `https://${trimmed}`
  return null
}

type ClipsState = {
  clips: Clip[]
  loaded: boolean
  /** Set briefly when a secret was revealed on ANOTHER device. */
  revealNotice: { deviceId: string } | null
  load: () => Promise<void>
  addFromPasteBox: (text: string, secret: boolean) => Promise<PasteSaveResult>
  deleteClip: (clip: Clip) => Promise<void>
  revealSecret: (id: string) => Promise<RevealResult>
}

function upsert(clips: Clip[], clip: Clip): Clip[] {
  return [...clips.filter((c) => c.id !== clip.id), clip].sort(byNewest)
}

function remove(clips: Clip[], id: string): Clip[] {
  return clips.filter((c) => c.id !== id)
}

export const useClips = create<ClipsState>((set) => ({
  clips: [],
  loaded: false,
  revealNotice: null,

  load: async () => {
    const [links, snippets] = await Promise.all([
      api.GET("/api/v1/links"),
      api.GET("/api/v1/snippets"),
    ])
    const merged: Clip[] = [
      ...(links.data ?? []).map(fromLink),
      ...(snippets.data ?? []).map(fromSnippet),
    ].sort(byNewest)
    set({ clips: merged, loaded: true })
  },

  addFromPasteBox: async (text: string, secret: boolean) => {
    const trimmed = text.trim()
    if (!trimmed) return { error: "Nothing to beam" }
    // The secret toggle wins over URL detection — a secret must never be
    // stored (or broadcast) as a plain link.
    const url = secret ? null : detectUrl(trimmed)
    if (url) {
      const { data, error } = await api.POST("/api/v1/links", { body: { url } })
      if (error || !data) return { error: "Could not save the link" }
      set((s) => ({ clips: upsert(s.clips, fromLink(data)) }))
      return { saved: "link" }
    }
    const { data, error } = await api.POST("/api/v1/snippets", {
      body: { content: trimmed, kind: secret ? "secret" : "text" },
    })
    if (error || !data) return { error: "Could not save the snippet" }
    set((s) => ({ clips: upsert(s.clips, fromSnippet(data)) }))
    return { saved: secret ? "secret" : "text" }
  },

  deleteClip: async (clip: Clip) => {
    const { response } =
      clip.type === "link"
        ? await api.DELETE("/api/v1/links/{link_id}", {
            params: { path: { link_id: clip.id } },
          })
        : await api.DELETE("/api/v1/snippets/{snippet_id}", {
            params: { path: { snippet_id: clip.id } },
          })
    // 404 = already gone elsewhere — drop it locally either way.
    if (response.ok || response.status === 404) {
      set((s) => ({ clips: remove(s.clips, clip.id) }))
    }
  },

  revealSecret: async (id: string) => {
    const { data, response } = await api.POST("/api/v1/snippets/{snippet_id}/reveal", {
      params: { path: { snippet_id: id } },
    })
    if (data) {
      // Burned server-side; the WS broadcast removes it everywhere, but don't
      // depend on the socket being up.
      set((s) => ({ clips: remove(s.clips, id) }))
      return { kind: "ok", content: data.content }
    }
    if (response.status === 410) {
      set((s) => ({ clips: remove(s.clips, id) }))
    }
    return { kind: "gone" }
  },
}))

// ---- Module-scope WS subscriptions (engine outside the React tree, PLAN.md §5).

let noticeTimer: ReturnType<typeof setTimeout> | undefined

onWs("link-new", (msg) => {
  useClips.setState((s) => ({ clips: upsert(s.clips, fromLink(msg.link as LinkOut)) }))
})

onWs("link-updated", (msg) => {
  useClips.setState((s) => ({ clips: upsert(s.clips, fromLink(msg.link as LinkOut)) }))
})

onWs("link-deleted", (msg) => {
  useClips.setState((s) => ({ clips: remove(s.clips, msg.id as string) }))
})

onWs("snippet-new", (msg) => {
  useClips.setState((s) => ({ clips: upsert(s.clips, fromSnippet(msg.snippet as SnippetOut)) }))
})

onWs("snippet-deleted", (msg) => {
  const revealedBy = (msg.revealedBy as string | undefined) ?? null
  useClips.setState((s) => ({ clips: remove(s.clips, msg.id as string) }))
  if (revealedBy && revealedBy !== deviceId()) {
    clearTimeout(noticeTimer)
    useClips.setState({ revealNotice: { deviceId: revealedBy } })
    noticeTimer = setTimeout(() => useClips.setState({ revealNotice: null }), 5000)
  }
})
