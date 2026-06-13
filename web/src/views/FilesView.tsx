// Files tab, split into two segments (actionable vs informational):
//   Available — shared offers you can pull right now (PLAN.md §14.1), with a
//               "ready" count and the available-now filter.
//   History   — the read-only 48 h transfer log (PLAN.md §14.3).
// Offers update live via file-shared/-unshared/-stale; history via
// transfer-logged.

import { useEffect, useMemo, useState } from "react"
import { Archive, Code, Download, File, FileText, Film, Image, Music, X } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/EmptyState"
import { FilterPill, toggled } from "@/components/FilterPill"
import { deviceId } from "@/lib/device"
import { fmtBytes } from "@/lib/format"
import { isTerminal, type NetworkPath } from "@/lib/rtc/types"
import { dayLabel, timeAgo } from "@/lib/time"
import { useDevices } from "@/stores/devices"
import { useFiles, type TransferRecord } from "@/stores/files"
import { useShares, type SharedOffer } from "@/stores/shares"
import { useTransfers } from "@/stores/transfers"
import { useUi, type FilesSegment } from "@/stores/ui"

// File-type taxonomy icons (PLAN.md §14.4) — category comes from the server.
const CATEGORY_ICON: Record<string, typeof File> = {
  image: Image,
  video: Film,
  audio: Music,
  document: FileText,
  archive: Archive,
  code: Code,
  other: File,
}

// Network-path badge (PLAN.md §10.5) — same glyphs as the live transfer rows.
const PATH_BADGE: Record<NetworkPath, { icon: string; label: string; title: string }> = {
  lan: { icon: "⚡", label: "Local", title: "Device-to-device on the local network" },
  internet: { icon: "🌐", label: "Direct", title: "Direct over the internet" },
  relay: { icon: "↪", label: "Relayed", title: "Via a relay server" },
}

/** Non-completed outcomes render dimmed with this small label. */
const STATUS_LABEL: Record<string, string> = {
  failed: "failed",
  rejected: "rejected",
  canceled: "canceled",
}

/** Device chip; the from-chip is presence-aware (PLAN.md §14.3): live online
 * dot, "offline since …" in the tooltip. Unknown ids fall back truncated. */
function DeviceChip({ id, presence }: { id: string; presence: boolean }) {
  const device = useDevices((s) => s.devices.find((d) => d.id === id))
  const name = device?.name ?? `${id.slice(0, 8)}…`
  const title =
    presence && device && !device.online && device.lastSeen
      ? `offline since ${timeAgo(device.lastSeen)}`
      : undefined
  return (
    <Badge variant="outline" className="max-w-32 px-1.5 py-0 font-normal" title={title}>
      {presence && (
        <span
          className={`size-1.5 shrink-0 rounded-full ${
            device?.online ? "bg-emerald-500" : "bg-muted-foreground/40"
          }`}
        />
      )}
      <span className="truncate">{name}</span>
    </Badge>
  )
}

