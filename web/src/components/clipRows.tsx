// Row components for links, snippets and secrets — shared by LinksView and
// ClipsView (PLAN.md §13, §17).

import { useEffect, useState } from "react"
import { Check, Copy, Eye, Flame, Globe, Trash2, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { copyText } from "@/lib/clipboard"
import { parseUtc } from "@/lib/time"
import type { Clip, LinkClip, RevealResult, SnippetClip } from "@/stores/clips"

const EXPIRY_MS = 48 * 3_600_000

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

function expiresIn(iso: string): string {
  const left = EXPIRY_MS - (Date.now() - parseUtc(iso).getTime())
  if (left <= 0) return "expiring…"
  const hours = Math.floor(left / 3_600_000)
  if (hours >= 1) return `expires in ${hours}h`
  return `expires in ${Math.max(1, Math.round(left / 60_000))}m`
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  // navigator.clipboard is undefined on insecure origins (the phone hitting the
  // LAN IP over http) — copyText falls back to execCommand and reports whether
  // it actually worked, so we can show a real failure instead of a fake tick.
  const [state, setState] = useState<"idle" | "ok" | "err">("idle")
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={state === "err" ? `${label} — failed` : label}
      title={state === "err" ? "Couldn't copy" : label}
      onClick={() => {
        void copyText(text).then((ok) => {
          setState(ok ? "ok" : "err")
          setTimeout(() => setState("idle"), 1500)
        })
      }}
    >
      {state === "ok" ? (
        <Check className="text-emerald-500" />
      ) : state === "err" ? (
        <X className="text-destructive" />
      ) : (
        <Copy />
      )}
    </Button>
  )
}

function MetaChips({ clip, fromName }: { clip: Clip; fromName: string | null }) {
  return (
    <>
      {fromName && (
        <Badge variant="outline" className="px-1.5 py-0 font-normal">
          {fromName}
        </Badge>
      )}
      <span className="font-mono">{expiresIn(clip.createdAt)}</span>
    </>
  )
}

export function LinkRow({
  clip,
  fromName,
  onDelete,
}: {
  clip: LinkClip
  fromName: string | null
  onDelete: () => void
}) {
  const [iconFailed, setIconFailed] = useState(false)
  const host = hostOf(clip.url)
  return (
    <div className="flex items-start gap-2 rounded-lg border p-3">
      <a
        href={clip.url}
        target="_blank"
        rel="noopener noreferrer"
        className="flex min-w-0 flex-1 items-start gap-3"
      >
        {iconFailed ? (
          <Globe className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        ) : (
          <img
            src={`https://icons.duckduckgo.com/ip3/${host}.ico`}
            alt=""
            className="mt-0.5 size-5 shrink-0 rounded-sm"
            onError={() => setIconFailed(true)}
          />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{clip.title ?? host}</div>
          {clip.summary && (
            <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground/80">{clip.summary}</p>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
            <span className="truncate">{host}</span>
            <Badge variant="secondary" className="px-1.5 py-0 font-normal">
              {clip.category}
            </Badge>
            <MetaChips clip={clip} fromName={fromName} />
          </div>
        </div>
      </a>
      <div className="flex shrink-0 items-center gap-0.5">
        {/* Copying the URL matters on mobile, where "open in new tab" often
            isn't what you want — you want to paste it elsewhere. */}
        <CopyButton text={clip.url} label="Copy link" />
        <Button type="button" variant="ghost" size="icon-sm" aria-label="Delete link" onClick={onDelete}>
          <Trash2 />
        </Button>
      </div>
    </div>
  )
}

export function SnippetRow({
  clip,
  fromName,
  onDelete,
}: {
  clip: SnippetClip
  fromName: string | null
  onDelete: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const content = clip.content ?? ""
  const clampable = content.length > 160 || content.split("\n").length > 3
  return (
    <div className="rounded-lg border p-3">
      <button
        type="button"
        className="block w-full cursor-text text-left"
        onClick={() => clampable && setExpanded((v) => !v)}
      >
        <p className={`text-sm break-words whitespace-pre-wrap ${expanded ? "" : "line-clamp-3"}`}>
          {content}
        </p>
        {clampable && (
          <span className="text-xs text-primary">{expanded ? "Show less" : "Show more"}</span>
        )}
      </button>
      <div className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <MetaChips clip={clip} fromName={fromName} />
        <span className="flex-1" />
        <CopyButton text={content} label="Copy snippet" />
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Delete snippet"
          onClick={onDelete}
        >
          <Trash2 />
        </Button>
      </div>
    </div>
  )
}

export function SecretRow({
  clip,
  fromName,
  busy,
  onReveal,
  onDelete,
}: {
  clip: SnippetClip
  fromName: string | null
  busy: boolean
  onReveal: () => void
  onDelete: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
      <div className="min-w-0 flex-1">
        <div className="font-mono text-sm tracking-widest select-none">••••••</div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Flame className="size-3" /> burns on read
          </span>
          <MetaChips clip={clip} fromName={fromName} />
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Reveal secret"
        disabled={busy}
        onClick={onReveal}
      >
        <Eye />
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Delete secret"
        onClick={onDelete}
      >
        <Trash2 />
      </Button>
    </div>
  )
}

export function RevealDialog({ result, onClose }: { result: RevealResult; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-xl border bg-background p-4 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {result.kind === "ok" ? (
          <>
            <h2 className="mb-2 text-sm font-semibold">Secret revealed</h2>
            <pre className="max-h-60 overflow-auto rounded-md bg-muted p-3 font-mono text-sm break-all whitespace-pre-wrap">
              {result.content}
            </pre>
            <div className="mt-3 flex items-center justify-between gap-3">
              <p className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <Flame className="size-3 shrink-0" /> Deleted from the server — this is the only
                copy.
              </p>
              <div className="flex shrink-0 items-center gap-1">
                <CopyButton text={result.content} label="Copy secret" />
                <Button type="button" size="sm" onClick={onClose}>
                  Done
                </Button>
              </div>
            </div>
          </>
        ) : (
          <>
            <h2 className="mb-2 text-sm font-semibold">Already revealed</h2>
            <p className="text-sm text-muted-foreground">
              This secret was already revealed on another device — it burned on that read.
            </p>
            <div className="mt-3 flex justify-end">
              <Button type="button" size="sm" onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
