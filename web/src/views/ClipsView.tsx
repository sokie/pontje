// Clips tab: text snippets + burn-on-read secrets (PLAN.md §13, §17).
// URLs live in the Links tab — the shared paste box routes them there.
// With an active cross-user session, shared snippets/secrets render in a
// pinned "Session" group above the personal day groups (PLAN.md §15).

import { useEffect, useMemo, useState } from "react"
import { ClipboardList, Users } from "lucide-react"

import { EmptyState } from "@/components/EmptyState"
import { RevealDialog, SecretRow, SnippetRow } from "@/components/clipRows"
import { PasteBox } from "@/components/PasteBox"
import { deviceId } from "@/lib/device"
import { dayLabel } from "@/lib/time"
import { useClips, type RevealResult, type SnippetClip } from "@/stores/clips"
import { useDevices } from "@/stores/devices"
import { useShareSession } from "@/stores/shareSession"

export default function ClipsView() {
  // Stable selector + useMemo filter (same unstable-snapshot pitfall as LinksView).
  const clips = useClips((s) => s.clips)
  const sessionActive = useShareSession((s) => s.session !== null)
  const sessionItems = useShareSession((s) => s.items)
  const sessionItemIds = useShareSession((s) => s.sessionItemIds)
  const members = useShareSession((s) => s.members)
  // Session broadcasts also land in the frozen clips store — exclude every
  // known session item from the personal day groups.
  const snippets = useMemo(() => {
    const exclude = new Set(sessionItemIds)
    return clips.filter((c): c is SnippetClip => c.type === "snippet" && !exclude.has(c.id))
  }, [clips, sessionItemIds])
  const sessionSnippets = useMemo(
    () =>
      sessionActive ? sessionItems.filter((c): c is SnippetClip => c.type === "snippet") : [],
    [sessionActive, sessionItems],
  )
  const loaded = useClips((s) => s.loaded)
  const revealNotice = useClips((s) => s.revealNotice)
  const devices = useDevices((s) => s.devices)
  const thisDevice = deviceId()

  const [reveal, setReveal] = useState<RevealResult | null>(null)
  const [revealBusy, setRevealBusy] = useState(false)

  useEffect(() => {
    void useClips.getState().load()
    if (useDevices.getState().devices.length === 0) {
      void useDevices.getState().load() // resolve from-device chip names
    }
  }, [])

  const groups = useMemo(() => {
    const out: { label: string; items: SnippetClip[] }[] = []
    for (const clip of snippets) {
      const label = dayLabel(clip.createdAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(clip)
      else out.push({ label, items: [clip] })
    }
    return out
  }, [snippets])

  const nameOf = (id: string | null): string | null => {
    if (!id) return null
    if (id === thisDevice) return "this device"
    const mine = devices.find((d) => d.id === id)?.name
    if (mine) return mine
    // Session items may come from the OTHER user's joined device.
    const member = members.find((m) => m.deviceId === id)
    return member ? `${member.userName} · ${member.deviceName}` : "another device"
  }

  const onReveal = async (clip: SnippetClip) => {
    if (revealBusy) return
    setRevealBusy(true)
    const result = await useClips.getState().revealSecret(clip.id)
    setRevealBusy(false)
    setReveal(result)
  }

  const renderRow = (clip: SnippetClip) =>
    clip.kind === "secret" ? (
      <SecretRow
        key={clip.id}
        clip={clip}
        fromName={nameOf(clip.fromDevice)}
        busy={revealBusy}
        onReveal={() => void onReveal(clip)}
        onDelete={() => void useClips.getState().deleteClip(clip)}
      />
    ) : (
      <SnippetRow
        key={clip.id}
        clip={clip}
        fromName={nameOf(clip.fromDevice)}
        onDelete={() => void useClips.getState().deleteClip(clip)}
      />
    )

  return (
    <div className="flex flex-col gap-3">
      <PasteBox context="clips" consumeShareStash />

      {revealNotice && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs">
          Secret revealed on {nameOf(revealNotice.deviceId) ?? "another device"} — removed
          everywhere.
        </p>
      )}

      {sessionActive && sessionSnippets.length > 0 && (
        <section className="rounded-lg border-l-2 border-primary/50 pl-2">
          <h3 className="mt-1 mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-primary uppercase">
            <Users className="size-3.5" aria-hidden /> Session
          </h3>
          <div className="flex flex-col gap-2">{sessionSnippets.map(renderRow)}</div>
        </section>
      )}

      {groups.map((group) => (
        <section key={group.label}>
          <h3 className="mt-1 mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h3>
          <div className="flex flex-col gap-2">{group.items.map(renderRow)}</div>
        </section>
      ))}

      {loaded && snippets.length === 0 && sessionSnippets.length === 0 && (
        <EmptyState icon={ClipboardList}>
          Beam your clipboard: plain text lands here, secrets burn after one read. Everything
          vanishes after 48 h.
        </EmptyState>
      )}

      {reveal && <RevealDialog result={reveal} onClose={() => setReveal(null)} />}
    </div>
  )
}