function HistoryRow({ r }: { r: TransferRecord }) {
  const Icon = CATEGORY_ICON[r.category] ?? File
  const badge =
    r.networkPath && r.networkPath in PATH_BADGE ? PATH_BADGE[r.networkPath as NetworkPath] : null
  const statusLabel = STATUS_LABEL[r.status]
  return (
    <div
      className={`flex items-center gap-3 rounded-lg border p-3 ${statusLabel ? "opacity-60" : ""}`}
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-label={r.category} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium" title={r.fileName}>
            {r.fileName}
          </span>
          {badge && (
            <span className="shrink-0 text-[10px] text-muted-foreground" title={badge.title}>
              {badge.icon} {badge.label}
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {r.sizeBytes !== null && <span className="font-mono">{fmtBytes(r.sizeBytes)}</span>}
          {r.fromDevice && <DeviceChip id={r.fromDevice} presence />}
          {r.fromDevice && r.toDevice && <span aria-hidden>→</span>}
          {r.toDevice && <DeviceChip id={r.toDevice} presence={false} />}
          {statusLabel && (
            <span className={r.status === "failed" ? "text-destructive" : ""}>{statusLabel}</span>
          )}
        </div>
      </div>
    </div>
  )
}

/** Shared-offer row (PLAN.md §17): filled/accent card, presence-aware sharer
 * chip — ● Online + Download (pull over WebRTC), "offline since …" disabled,
 * or greyed stale. Own offers get the unshare ✕ and a durability hint. */
function OfferRow({ offer }: { offer: SharedOffer }) {
  const Icon = CATEGORY_ICON[offer.category] ?? File
  const sharer = useDevices((s) => s.devices.find((d) => d.id === offer.fromDevice))
  const pull = useShares((s) => s.pull)
  const unshare = useShares((s) => s.unshare)
  const durability = useShares((s) => s.durability[offer.id])
  // The pull's transfer rows (placeholder, then the real receive) carry the
  // offer id — prefer a live one, else the latest terminal one (linger window).
  const pullTransfer = useTransfers((s) => {
    const mine = Object.values(s.transfers).filter(
      (t) => t.direction === "recv" && t.sharedFileId === offer.id,
    )
    return mine.find((t) => !isTerminal(t.status)) ?? mine[mine.length - 1]
  })

  const isOwn = offer.fromDevice === deviceId()
  const stale = offer.status === "stale"
  const online = sharer?.online ?? false
  const pulling = pullTransfer !== undefined && !isTerminal(pullTransfer.status)
  const pullPct =
    pulling && pullTransfer.status === "transferring" && pullTransfer.size > 0
      ? Math.min(100, Math.floor((pullTransfer.bytes / pullTransfer.size) * 100))
      : null

  return (
    <div
      className={`flex items-center gap-3 rounded-lg border p-3 ${
        stale ? "opacity-60" : "border-primary/30 bg-primary/5"
      }`}
    >
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-label={offer.category} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="min-w-0 truncate text-sm font-medium" title={offer.fileName}>
            {offer.fileName}
          </span>
          {stale && (
            <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px] font-normal">
              stale
            </Badge>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          {offer.sizeBytes !== null && (
            <span className="font-mono">{fmtBytes(offer.sizeBytes)}</span>
          )}
          <DeviceChip id={offer.fromDevice} presence />
          {stale ? (
            <span title="The sharing device can no longer provide this file">
              no longer available
            </span>
          ) : online ? (
            <span className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <span className="size-1.5 rounded-full bg-emerald-500 live-dot" /> Online
            </span>
          ) : (
            <span>{sharer?.lastSeen ? `offline since ${timeAgo(sharer.lastSeen)}` : "offline"}</span>
          )}
          {isOwn && durability && !stale && (
            <span className="text-muted-foreground/60">· {durability}</span>
          )}
          {pullPct !== null && <span>downloading… {pullPct}%</span>}
          {pullTransfer?.status === "failed" && pullTransfer.error && (
            <span className="text-destructive">{pullTransfer.error}</span>
          )}
        </div>
      </div>
      {isOwn ? (
        <Button
          size="icon-xs"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
          aria-label={`Unshare ${offer.fileName}`}
          title="Unshare"
          onClick={() => void unshare(offer.id)}
        >
          <X />
        </Button>
      ) : (
        // The Download click doubles as the save-picker gesture on the pull path.
        <Button
          size="sm"
          variant={stale ? "outline" : "default"}
          className="shrink-0"
          disabled={stale || !online || pulling}
          title={
            stale
              ? "No longer available on the sharing device"
              : online
                ? `Pull from ${sharer?.name ?? "the sharing device"}`
                : "The sharing device is offline"
          }
          onClick={() => pull(offer)}
        >
          <Download /> {pulling ? "Pulling…" : "Download"}
        </Button>
      )}
    </div>
  )
}

function dayGroups<T>(items: T[], at: (item: T) => string): { label: string; items: T[] }[] {
  const out: { label: string; items: T[] }[] = []
  for (const item of items) {
    const label = dayLabel(at(item))
    const last = out[out.length - 1]
    if (last && last.label === label) last.items.push(item)
    else out.push({ label, items: [item] })
  }
  return out
}

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs transition-colors ${
        active ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {children}
    </button>
  )
}

function AvailableSegment() {
  const offers = useShares((s) => s.offers)
  const devices = useDevices((s) => s.devices)
  const [catFilter, setCatFilter] = useState<string[]>([])
  const [availableNow, setAvailableNow] = useState(false)

  const onlineIds = useMemo(
    () => new Set(devices.filter((d) => d.online).map((d) => d.id)),
    [devices],
  )
  const categories = useMemo(
    () => Array.from(new Set(offers.map((o) => o.category))).sort(),
    [offers],
  )

  const filtered = useMemo(
    () =>
      offers.filter((o) => {
        if (catFilter.length > 0 && !catFilter.includes(o.category)) return false
        if (availableNow) return o.status === "active" && onlineIds.has(o.fromDevice)
        return true
      }),
    [offers, catFilter, availableNow, onlineIds],
  )

  const groups = useMemo(() => dayGroups(filtered, (o) => o.createdAt), [filtered])

  return (
    <>
      {offers.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <FilterPill active={availableNow} onClick={() => setAvailableNow((v) => !v)}>
            available now
          </FilterPill>
          {categories.length > 1 && (
            <>
              <span aria-hidden className="mx-1 h-4 w-px bg-border" />
              {categories.map((c) => (
                <FilterPill
                  key={c}
                  active={catFilter.includes(c)}
                  onClick={() => setCatFilter((prev) => toggled(prev, c))}
                >
                  {c}
                </FilterPill>
              ))}
            </>
          )}
        </div>
      )}

      {groups.map((group) => (
        <section key={group.label}>
          <h3 className="mt-1 mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h3>
          <div className="flex flex-col gap-2">
            {group.items.map((offer) => (
              <OfferRow key={offer.id} offer={offer} />
            ))}
          </div>
        </section>
      ))}

      {offers.length === 0 && (
        <EmptyState icon={Download}>
          Nothing shared for later. Drop a file on <span className="font-medium">Share for
          later</span> in Devices — every device can pull it whenever the sharer is online,
          for 48 h.
        </EmptyState>
      )}
      {offers.length > 0 && filtered.length === 0 && (
        <p className="p-6 text-center text-sm text-muted-foreground">
          Nothing matches these filters.
        </p>
      )}
    </>
  )
}

function HistorySegment() {
  const records = useFiles((s) => s.records)
  const loaded = useFiles((s) => s.loaded)
  const devices = useDevices((s) => s.devices)
  const [catFilter, setCatFilter] = useState<string[]>([])
  const [devFilter, setDevFilter] = useState<string[]>([])

  const categories = useMemo(
    () => Array.from(new Set(records.map((r) => r.category))).sort(),
    [records],
  )
  const deviceIds = useMemo(() => {
    const ids = new Set<string>()
    for (const r of records) {
      if (r.fromDevice) ids.add(r.fromDevice)
      if (r.toDevice) ids.add(r.toDevice)
    }
    return Array.from(ids)
  }, [records])

  const filtered = useMemo(
    () =>
      records.filter(
        (r) =>
          (catFilter.length === 0 || catFilter.includes(r.category)) &&
          (devFilter.length === 0 ||
            (r.fromDevice !== null && devFilter.includes(r.fromDevice)) ||
            (r.toDevice !== null && devFilter.includes(r.toDevice))),
      ),
    [records, catFilter, devFilter],
  )

  const groups = useMemo(() => dayGroups(filtered, (r) => r.createdAt), [filtered])
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? `${id.slice(0, 8)}…`

  return (
    <>
      {records.length > 0 && (
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
          {categories.length > 0 && deviceIds.length > 0 && (
            <span aria-hidden className="mx-1 h-4 w-px bg-border" />
          )}
          {deviceIds.map((id) => (
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
            {group.items.map((r) => (
              <HistoryRow key={r.id} r={r} />
            ))}
          </div>
        </section>
      ))}

      {loaded && records.length === 0 && (
        <EmptyState icon={FileText}>
          Transfers you send or receive get logged here for 48 h.
        </EmptyState>
      )}
      {loaded && records.length > 0 && filtered.length === 0 && (
        <p className="p-6 text-center text-sm text-muted-foreground">
          Nothing matches these filters.
        </p>
      )}
      {records.length > 0 && (
        <p className="pb-2 text-center text-xs text-muted-foreground/60">
          Log only — file bytes are never stored on the server.
        </p>
      )}
    </>
  )
}

export default function FilesView() {
  const segment = useUi((s) => s.filesSegment)
  const setSegment = useUi((s) => s.setFilesSegment)
  const offers = useShares((s) => s.offers)
  const devices = useDevices((s) => s.devices)

  useEffect(() => {
    void useFiles.getState().load()
    void useShares.getState().load()
    if (useDevices.getState().devices.length === 0) {
      void useDevices.getState().load() // resolve device chip names + presence
    }
  }, [])

  // The actionable number: offers you could pull THIS second.
  const readyCount = useMemo(() => {
    const online = new Set(devices.filter((d) => d.online).map((d) => d.id))
    return offers.filter((o) => o.status === "active" && online.has(o.fromDevice)).length
  }, [offers, devices])

  const pick = (s: FilesSegment) => () => setSegment(s)

  return (
    <div className="flex flex-col gap-3">
      <div
        role="tablist"
        aria-label="Files sections"
        className="inline-flex items-center gap-1 self-start rounded-full bg-muted p-1"
      >
        <SegmentButton active={segment === "available"} onClick={pick("available")}>
          Available
          {readyCount > 0 && (
            <span className="rounded-full bg-primary/15 px-1.5 text-[10px] font-medium text-primary">
              {readyCount}
            </span>
          )}
        </SegmentButton>
        <SegmentButton active={segment === "history"} onClick={pick("history")}>
          History
        </SegmentButton>
      </div>

      {segment === "available" ? <AvailableSegment /> : <HistorySegment />}
    </div>
  )
}
