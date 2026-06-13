// Tiny typed event bus decoupling the WS socket from feature code.
// Framework-free by design (PLAN.md §5): views subscribe via stores, never here.

export type WsMessage = { t: string } & Record<string, unknown>

type Handler = (msg: WsMessage) => void

const handlers = new Map<string, Set<Handler>>()

export function onWs(type: string, handler: Handler): () => void {
  let set = handlers.get(type)
  if (!set) {
    set = new Set()
    handlers.set(type, set)
  }
  set.add(handler)
  return () => set.delete(handler)
}

export function emitWs(msg: WsMessage): void {
  handlers.get(msg.t)?.forEach((h) => h(msg))
  handlers.get("*")?.forEach((h) => h(msg))
}
