// Devices view (PLAN.md §17): card grid with live presence, this-device chip,
// rename/remove, first-run naming, QR link dialog, device-linked banner.
// Phase 3: drag/tap-to-send files, live transfer rows with progress + network
// badge, incoming accept/reject prompts, auto-accept toggle.
// Phase 4: "All devices" fan-out card (§10.3) and folder → streaming-zip
// sends (§11) — drop a folder on any card or use its folder button.
// Phase 5: "Share for later" card (§14.1) publishing pull-able offers, and
// floating re-grant prompts when a pull needs a handle re-authorization.
// Phase 6: highlighted "Session" section (§15) — the OTHER members' joined
// devices as drop targets, code + countdown + End/Leave inline.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type FormEvent,
  type RefObject,
} from "react"
import {
  Check,
  Clock,
  FolderUp,
  Laptop,
  Monitor,
  MonitorSmartphone,
  Pencil,
  QrCode,
  Send,
  Share2,
  Smartphone,
  Trash2,
  UserRound,
  Users,
  X,
} from "lucide-react"

import { QrLinkDialog } from "@/components/QrLinkDialog"
import { sessionTimeLeft } from "@/components/SessionDialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { EmptyState } from "@/components/EmptyState"
import { defaultDeviceName, deviceId } from "@/lib/device"
import { fmtBytes } from "@/lib/format"
import {
  collectDrop,
  foldersFromFileList,
  pickFolder,
  supportsDirectoryPicker,
  type PickedFolder,
} from "@/lib/rtc/folderSource"
import type { NetworkPath } from "@/lib/rtc/types"
import type { SinkKind } from "@/lib/save"
import type { ShareInput } from "@/lib/shares/persistence"
import { collectShareDrop, pickShareInputs, supportsOpenFilePicker } from "@/lib/shares/pick"
import { timeAgo } from "@/lib/time"
import { useDevices, type PeerDevice } from "@/stores/devices"
import { takePendingShareFiles, usePendingShare } from "@/stores/pendingShare"
import { useSession } from "@/stores/session"
import { useShares } from "@/stores/shares"
import { useShareSession, type SessionMemberInfo } from "@/stores/shareSession"
import { useTransfers, type Transfer } from "@/stores/transfers"

function PlatformIcon({ platform }: { platform: string | null }) {
  const cls = "size-5 shrink-0 text-muted-foreground"
  if (platform === "android") return <Smartphone className={cls} aria-label="android" />
  if (platform === "mac") return <Laptop className={cls} aria-label="mac" />
  return <Monitor className={cls} aria-label={platform ?? "device"} />
}

/** Shared drag-drop plumbing for the send/share cards: tracks the drag-over
 * state and hands the drop to a collector (which MUST snapshot the
 * DataTransfer synchronously — its async walks finish before the payload
 * callback runs). */
function useDropTarget<T>(
  enabled: boolean,
  collect: (dt: DataTransfer) => Promise<T>,
  onPayload: (payload: T) => void,
) {
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)

  const onDragEnter = (e: DragEvent) => {
    if (!enabled) return
    e.preventDefault()
    dragDepth.current += 1
    setDragOver(true)
  }
  const onDragOver = (e: DragEvent) => {
    if (!enabled) return
    e.preventDefault() // required to allow the drop
  }
  const onDragLeave = () => {
    if (!enabled) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDragOver(false)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    dragDepth.current = 0
    setDragOver(false)
    if (!enabled) return
    void collect(e.dataTransfer).then(onPayload)
  }

  return { dragOver, dropProps: { onDragEnter, onDragOver, onDragLeave, onDrop } }
}

/** Hidden file + folder inputs. webkitdirectory isn't in React's input
 * typings, so it's set via setAttribute in the ref callback. */
