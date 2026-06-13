// Links tab: URL handoff, auto-categorized (PLAN.md §12, §17). Pure URLs —
// text snippets and secrets live in Clips. Live via link-new/-updated/-deleted.
// With an active cross-user session, the session's shared links render in a
// pinned "Session" group above the personal day groups (PLAN.md §15).

import { useEffect, useMemo, useState } from "react"
import { Link2, Users } from "lucide-react"

import { EmptyState } from "@/components/EmptyState"
import { FilterPill, toggled } from "@/components/FilterPill"
import { LinkRow } from "@/components/clipRows"
import { PasteBox } from "@/components/PasteBox"
import { deviceId } from "@/lib/device"
import { dayLabel } from "@/lib/time"
import { useClips, type LinkClip } from "@/stores/clips"
import { useDevices } from "@/stores/devices"
import { useShareSession } from "@/stores/shareSession"

export default function LinksView() {
  // Select the stable array; filter in useMemo — filtering inside the selector
  // returns a fresh array every call and trips useSyncExternalStore's
  // unstable-snapshot check (blank-page render crash).
  const clips = useClips((s) => s.clips)
  const sessionActive = useShareSession((s) => s.session !== null)
  const sessionItems = useShareSession((s) => s.items)
  const sessionItemIds = useShareSession((s) => s.sessionItemIds)
  const members = useShareSession((s) => s.members)
  // The frozen clips store also upserts session broadcasts — keep every known
  // session item out of the personal groups (the server's personal list never
  // includes them, so this only filters live-leaked rows).
  const links = useMemo(() => {
    const exclude = new Set(sessionItemIds)
    return clips.filter((c): c is LinkClip => c.type === "link" && !exclude.has(c.id))
  }, [clips, sessionItemIds])
  const sessionLinks = useMemo(
    () => (sessionActive ? sessionItems.filter((c): c is LinkClip => c.type === "link") : []),
    [sessionActive, sessionItems],
  )
  const loaded = useClips((s) => s.loaded)
  const devices = useDevices((s) => s.devices)
  const thisDevice = deviceId()
  const [catFilter, setCatFilter] = useState<string[]>([])
  const [devFilter, setDevFilter] = useState<string[]>([])

  useEffect(() => {
    void useClips.getState().load()
    if (useDevices.getState().devices.length === 0) {
      void useDevices.getState().load() // resolve from-device chip names
    }
  }, [])

  const categories = useMemo(
    () => Array.from(new Set(links.map((l) => l.category))).sort(),
    [links],
  )
  const deviceIds = useMemo(
    () => Array.from(new Set(links.flatMap((l) => (l.fromDevice ? [l.fromDevice] : [])))),
    [links],
  )

  const filtered = useMemo(
    () =>
      links.filter(
        (l) =>
          (catFilter.length === 0 || catFilter.includes(l.category)) &&
          (devFilter.length === 0 || (l.fromDevice !== null && devFilter.includes(l.fromDevice))),
      ),
    [links, catFilter, devFilter],
  )

  const groups = useMemo(() => {
    const out: { label: string; items: LinkClip[] }[] = []
    for (const link of filtered) {
      const label = dayLabel(link.createdAt)
      const last = out[out.length - 1]
      if (last && last.label === label) last.items.push(link)
      else out.push({ label, items: [link] })
    }
    return out
  }, [filtered])

  const nameOf = (id: string | null): string | null => {
    if (!id) return null
    if (id === thisDevice) return "this device"
    const mine = devices.find((d) => d.id === id)?.name
    if (mine) return mine
    // Session items may come from the OTHER user's joined device.
    const member = members.find((m) => m.deviceId === id)
    return member ? `${member.userName} · ${member.deviceName}` : "another device"
  }

  return (
    <div className="flex flex-col gap-3">
      <PasteBox context="links" />

      {sessionActive && sessionLinks.length > 0 && (
        <section className="rounded-lg border-l-2 border-primary/50 pl-2">
          <h3 className="mt-1 mb-2 flex items-center gap-1.5 text-xs font-medium tracking-wide text-primary uppercase">
            <Users className="size-3.5" aria-hidden /> Session
          </h3>
          <div className="flex flex-col gap-2">
            {sessionLinks.map((link) => (
              <LinkRow
                key={link.id}
                clip={link}
                fromName={nameOf(link.fromDevice)}
                onDelete={() => void useClips.getState().deleteClip(link)}
              />
            ))}
          </div>
        </section>
      )}

      {links.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {categories.map((c) => (
            <FilterPill
              key={c}
              active={catFilter.includes(c)}
              onClick={() => setCatFilter((prev) => toggled(prev, c))}
            >
              {c}
            </FilterPill>
          ))}
          {categories.length > 0 && deviceIds.length > 1 && (
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          )}
          {deviceIds.length > 1 &&
            deviceIds.map((id) => (
              <FilterPill
                key={id}
                active={devFilter.includes(id)}
                onClick={() => setDevFilter((prev) => toggled(prev, id))}
              >
                {nameOf(id)}
              </FilterPill>
            ))}
        </div>
      )}

      {groups.map((group) => (
        <section key={group.label}>
          <h3 className="mt-1 mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h3>
          <div className="flex flex-col gap-2">
            {group.items.map((link) => (
              <LinkRow
                key={link.id}
                clip={link}
                fromName={nameOf(link.fromDevice)}
                onDelete={() => void useClips.getState().deleteClip(link)}
              />
            ))}
          </div>
        </section>
      ))}

      {loaded && links.length === 0 && sessionLinks.length === 0 && (
        <EmptyState icon={Link2}>
          Paste a URL above — or share one to Pontje from any app — and open it on any other
          device. Links auto-categorize and vanish after 48 h.
        </EmptyState>
      )}
      {loaded && links.length > 0 && filtered.length === 0 && (
        <p className="p-6 text-center text-sm text-muted-foreground">
          Nothing matches these filters.
        </p>
      )}
    </div>
  )
}
