// Cross-user share-session state (PLAN.md §15). NOT auth — that's stores/
// session.ts. Holds {session, members} for THIS device, plus the session's
// shared links/snippets ("items"): the frozen clips store also upserts
// session broadcasts into the personal list, so this store additionally
// tracks every session item id ever seen — views exclude those from the
// personal day groups and render them in the pinned "Session" group instead.

import { create } from "zustand"

import { api } from "@/api/client"
import type { components } from "@/api/schema"
import { parseUtc } from "@/lib/time"
import { onWs } from "@/lib/ws/bus"
import { detectUrl, type Clip, type LinkClip, type PasteSaveResult, type SnippetClip } from "@/stores/clips"
import { useSession } from "@/stores/session"

type SessionStateOut = components["schemas"]["SessionStateOut"]
type LinkOut = components["schemas"]["LinkOut"]
type SnippetOut = components["schemas"]["SnippetOut"]

export type ShareSessionInfo = {
  id: string
  code: string
  ownerId: number
  expiresAt: string
  createdAt: string
}

export type SessionMemberInfo = {
  deviceId: string
  deviceName: string
  userName: string
  userId: number
  online: boolean
  isSelf: boolean
}

// Local mappers — the clips store's are not exported (file is frozen).
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

function upsert(items: Clip[], item: Clip): Clip[] {
  return [...items.filter((c) => c.id !== item.id), item].sort(byNewest)
}

function errDetail(error: unknown, fallback: string): string {
  if (error && typeof error === "object" && "detail" in error) {
    const detail = (error as { detail?: unknown }).detail
    if (typeof detail === "string") return detail
  }
  return fallback
}

const JOIN_ERRORS: Record<number, string> = {
  404: "No session with that code — check it and try again.",
  410: "That session has expired — ask for a fresh code.",
  409: "You're already in a session — leave it first.",
  400: "Register this device first, then join.",
}

type ShareSessionState = {
  session: ShareSessionInfo | null
  members: SessionMemberInfo[]
  /** The session's shared links+snippets, newest first. */
  items: Clip[]
  /** Every session item id ever seen — personal views exclude these. */
  sessionItemIds: string[]
  loaded: boolean
  load: () => Promise<void>
  create: () => Promise<string | null>
  join: (code: string) => Promise<string | null>
  /** Guest: leave the session. Owner: same as end. */
  leave: () => Promise<string | null>
  /** Owner: end the session for everyone. */
  end: () => Promise<string | null>
  /** PasteBox "→ session" path: post a link/snippet into the session scope. */
  addToSession: (text: string, secret: boolean) => Promise<PasteSaveResult>
}

function mapState(data: SessionStateOut): {
  session: ShareSessionInfo | null
  members: SessionMemberInfo[]
} {
  return {
    session: data.session
      ? {
          id: data.session.id,
          code: data.session.code,
          ownerId: data.session.owner_id,
          expiresAt: data.session.expires_at,
          createdAt: data.session.created_at,
        }
      : null,
    members: data.members.map((m) => ({
      deviceId: m.device_id,
      deviceName: m.device_name,
      userName: m.user_name,
      userId: m.user_id,
      online: m.online,
      isSelf: m.is_self,
    })),
  }
}

function applyState(data: SessionStateOut): void {
  const prevId = useShareSession.getState().session?.id ?? null
  const { session, members } = mapState(data)
  useShareSession.setState(
    session
      ? { session, members, loaded: true }
      : { session: null, members: [], items: [], loaded: true },
  )
  armExpiryTimer(session?.expiresAt ?? null)
  if (session && session.id !== prevId) void loadItems(session.id)
}

function clearLocal(): void {
  useShareSession.setState({ session: null, members: [], items: [] })
  armExpiryTimer(null)
}

// Client-side expiry: when the countdown hits zero, drop local state — the
// server already rejects relay/posting for expired sessions.
let expiryTimer: ReturnType<typeof setTimeout> | null = null

function armExpiryTimer(expiresAt: string | null): void {
  if (expiryTimer) {
    clearTimeout(expiryTimer)
    expiryTimer = null
  }
  if (!expiresAt) return
  const ms = parseUtc(expiresAt).getTime() - Date.now()
  if (ms <= 0) {
    clearLocal()
    return
  }
  expiryTimer = setTimeout(clearLocal, ms + 500)
}

function recordSessionItemIds(ids: string[]): void {
  useShareSession.setState((s) => {
    if (ids.every((id) => s.sessionItemIds.includes(id))) return s
    return { sessionItemIds: [...new Set([...s.sessionItemIds, ...ids])] }
  })
}

async function loadItems(sessionId: string): Promise<void> {
  const [links, snippets] = await Promise.all([
    api.GET("/api/v1/links", { params: { query: { session: sessionId } } }),
    api.GET("/api/v1/snippets", { params: { query: { session: sessionId } } }),
  ])
  if (useShareSession.getState().session?.id !== sessionId) return // raced an end
  const items: Clip[] = [
    ...(links.data ?? []).map(fromLink),
    ...(snippets.data ?? []).map(fromSnippet),
  ].sort(byNewest)
  recordSessionItemIds(items.map((i) => i.id))
  useShareSession.setState({ items })
}

