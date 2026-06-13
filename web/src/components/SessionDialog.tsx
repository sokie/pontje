// Cross-user session dialog (PLAN.md §15, §17): start a session (big 6-char
// code + client-rendered QR of the /join URL + expiry countdown + live member
// list) or join with a code; while active, End (owner) / Leave (guest).

import { useEffect, useState, type FormEvent } from "react"
import { Check, Copy, Crown, Users } from "lucide-react"
import QRCode from "qrcode"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { parseUtc } from "@/lib/time"
import { useSession } from "@/stores/session"
import { useShareSession, type SessionMemberInfo } from "@/stores/shareSession"

// Like QrLinkDialog: encode the origin THIS browser is on — the scanning
// phone can only reach the origin you're actually using.
export const joinUrlFor = (code: string) => `${location.origin}/join#c=${code}`

export function sessionTimeLeft(expiresAt: string, now: number): string {
  const left = parseUtc(expiresAt).getTime() - now
  if (left <= 0) return "expired"
  const totalMinutes = Math.floor(left / 60_000)
  const hours = Math.floor(totalMinutes / 60)
  if (hours >= 1) return `${hours} h ${totalMinutes % 60} m left`
  if (totalMinutes >= 1) return `${totalMinutes} m left`
  return `${Math.ceil(left / 1000)} s left`
}

export function MemberRow({ member, ownerId }: { member: SessionMemberInfo; ownerId: number }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={`size-2 shrink-0 rounded-full ${
          member.online ? "bg-emerald-500" : "bg-muted-foreground/40"
        }`}
        title={member.online ? "online" : "offline"}
      />
      <span className="min-w-0 flex-1 truncate">
        <span className="font-medium">{member.userName}</span>
        <span className="text-muted-foreground"> · {member.deviceName}</span>
      </span>
      {member.userId === ownerId && (
        <Crown className="size-3.5 shrink-0 text-amber-500" aria-label="session owner" />
      )}
      {member.isSelf && <span className="shrink-0 text-xs text-muted-foreground">you</span>}
    </div>
  )
}

function ActiveSessionPanel({ onClose }: { onClose: () => void }) {
  const session = useShareSession((s) => s.session)
  const members = useShareSession((s) => s.members)
  const leave = useShareSession((s) => s.leave)
  const end = useShareSession((s) => s.end)
  const myUserId = useSession((s) => s.me?.user.id)
  const [qr, setQr] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const code = session?.code ?? null

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!code) return
    let alive = true
    void QRCode.toDataURL(joinUrlFor(code), { width: 512, margin: 1 }).then(
      (url) => alive && setQr(url),
      () => undefined, // QR failure — the big code still works
    )
    return () => {
      alive = false
    }
  }, [code])

  if (!session) return null
  const isOwner = session.ownerId === myUserId

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrlFor(session.code))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable — the code is on screen
    }
  }

  const stop = async () => {
    if (isOwner && !confirm("End this session for everyone?")) return
    setBusy(true)
    setError(null)
    const err = await (isOwner ? end() : leave())
    setBusy(false)
    if (err) setError(err)
    else onClose()
  }

  return (
    <CardContent className="flex flex-col items-center gap-3">
      <p
        className="font-mono text-4xl font-bold tracking-[0.3em]"
        aria-label={`Session code ${session.code.split("").join(" ")}`}
      >
        {session.code}
      </p>
      {qr ? (
        <img src={qr} alt="Session join QR code" className="size-48 rounded-md bg-white p-2" />
      ) : (
        <div className="size-48 animate-pulse rounded-md bg-muted" />
      )}
      <p className="text-xs text-muted-foreground">
        Scan to join · {sessionTimeLeft(session.expiresAt, now)}
      </p>

      <div className="flex w-full flex-col gap-1.5 rounded-md border p-2.5">
        {members.map((m) => (
          <MemberRow key={m.deviceId} member={m} ownerId={session.ownerId} />
        ))}
        {members.length === 1 && (
          <p className="text-xs text-muted-foreground">
            Waiting for someone to join — share the code or QR.
          </p>
        )}
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex w-full gap-2">
        <Button variant="outline" className="flex-1" onClick={() => void copy()}>
          {copied ? <Check /> : <Copy />} Copy link
        </Button>
        <Button variant="destructive" className="flex-1" disabled={busy} onClick={() => void stop()}>
          {isOwner ? "End session" : "Leave"}
        </Button>
      </div>
    </CardContent>
  )
}

function StartOrJoinPanel() {
  const create = useShareSession((s) => s.create)
  const join = useShareSession((s) => s.join)
  const [code, setCode] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setBusy(true)
    setError(null)
    const err = await create()
    setBusy(false)
    if (err) setError(err)
  }

  const submitJoin = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const err = await join(code)
    setBusy(false)
    if (err) setError(err)
  }

  return (
    <CardContent className="flex flex-col gap-4">
      <Button className="w-full" disabled={busy} onClick={() => void start()}>
        <Users /> Start a session
      </Button>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        or join with a code
        <span className="h-px flex-1 bg-border" />
      </div>

      <form className="flex gap-2" onSubmit={submitJoin}>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          maxLength={6}
          placeholder="K3M7PD"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-center font-mono text-lg tracking-[0.3em] uppercase"
          aria-label="Session code"
        />
        <Button type="submit" variant="secondary" disabled={busy || code.trim().length !== 6}>
          Join
        </Button>
      </form>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </CardContent>
  )
}

export function SessionDialog({ onClose }: { onClose: () => void }) {
  const active = useShareSession((s) => s.session !== null)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle>{active ? "Session" : "Share with someone"}</CardTitle>
          <CardDescription>
            {active
              ? "Anyone with the code joins with ONE device — only that device is shared."
              : "A temporary bridge to another Pontje account: files, links and clips. Expires after 24 h."}
          </CardDescription>
        </CardHeader>
        {active ? <ActiveSessionPanel onClose={onClose} /> : <StartOrJoinPanel />}
        <CardContent className="pt-0">
          <Button variant="secondary" className="w-full" onClick={onClose}>
            Done
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