function HiddenPickers({
  fileRef,
  folderRef,
  onFiles,
  onFolders,
}: {
  fileRef: RefObject<HTMLInputElement | null>
  folderRef: RefObject<HTMLInputElement | null>
  onFiles: (files: File[]) => void
  onFolders: (folders: PickedFolder[]) => void
}) {
  return (
    <>
      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        // Programmatic .click() bubbles — don't re-trigger the card's picker.
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? [])
          e.currentTarget.value = "" // same files re-pickable later
          if (files.length > 0) onFiles(files)
        }}
      />
      <input
        ref={(el) => {
          folderRef.current = el
          el?.setAttribute("webkitdirectory", "")
        }}
        type="file"
        hidden
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? [])
          e.currentTarget.value = ""
          const folders = foldersFromFileList(files)
          if (folders.length > 0) onFolders(folders)
        }}
      />
    </>
  )
}

/** Folder pick: Chromium directory picker when available, else the
 * webkitdirectory input (Firefox/Safari). */
function openFolderPicker(
  folderInput: HTMLInputElement | null,
  onFolders: (folders: PickedFolder[]) => void,
) {
  if (supportsDirectoryPicker()) {
    void pickFolder()
      .then((folder) => folder && onFolders([folder]))
      .catch(() => undefined) // permission denied etc. — nothing to send
  } else {
    folderInput?.click()
  }
}

function NameThisDeviceCard() {
  const registerThisDevice = useDevices((s) => s.registerThisDevice)
  // A returning browser (re-login) may already have a registered name — prefer it.
  const existingName = useDevices((s) => s.devices.find((d) => d.id === deviceId())?.name)
  const [name, setName] = useState(() => existingName ?? defaultDeviceName())
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    // The device list loads async; adopt the stored name unless the user typed.
    if (existingName && !dirty) setName(existingName)
  }, [existingName, dirty])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const err = await registerThisDevice(name)
    if (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Card className="border-primary/40">
      <CardContent className="flex flex-col gap-3">
        <div>
          <p className="text-sm font-medium">Name this device</p>
          <p className="text-xs text-muted-foreground">
            First time here — your other devices will see it under this name.
          </p>
        </div>
        <form className="flex gap-2" onSubmit={submit}>
          <input
            className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm"
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setDirty(true)
            }}
            maxLength={64}
            autoFocus
          />
          <Button type="submit" disabled={busy}>
            {busy ? "Registering…" : "Register"}
          </Button>
        </form>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </CardContent>
    </Card>
  )
}

// Network-path badge (PLAN.md §10.5): ⚡ both-host · 🌐 direct · ↪ relayed.
const PATH_BADGE: Record<NetworkPath, { icon: string; label: string; title: string }> = {
  lan: { icon: "⚡", label: "Local", title: "Device-to-device on the local network" },
  internet: { icon: "🌐", label: "Direct", title: "Direct over the internet" },
  relay: { icon: "↪", label: "Relayed", title: "Via a relay server" },
}

const SINK_LABEL: Record<SinkKind, string> = {
  "fs-api": "to disk",
  "sw-stream": "streaming",
  blob: "in memory",
}

function transferLabel(t: Transfer): string {
  const folder = t.kind === "folder"
  const count = folder && t.fileCount ? ` · ${t.fileCount} files` : ""
  return `${folder ? "📁 " : ""}${t.name}${count}`
}