export const useShareSession = create<ShareSessionState>((set, get) => ({
  session: null,
  members: [],
  items: [],
  sessionItemIds: [],
  loaded: false,

  load: async () => {
    const { data } = await api.GET("/api/v1/sessions/current").catch(() => ({ data: undefined }))
    if (data) applyState(data)
    else set({ loaded: true })
  },

  create: async () => {
    // Narrow on !data only: combining `error || !data` collapses the
    // destructured openapi-fetch union and types `response` as never.
    const { data, error, response } = await api.POST("/api/v1/sessions")
    if (!data) {
      if (response.status === 409) return "You're already in a session — leave it first."
      if (response.status === 400) return "Register this device first, then start a session."
      return errDetail(error, "Could not start a session.")
    }
    applyState(data)
    return null
  },

  join: async (code: string) => {
    const cleaned = code.trim().toUpperCase()
    if (cleaned.length !== 6) return "Codes are 6 characters."
    const { data, error, response } = await api.POST("/api/v1/sessions/join", {
      body: { code: cleaned },
    })
    if (!data) {
      return JOIN_ERRORS[response.status] ?? errDetail(error, "Could not join the session.")
    }
    applyState(data)
    return null
  },

  leave: async () => {
    const session = get().session
    if (!session) return null
    const { response } = await api.POST("/api/v1/sessions/{session_id}/leave", {
      params: { path: { session_id: session.id } },
    })
    // 404 = already gone server-side — clearing locally is correct either way.
    if (!response.ok && response.status !== 404) return "Could not leave the session."
    clearLocal()
    return null
  },

  end: async () => {
    const session = get().session
    if (!session) return null
    const { response } = await api.DELETE("/api/v1/sessions/{session_id}", {
      params: { path: { session_id: session.id } },
    })
    if (!response.ok && response.status !== 404) return "Could not end the session."
    clearLocal()
    return null
  },

  addToSession: async (text: string, secret: boolean) => {
    const session = get().session
    if (!session) return { error: "No active session" }
    const trimmed = text.trim()
    if (!trimmed) return { error: "Nothing to beam" }
    // Secret toggle wins over URL detection — same rule as the personal path.
    const url = secret ? null : detectUrl(trimmed)
    if (url) {
      const { data, error } = await api.POST("/api/v1/links", {
        body: { url, session_id: session.id },
      })
      if (error || !data) return { error: "Could not share the link with the session" }
      recordSessionItemIds([data.id])
      set((s) => ({ items: upsert(s.items, fromLink(data)) }))
      return { saved: "link" }
    }
    const { data, error } = await api.POST("/api/v1/snippets", {
      body: { content: trimmed, kind: secret ? "secret" : "text", session_id: session.id },
    })
    if (error || !data) return { error: "Could not share the snippet with the session" }
    recordSessionItemIds([data.id])
    set((s) => ({ items: upsert(s.items, fromSnippet(data)) }))
    return { saved: secret ? "secret" : "text" }
  },
}))

/** True when `deviceId` belongs to ANOTHER user in the active session — the
 * transfers prompt rule (PLAN.md §10.2: session guests always get a prompt). */
export function isGuestDevice(id: string): boolean {
  const { session, members } = useShareSession.getState()
  if (!session) return false
  const myUserId =
    useSession.getState().me?.user.id ?? members.find((m) => m.isSelf)?.userId ?? null
  return members.some((m) => m.deviceId === id && m.userId !== myUserId)
}

/** Member lookup for labelling rows/prompts ("Bob · Pixel 8"). */
export function sessionMemberLabel(id: string | null): string | null {
  if (!id) return null
  const m = useShareSession.getState().members.find((mm) => mm.deviceId === id)
  return m ? `${m.userName} · ${m.deviceName}` : null
}

// ---- Module-scope WS subscriptions (engine outside the React tree, PLAN.md §5).

onWs("session-state", (msg) => {
  applyState({
    session: (msg.session as SessionStateOut["session"]) ?? null,
    members: (msg.members as SessionStateOut["members"]) ?? [],
  })
})

function onSessionLink(raw: unknown): void {
  const link = raw as LinkOut | undefined
  if (!link?.id || !link.session_id) return // personal item — clips store owns it
  recordSessionItemIds([link.id])
  if (useShareSession.getState().session?.id !== link.session_id) return
  useShareSession.setState((s) => ({ items: upsert(s.items, fromLink(link)) }))
}

onWs("link-new", (msg) => onSessionLink(msg.link))
onWs("link-updated", (msg) => onSessionLink(msg.link))

onWs("snippet-new", (msg) => {
  const snippet = msg.snippet as SnippetOut | undefined
  if (!snippet?.id || !snippet.session_id) return
  recordSessionItemIds([snippet.id])
  if (useShareSession.getState().session?.id !== snippet.session_id) return
  useShareSession.setState((s) => ({ items: upsert(s.items, fromSnippet(snippet)) }))
})

function dropItem(id: unknown): void {
  if (typeof id !== "string") return
  useShareSession.setState((s) =>
    s.items.some((c) => c.id === id) ? { items: s.items.filter((c) => c.id !== id) } : s,
  )
}

onWs("link-deleted", (msg) => dropItem(msg.id))
onWs("snippet-deleted", (msg) => dropItem(msg.id))
