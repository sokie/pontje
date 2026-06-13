// The smart paste box, shared by the Links and Clips tabs. It never makes the
// user pick a destination: URLs become links, text becomes snippets, the eye
// toggle makes secrets — and when the result lives in the OTHER tab, a quiet
// "Saved to …" chip with a jump button closes the loop instead of an error.
// With an active cross-user session a third toggle ("→ session") posts into
// the shared session scope instead (PLAN.md §15).

import { useEffect, useRef, useState } from "react"
import { ArrowRight, Check, Eye, EyeOff, Users } from "lucide-react"

import { Button } from "@/components/ui/button"
import { takeShareStash } from "@/lib/shareStash"
import { useClips } from "@/stores/clips"
import { useShareSession } from "@/stores/shareSession"
import { useUi, type TabKey } from "@/stores/ui"

type SavedKind = "link" | "text" | "secret"

const HOME_TAB: Record<SavedKind, TabKey> = { link: "links", text: "clips", secret: "clips" }
const HOME_LABEL: Record<SavedKind, string> = { link: "Links", text: "Clips", secret: "Clips" }

export function PasteBox({
  context,
  consumeShareStash = false,
}: {
  context: "links" | "clips"
  /** Android share-target consumption (PLAN.md §16) — exactly one mount sets this. */
  consumeShareStash?: boolean
}) {
  const [text, setText] = useState("")
  const [secret, setSecret] = useState(false)
  const [toSession, setToSession] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [routed, setRouted] = useState<SavedKind | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const setTab = useUi((s) => s.setTab)
  const sessionActive = useShareSession((s) => s.session !== null)

  // The toggle only exists while a session is active; personal flows stay
  // untouched otherwise.
  useEffect(() => {
    if (!sessionActive) setToSession(false)
  }, [sessionActive])

  useEffect(() => {
    if (!consumeShareStash || !location.search.includes("share=1")) return
    void takeShareStash().then((stash) => {
      if (stash) {
        setText(stash.url ?? stash.text ?? stash.title ?? "")
        textareaRef.current?.focus()
      }
      history.replaceState(null, "", location.pathname)
    })
  }, [consumeShareStash])

  useEffect(() => {
    if (!routed) return
    const timer = setTimeout(() => setRouted(null), 6000)
    return () => clearTimeout(timer)
  }, [routed])

  const submit = async () => {
    if (busy || !text.trim()) return
    setBusy(true)
    setError(null)
    const result =
      toSession && sessionActive
        ? await useShareSession.getState().addToSession(text, secret)
        : await useClips.getState().addFromPasteBox(text, secret)
    setBusy(false)
    if ("error" in result) {
      setError(result.error)
      return
    }
    setText("")
    setSecret(false)
    setRouted(HOME_TAB[result.saved] !== context ? result.saved : null)
  }

  return (
    <div className="sticky top-0 z-10 bg-background pb-1">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
        className={`rounded-xl border p-3 transition-colors ${
          secret ? "border-amber-500/50 bg-amber-500/5" : "bg-card"
        }`}
      >
        <textarea
          ref={textareaRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              void submit()
            }
          }}
          rows={2}
          placeholder={
            secret
              ? "Paste a secret — it burns after one read…"
              : context === "links"
                ? "Paste a URL to beam — it's auto-categorized…"
                : "Paste text to beam — URLs file themselves under Links…"
          }
          className={`w-full resize-none bg-transparent text-sm outline-none placeholder:text-muted-foreground ${
            secret ? "font-mono" : ""
          }`}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1">
            <Button
              type="button"
              variant={secret ? "secondary" : "ghost"}
              size="sm"
              aria-pressed={secret}
              onClick={() => setSecret((v) => !v)}
            >
              {secret ? <EyeOff /> : <Eye />}
              {secret ? "Secret · burns on read" : "Mark as secret"}
            </Button>
            {sessionActive && (
              <Button
                type="button"
                variant={toSession ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={toSession}
                title="Share with the session instead of just your own devices"
                className={toSession ? "text-primary" : ""}
                onClick={() => setToSession((v) => !v)}
              >
                <Users />→ session
              </Button>
            )}
          </div>
          <Button type="submit" size="sm" disabled={busy || !text.trim()}>
            Beam it
          </Button>
        </div>
        {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
      </form>

      {routed && (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs">
          <span className="inline-flex items-center gap-1.5">
            <Check className="size-3.5 text-emerald-500" />
            Saved to {HOME_LABEL[routed]}
          </span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs"
            onClick={() => setTab(HOME_TAB[routed])}
          >
            View <ArrowRight className="size-3" />
          </Button>
        </div>
      )}
    </div>
  )
}