function TransferRow({ t }: { t: Transfer }) {
  const cancel = useTransfers((s) => s.cancel)
  const pct =
    t.size > 0 ? Math.min(100, (t.bytes / t.size) * 100) : t.status === "done" ? 100 : 0
  const cancelable =
    t.status === "connecting" || t.status === "awaiting-accept" || t.status === "transferring"
  const badge = t.networkPath ? PATH_BADGE[t.networkPath] : null

  return (
    <div className="flex flex-col gap-1 rounded-md border bg-muted/30 px-2 py-1.5">
      <div className="flex items-center gap-1.5 text-xs">
        <span className="shrink-0 text-muted-foreground" title={t.direction === "send" ? "Sending" : "Receiving"}>
          {t.direction === "send" ? "↑" : "↓"}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{transferLabel(t)}</span>
        {badge && (
          <span className="shrink-0 text-[10px] text-muted-foreground" title={badge.title}>
            {badge.icon} {badge.label}
          </span>
        )}
        {cancelable && (
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            aria-label={`Cancel transfer of ${t.name}`}
            onClick={(e) => {
              e.stopPropagation()
              cancel(t.id)
            }}
          >
            <X />
          </Button>
        )}
      </div>

      {t.status === "transferring" && (
        <>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="progress-sheen h-full rounded-full bg-primary transition-[width] duration-200"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="flex items-center justify-between font-mono text-[10px] tabular-nums text-muted-foreground">
            <span>
              {fmtBytes(t.bytes)} / {fmtBytes(t.size)}
            </span>
            <span>
              {t.rate > 0 && `${fmtBytes(t.rate)}/s`}
              {t.direction === "recv" && t.sinkKind && ` · ${SINK_LABEL[t.sinkKind]}`}
            </span>
          </div>
        </>
      )}
      {t.status === "connecting" && (
        <p className="text-[10px] text-muted-foreground">connecting…</p>
      )}
      {t.status === "awaiting-accept" && (
        <p className="text-[10px] text-muted-foreground">
          {t.direction === "send" ? "waiting for the other device to accept…" : "waiting for you to accept…"}
        </p>
      )}
      {t.status === "done" && (
        <p className="text-[10px] text-emerald-600 dark:text-emerald-400">
          ✓ {t.direction === "send" ? "sent" : "saved"} · {fmtBytes(t.size)}
        </p>
      )}
      {t.status === "failed" && (
        <p className="text-[10px] text-destructive">failed{t.error ? ` — ${t.error}` : ""}</p>
      )}
      {t.status === "rejected" && <p className="text-[10px] text-muted-foreground">rejected</p>}
      {t.status === "canceled" && <p className="text-[10px] text-muted-foreground">canceled</p>}
    </div>
  )
}

