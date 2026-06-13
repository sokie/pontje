import { useEffect, useState, type ReactNode } from "react"
import { Download, X } from "lucide-react"

import { Button } from "@/components/ui/button"

// PWA "add to home screen" hint (PLAN.md §22 Phase 7). Pure platform/PWA code —
// the transfer engine is untouched. Chromium fires `beforeinstallprompt` before
// React mounts, so we capture it at module scope and fan out to subscribers.

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>
}

let deferredPrompt: BeforeInstallPromptEvent | null = null
const subscribers = new Set<() => void>()

function notify() {
  for (const fn of subscribers) fn()
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault() // suppress the default mini-infobar — we drive the prompt
    deferredPrompt = e as BeforeInstallPromptEvent
    notify()
  })
  window.addEventListener("appinstalled", () => {
    deferredPrompt = null
    notify()
  })
}

const DISMISS_KEY = "pontje-install-hint-dismissed"

function isStandalone(): boolean {
  return (
    window.matchMedia?.("(display-mode: standalone)").matches ||
    // iOS Safari's non-standard installed-app flag.
    (navigator as unknown as { standalone?: boolean }).standalone === true
  )
}

function isIosSafari(): boolean {
  const ua = navigator.userAgent
  const iOS = /iphone|ipad|ipod/i.test(ua)
  // Other iOS browsers are WebKit too but offer no "Add to Home Screen"; only
  // Safari lacks a CriOS/FxiOS/etc. browser tag in the UA.
  const otherBrowser = /crios|fxios|edgios|opios/i.test(ua)
  return iOS && !otherBrowser
}

function Chip({ children, onDismiss }: { children: ReactNode; onDismiss: () => void }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5">
      <div className="flex min-w-0 items-center gap-2">{children}</div>
      <Button size="icon-xs" variant="ghost" aria-label="Dismiss install hint" onClick={onDismiss}>
        <X />
      </Button>
    </div>
  )
}

export function InstallHint() {
  const [, force] = useState(0)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISS_KEY) === "1")

  // Re-render when the captured prompt appears/disappears.
  useEffect(() => {
    const fn = () => force((n) => n + 1)
    subscribers.add(fn)
    return () => {
      subscribers.delete(fn)
    }
  }, [])

  if (dismissed || isStandalone()) return null

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "1")
    setDismissed(true)
  }

  const install = async () => {
    const evt = deferredPrompt
    if (!evt) return
    await evt.prompt() // synchronous within the click gesture, before any await
    deferredPrompt = null // single-use per spec, whatever the user chose
    notify()
  }

  if (deferredPrompt) {
    return (
      <Chip onDismiss={dismiss}>
        <Button size="sm" className="h-7" onClick={() => void install()}>
          <Download /> Install Pontje
        </Button>
      </Chip>
    )
  }
  if (isIosSafari()) {
    return (
      <Chip onDismiss={dismiss}>
        <span className="text-xs text-muted-foreground">
          Install Pontje: tap <span className="font-medium text-foreground">Share</span> →{" "}
          <span className="font-medium text-foreground">Add to Home Screen</span>
        </span>
      </Chip>
    )
  }
  return null
}
