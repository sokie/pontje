// Minimal, dependency-free toast store (PLAN.md §17: "Toasts for transfer
// events and device-linked"). Toasts surface cross-cutting moments from any
// tab — a device linking, an incoming file landing — that the per-view cards
// would otherwise only show on the Devices tab.

import { create } from "zustand"

export type ToastTone = "default" | "success" | "error"
export type Toast = { id: string; title: string; description?: string; tone: ToastTone }

const TTL_MS = 5000
let seq = 0

type ToastState = {
  toasts: Toast[]
  push: (t: Omit<Toast, "id">) => void
  dismiss: (id: string) => void
}

export const useToasts = create<ToastState>((set) => ({
  toasts: [],
  push: (t) => {
    const id = `toast-${++seq}`
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })), TTL_MS)
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
}))

/** Fire a toast from anywhere — module scope included (engine outside React). */
export function toast(title: string, opts?: { description?: string; tone?: ToastTone }): void {
  useToasts.getState().push({
    title,
    description: opts?.description,
    tone: opts?.tone ?? "default",
  })
}