function DeviceCard({ device, isThis }: { device: PeerDevice; isThis: boolean }) {
  const renameDevice = useDevices((s) => s.renameDevice)
  const removeDevice = useDevices((s) => s.removeDevice)
  const sendFiles = useTransfers((s) => s.sendFiles)
  const sendFolders = useTransfers((s) => s.sendFolders)
  const transfers = useTransfers((s) => s.transfers)
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(device.name)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const rows = Object.values(transfers).filter((t) => t.peerDeviceId === device.id)
  const canSendTo = !isThis && device.online

  const { dragOver, dropProps } = useDropTarget(canSendTo, collectDrop, ({ files, folders }) => {
    if (files.length > 0) sendFiles(device.id, files)
    if (folders.length > 0) sendFolders(device.id, folders)
  })

  const submitRename = async (e: FormEvent) => {
    e.preventDefault()
    setError(null)
    const err = await renameDevice(device.id, name)
    if (err) setError(err)
    else setEditing(false)
  }

  const remove = async () => {
    if (!confirm(`Remove "${device.name}"? Sessions on that device will be signed out.`)) return
    const err = await removeDevice(device.id)
    if (err) setError(err)
  }

  const pickFiles = () => {
    if (!canSendTo || editing) return
    fileInput.current?.click()
  }

  return (
    <Card
      className={`py-4 transition-all ${
        canSendTo ? "cursor-pointer hover:border-primary/40 hover:shadow-md" : ""
      } ${dragOver ? "border-primary ring-2 ring-primary/40" : ""}`}
      onClick={pickFiles}
      {...dropProps}
    >
      <CardContent className="flex flex-col gap-2 px-4">
        <HiddenPickers
          fileRef={fileInput}
          folderRef={folderInput}
          onFiles={(files) => sendFiles(device.id, files)}
          onFolders={(folders) => sendFolders(device.id, folders)}
        />
        <div className="flex items-center gap-3">
          <PlatformIcon platform={device.platform} />
          <div className="min-w-0 flex-1">
            {editing ? (
              <form
                className="flex items-center gap-1"
                onClick={(e) => e.stopPropagation()}
                onSubmit={submitRename}
              >
                <input
                  className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={64}
                  autoFocus
                />
                <Button type="submit" size="icon-xs" variant="ghost" aria-label="Save name">
                  <Check />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Cancel rename"
                  onClick={() => {
                    setEditing(false)
                    setName(device.name)
                    setError(null)
                  }}
                >
                  <X />
                </Button>
              </form>
            ) : (
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium">{device.name}</span>
                {isThis && (
                  <Badge variant="secondary" className="shrink-0">
                    this device
                  </Badge>
                )}
              </div>
            )}
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={`size-2 shrink-0 rounded-full ${
                  device.online ? "bg-emerald-500 live-dot" : "bg-muted-foreground/40"
                }`}
              />
              {device.online
                ? "online"
                : device.lastSeen
                  ? `offline since ${timeAgo(device.lastSeen)}`
                  : "offline"}
              {canSendTo && (
                <span className="text-muted-foreground/60">· tap or drop files or a folder</span>
              )}
            </div>
          </div>
          {!editing && (
            <div className="flex shrink-0 items-center gap-0.5">
              {canSendTo && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Send a folder to ${device.name}`}
                  onClick={(e) => {
                    e.stopPropagation() // don't open the file picker
                    openFolderPicker(folderInput.current, (folders) =>
                      sendFolders(device.id, folders),
                    )
                  }}
                >
                  <FolderUp />
                </Button>
              )}
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Rename ${device.name}`}
                onClick={(e) => {
                  e.stopPropagation() // don't open the file picker
                  setName(device.name)
                  setEditing(true)
                }}
              >
                <Pencil />
              </Button>
              {!isThis && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="text-destructive hover:text-destructive"
                  aria-label={`Remove ${device.name}`}
                  onClick={(e) => {
                    e.stopPropagation()
                    void remove()
                  }}
                >
                  <Trash2 />
                </Button>
              )}
            </div>
          )}
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
        {rows.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-1" onClick={(e) => e.stopPropagation()}>
            {rows.map((t) => (
              <TransferRow key={t.id} t={t} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

// "All devices" fan-out card (PLAN.md §10.3): drop/tap → send to every online
// device except this one. The engine queues per target with independent
// backpressure, so a slow phone never stalls a fast desktop; per-target rows
// land on each device's own card. Folders get one fresh zip source per target
// inside the store's sendToAll — a zip stream can only be consumed once.
function AllDevicesCard() {
  const devices = useDevices((s) => s.devices)
  const sendToAll = useTransfers((s) => s.sendToAll)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const thisId = deviceId()
  const targets = devices.filter((d) => d.online && d.id !== thisId)
  const canSend = targets.length > 0

  const { dragOver, dropProps } = useDropTarget(canSend, collectDrop, ({ files, folders }) => {
    if (files.length > 0 || folders.length > 0) sendToAll(files, folders)
  })

  return (
    <Card
      className={`border-dashed py-4 transition-colors ${canSend ? "cursor-pointer" : "opacity-60"} ${
        dragOver ? "border-primary ring-2 ring-primary/40" : ""
      }`}
      onClick={() => canSend && fileInput.current?.click()}
      {...dropProps}
    >
      <CardContent className="flex items-center gap-3 px-4">
        <HiddenPickers
          fileRef={fileInput}
          folderRef={folderInput}
          onFiles={(files) => sendToAll(files, [])}
          onFolders={(folders) => sendToAll([], folders)}
        />
        <MonitorSmartphone className="size-5 shrink-0 text-muted-foreground" aria-label="all devices" />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium">All devices</span>
          <div className="text-xs text-muted-foreground">
            {canSend
              ? `beam to ${targets.length} online device${targets.length === 1 ? "" : "s"} at once · tap or drop`
              : "no other devices online"}
          </div>
        </div>
        {canSend && (
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            aria-label="Send a folder to all devices"
            onClick={(e) => {
              e.stopPropagation()
              openFolderPicker(folderInput.current, (folders) => sendToAll([], folders))
            }}
          >
            <FolderUp />
          </Button>
        )}
      </CardContent>
    </Card>
  )
}

// "Share for later" card (PLAN.md §14.1): publishes pull-able offers instead
// of pushing — every device gets a presence-aware row in Files. On Chromium
// the picker/drop hands out FileSystemFileHandles (top persistence tier:
// zero-copy, survives restarts); elsewhere plain Files ride the byte-copy or
// in-memory tiers (PLAN.md §14.2). A transient hint reports the durability.
function ShareForLaterCard() {
  const publish = useShares((s) => s.publish)
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const showNotice = (text: string, error = false) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    setNotice({ text, error })
    noticeTimer.current = setTimeout(() => setNotice(null), 6000)
  }

  const doPublish = async (inputs: ShareInput[]) => {
    setBusy(true)
    try {
      const { error, durabilities } = await publish(inputs)
      if (error) {
        showNotice(error, true)
      } else if (durabilities.length > 0) {
        showNotice(
          durabilities.includes("until this tab closes")
            ? "Shared — held in memory, until this tab closes"
            : "Shared — survives restarts on this device",
        )
      }
    } finally {
      setBusy(false)
    }
  }

  const { dragOver, dropProps } = useDropTarget(!busy, collectShareDrop, (inputs) => {
    if (inputs.length > 0) void doPublish(inputs)
  })

  const pick = () => {
    if (busy) return
    if (supportsOpenFilePicker()) {
      // Chromium: handles, the top persistence tier.
      void pickShareInputs().then((inputs) => {
        if (inputs && inputs.length > 0) void doPublish(inputs)
      })
    } else {
      fileInput.current?.click()
    }
  }

  return (
    <Card
      className={`cursor-pointer border-dashed py-4 transition-colors ${
        dragOver ? "border-primary ring-2 ring-primary/40" : ""
      }`}
      onClick={pick}
      {...dropProps}
    >
      <CardContent className="flex items-center gap-3 px-4">
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const files = Array.from(e.currentTarget.files ?? [])
            e.currentTarget.value = ""
            if (files.length > 0) void doPublish(files)
          }}
        />
        <Clock className="size-5 shrink-0 text-muted-foreground" aria-label="share for later" />
        <div className="min-w-0 flex-1">
          <span className="text-sm font-medium">Share for later</span>
          <div className="text-xs text-muted-foreground">
            {busy ? (
              "publishing…"
            ) : notice ? (
              <span
                className={
                  notice.error ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"
                }
              >
                {notice.text}
              </span>
            ) : (
              "offer files your devices can pull anytime · tap or drop"
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

// Floating re-grant prompts (PLAN.md §14.2): a pull found this device's
// persisted file handle back in the "prompt" permission state (it survives
// restarts, the permission doesn't). One click re-authorizes it; the puller
// retries from its side.
function RegrantPromptCards() {
  const regrants = useShares((s) => s.regrants)
  const grant = useShares((s) => s.grant)
  const dismissRegrant = useShares((s) => s.dismissRegrant)

  return (
    <>
      {regrants.map((r) => (
        <Card key={r.sharedFileId} className="border-primary/40 py-4 shadow-lg">
          <CardContent className="flex flex-col gap-2 px-4">
            <p className="text-xs text-muted-foreground">
              A device tried to download a file you shared
            </p>
            <p className="truncate text-sm font-medium" title={r.name}>
              Re-authorize “{r.name}” to keep serving it
            </p>
            <div className="flex gap-2">
              {/* requestPermission runs INSIDE this click (user gesture). */}
              <Button size="sm" className="flex-1" onClick={() => void grant(r.sharedFileId)}>
                Re-authorize
              </Button>
              <Button
                size="sm"
                variant="outline"
                className="flex-1"
                onClick={() => dismissRegrant(r.sharedFileId)}
              >
                Dismiss
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </>
  )
}

// Cross-user session section (PLAN.md §15, §17): the OTHER members' joined
// devices render as drop-target cards — sending to them goes through the
// exact same sendFiles/sendFolders; the server's session-scoped rtc relay
// does the rest. Only the JOINED devices appear, never the other fleet.
function SessionGuestCard({ member }: { member: SessionMemberInfo }) {
  const sendFiles = useTransfers((s) => s.sendFiles)
  const sendFolders = useTransfers((s) => s.sendFolders)
  const transfers = useTransfers((s) => s.transfers)
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)

  const rows = Object.values(transfers).filter((t) => t.peerDeviceId === member.deviceId)
  const canSendTo = member.online

  const { dragOver, dropProps } = useDropTarget(canSendTo, collectDrop, ({ files, folders }) => {
    if (files.length > 0) sendFiles(member.deviceId, files)
    if (folders.length > 0) sendFolders(member.deviceId, folders)
  })

  return (
    <Card
      className={`border-primary/30 bg-background py-4 transition-colors ${
        canSendTo ? "cursor-pointer" : ""
      } ${dragOver ? "border-primary ring-2 ring-primary/40" : ""}`}
      onClick={() => canSendTo && fileInput.current?.click()}
      {...dropProps}
    >
      <CardContent className="flex flex-col gap-2 px-4">
        <HiddenPickers
          fileRef={fileInput}
          folderRef={folderInput}
          onFiles={(files) => sendFiles(member.deviceId, files)}
          onFolders={(folders) => sendFolders(member.deviceId, folders)}
        />
        <div className="flex items-center gap-3">
          <UserRound className="size-5 shrink-0 text-primary/70" aria-label="session guest" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium">{member.deviceName}</span>
              <Badge variant="outline" className="shrink-0 border-primary/40 text-primary">
                {member.userName}
              </Badge>
            </div>
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span
                className={`size-2 shrink-0 rounded-full ${
                  member.online ? "bg-emerald-500 live-dot" : "bg-muted-foreground/40"
                }`}
              />
              {member.online ? "online" : "offline"}
              {canSendTo && (
                <span className="text-muted-foreground/60">· tap or drop files or a folder</span>
              )}
            </div>
          </div>
          {canSendTo && (
            <Button
              size="icon-xs"
              variant="ghost"
              className="shrink-0"
              aria-label={`Send a folder to ${member.deviceName}`}
              onClick={(e) => {
                e.stopPropagation()
                openFolderPicker(folderInput.current, (folders) =>
                  sendFolders(member.deviceId, folders),
                )
              }}
            >
              <FolderUp />
            </Button>
          )}
        </div>
        {rows.length > 0 && (
          <div className="flex flex-col gap-1.5 pt-1" onClick={(e) => e.stopPropagation()}>
            {rows.map((t) => (
              <TransferRow key={t.id} t={t} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SessionSection() {
  const session = useShareSession((s) => s.session)
  const members = useShareSession((s) => s.members)
  const leave = useShareSession((s) => s.leave)
  const end = useShareSession((s) => s.end)
  const myUserId = useSession((s) => s.me?.user.id)
  const [now, setNow] = useState(() => Date.now())

  // Minute-ish countdown granularity is plenty for a 24 h TTL.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const guests = useMemo(() => members.filter((m) => !m.isSelf), [members])

  if (!session) return null
  const isOwner = session.ownerId === myUserId

  const stop = async () => {
    if (isOwner && !confirm("End this session for everyone?")) return
    await (isOwner ? end() : leave())
  }

  return (
    <section className="flex flex-col gap-2 rounded-xl border-2 border-primary/40 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Users className="size-4 shrink-0 text-primary" aria-hidden />
        <h2 className="text-sm font-medium">Session</h2>
        <span className="font-mono text-sm font-semibold tracking-[0.2em]">{session.code}</span>
        <span className="text-xs text-muted-foreground">
          · {sessionTimeLeft(session.expiresAt, now)}
        </span>
        <div className="ml-auto">
          <Button size="sm" variant="outline" onClick={() => void stop()}>
            {isOwner ? "End session" : "Leave"}
          </Button>
        </div>
      </div>
      {guests.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {guests.map((m) => (
            <SessionGuestCard key={m.deviceId} member={m} />
          ))}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Nobody has joined yet — share the code above, or open the header session button for
          the QR.
        </p>
      )}
    </section>
  )
}

// Floating Accept/Reject prompts for incoming files that weren't auto-accepted.
// Accept runs the save picker DIRECTLY in the click handler (user gesture).
function IncomingPromptCards() {
  const transfers = useTransfers((s) => s.transfers)
  const acceptIncoming = useTransfers((s) => s.acceptIncoming)
  const rejectIncoming = useTransfers((s) => s.rejectIncoming)
  const devices = useDevices((s) => s.devices)
  const members = useShareSession((s) => s.members)

  const prompts = Object.values(transfers).filter(
    (t) => t.direction === "recv" && t.status === "awaiting-accept",
  )

  return (
    <>
      {prompts.map((t) => {
        // Session guests aren't in the devices store — label them user · device.
        const guest = members.find((m) => m.deviceId === t.peerDeviceId)
        const sender =
          devices.find((d) => d.id === t.peerDeviceId)?.name ??
          (guest ? `${guest.userName} · ${guest.deviceName}` : "Another device")
        return (
          <Card key={t.id} className="border-primary/40 py-4 shadow-lg">
            <CardContent className="flex flex-col gap-2 px-4">
              <p className="text-xs text-muted-foreground">
                <span className="font-medium text-foreground">{sender}</span> wants to send
              </p>
              <p className="truncate text-sm font-medium" title={t.name}>
                {transferLabel(t)}
                <span className="font-normal text-muted-foreground"> · {fmtBytes(t.size)}</span>
              </p>
              <div className="flex gap-2">
                <Button size="sm" className="flex-1" onClick={() => acceptIncoming(t.id)}>
                  Accept
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-1"
                  onClick={() => rejectIncoming(t.id)}
                >
                  Reject
                </Button>
              </div>
            </CardContent>
          </Card>
        )
      })}
    </>
  )
}

/** One fixed bottom stack so incoming-file and re-grant prompts never overlap. */
function FloatingPrompts() {
  const hasIncoming = useTransfers((s) =>
    Object.values(s.transfers).some(
      (t) => t.direction === "recv" && t.status === "awaiting-accept",
    ),
  )
  const hasRegrants = useShares((s) => s.regrants.length > 0)
  if (!hasIncoming && !hasRegrants) return null

  return (
    <div className="fixed inset-x-4 bottom-4 z-50 mx-auto flex w-auto max-w-sm flex-col gap-2">
      <RegrantPromptCards />
      <IncomingPromptCards />
    </div>
  )
}

// Staged share-target files (PLAN.md §22 Phase 7): when the OS share sheet
// hands Pontje attachments, the SW parks them (stores/pendingShare.ts) and this
// prominent card lets the user route them — to a single device, to all online
// devices at once, or as a pull-able "share for later" offer — reusing the very
// same sendFiles / sendToAll / publish primitives the rest of the view uses.
function PendingShareCard() {
  const files = usePendingShare((s) => s.files)
  const clear = usePendingShare((s) => s.clear)
  const devices = useDevices((s) => s.devices)
  const sendFiles = useTransfers((s) => s.sendFiles)
  const sendToAll = useTransfers((s) => s.sendToAll)
  const publish = useShares((s) => s.publish)
  const [busy, setBusy] = useState(false)
  const thisId = deviceId()

  if (files.length === 0) return null

  const targets = devices.filter((d) => d.online && d.id !== thisId)
  const totalBytes = files.reduce((sum, f) => sum + f.size, 0)
  const label = files.length === 1 ? files[0].name : `${files.length} files`

  // Sends are fire-and-forget (the engine drives them) → take + clear in one go.
  const sendTo = (id: string) => sendFiles(id, takePendingShareFiles())
  const beamAll = () => sendToAll(takePendingShareFiles(), [])
  // Publish can fail (no room to stash) — keep the card so a device send can be
  // retried instead, so clear only on success.
  const shareForLater = async () => {
    setBusy(true)
    const { error } = await publish(files)
    setBusy(false)
    if (!error) clear()
  }

  return (
    <Card className="border-primary/50 bg-primary/5">
      <CardContent className="flex flex-col gap-3 px-4">
        <div className="flex items-start gap-3">
          <Share2 className="size-5 shrink-0 text-primary" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">Shared from another app</p>
            <p
              className="truncate text-xs text-muted-foreground"
              title={files.map((f) => f.name).join(", ")}
            >
              {label} · {fmtBytes(totalBytes)}
            </p>
          </div>
          <Button size="icon-xs" variant="ghost" aria-label="Dismiss shared files" onClick={clear}>
            <X />
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {targets.map((d) => (
            <Button
              key={d.id}
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => sendTo(d.id)}
            >
              <Send /> {d.name}
            </Button>
          ))}
          {targets.length > 1 && (
            <Button size="sm" variant="secondary" disabled={busy} onClick={beamAll}>
              <MonitorSmartphone /> All devices
            </Button>
          )}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void shareForLater()}>
            <Clock /> {busy ? "Sharing…" : "Share for later"}
          </Button>
        </div>
        {targets.length === 0 && (
          <p className="text-xs text-muted-foreground">
            No other devices online — “Share for later” offers these for any device to pull.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export default function DevicesView() {
  const devices = useDevices((s) => s.devices)
  const needsNaming = useDevices((s) => s.needsNaming)
  const autoAccept = useTransfers((s) => s.autoAccept)
  const setAutoAccept = useTransfers((s) => s.setAutoAccept)
  const [qrOpen, setQrOpen] = useState(false)
  const thisId = deviceId()

  return (
    <div className="flex flex-col gap-3">
      <PendingShareCard />

      {needsNaming && <NameThisDeviceCard />}

      <SessionSection />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium text-muted-foreground">Your devices</h2>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="accent-primary"
              checked={autoAccept}
              onChange={(e) => setAutoAccept(e.target.checked)}
            />
            Auto-accept from my devices
          </label>
          <Button size="sm" variant="outline" onClick={() => setQrOpen(true)}>
            <QrCode /> Link a device
          </Button>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        {devices.length > 0 && <AllDevicesCard />}
        {/* Publishing requires THIS device to be registered (offers are tagged
            from_device) — hidden during first-run naming. */}
        {devices.some((d) => d.id === thisId) && <ShareForLaterCard />}
        {devices.map((d) => (
          <DeviceCard key={d.id} device={d} isThis={d.id === thisId} />
        ))}
      </div>

      {devices.length === 0 && !needsNaming && (
        <EmptyState icon={MonitorSmartphone}>
          No devices yet — register this one or link another with the QR button above.
        </EmptyState>
      )}

      {qrOpen && <QrLinkDialog onClose={() => setQrOpen(false)} />}

      <FloatingPrompts />
    </div>
  )
}
