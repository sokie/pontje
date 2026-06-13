// Toast host: a centered top stack, mounted once in MainScreen. Tone drives the
// accent + icon; each toast auto-dismisses (store TTL) or on the ✕.

import { AlertTriangle, Check, Info, X } from "lucide-react"

import { useToasts, type ToastTone } from "@/stores/toast"

const TONE: Record<ToastTone, { icon: typeof Info; cls: string }> = {
  default: { icon: Info, cls: "text-primary" },
  success: { icon: Check, cls: "text-emerald-500" },
  error: { icon: AlertTriangle, cls: "text-destructive" },
}

export function Toaster() {
  const toasts = useToasts((s) => s.toasts)
  const dismiss = useToasts((s) => s.dismiss)

  return (
    <div className="pointer-events-none fixed inset-x-0 top-2 z-[60] mx-auto flex max-w-sm flex-col items-center gap-2 px-4">
      {toasts.map((t) => {
        const { icon: Icon, cls } = TONE[t.tone]
        return (
          <div
            key={t.id}
            role="status"
            className="pointer-events-auto flex w-full items-start gap-2.5 rounded-xl border bg-card/95 px-3.5 py-2.5 shadow-lg ring-1 ring-black/5 backdrop-blur-sm animate-in fade-in slide-in-from-top-2 duration-300"
          >
            <Icon className={`mt-0.5 size-4 shrink-0 ${cls}`} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm leading-snug font-medium">{t.title}</p>
              {t.description && (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{t.description}</p>
              )}
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              className="-mr-1 shrink-0 rounded-md p-0.5 text-muted-foreground transition-colors hover:text-foreground"
              onClick={() => dismiss(t.id)}
            >
              <X className="size-3.5" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
