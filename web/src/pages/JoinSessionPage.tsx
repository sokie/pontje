// Session join flow (PLAN.md §15): /join#c=K3M7PD from a scanned QR. Reads
// the code from the fragment, scrubs it via replaceState, and renders inside
// AuthGate — an anonymous scanner signs in first (Google or a QR-linked
// device, both fine). The page then confirms "Join <code>?", registering this
// browser as a device first when needed (a member must be addressable).

import { useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"
import { Users } from "lucide-react"

import { AuthGate } from "@/components/AuthGate"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { defaultDeviceName, deviceId } from "@/lib/device"
import { useDevices } from "@/stores/devices"
import { useSession } from "@/stores/session"
import { useShareSession } from "@/stores/shareSession"
import { useUi } from "@/stores/ui"

// Read the fragment exactly once per page load (StrictMode double-mounts
// would otherwise find an already-scrubbed URL on the second pass). The code
// is ALSO stashed in sessionStorage: a Google sign-in is a full-page redirect
// that lands back on "/" — the stash lets MainScreen route the user back here
// to finish joining (pendingJoinCode / clearPendingJoin).
const PENDING_JOIN_KEY = "pontje.pendingJoinCode"

let scannedCode: string | null | undefined

function takeCode(): string | null {
  if (scannedCode === undefined) {
    const raw = new URLSearchParams(location.hash.replace(/^#/, "")).get("c")
    scannedCode = raw ? raw.trim().toUpperCase() : null
    if (location.hash) history.replaceState(null, "", location.pathname)
    try {
      if (scannedCode) sessionStorage.setItem(PENDING_JOIN_KEY, scannedCode)
      else scannedCode = sessionStorage.getItem(PENDING_JOIN_KEY) // OAuth round-trip
    } catch {
      // storage unavailable — the manual code input still works
    }
  }
  return scannedCode
}

export function pendingJoinCode(): string | null {
  try {
    return sessionStorage.getItem(PENDING_JOIN_KEY)
  } catch {
    return null
  }
}

export function clearPendingJoin(): void {
  try {
    sessionStorage.removeItem(PENDING_JOIN_KEY)
  } catch {
    // nothing to clear
  }
}

function JoinInner() {
  const navigate = useNavigate()
  const me = useSession((s) => s.me)
  const registerThisDevice = useDevices((s) => s.registerThisDevice)
  const join = useShareSession((s) => s.join)

  const [code, setCode] = useState(() => takeCode() ?? "")
  const hadCode = takeCode() !== null
  // This browser must be a registered device before it can join.
  const needsDevice = !me?.device_id || me.device_id !== deviceId()
  const [name, setName] = useState(() => defaultDeviceName())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    if (needsDevice) {
      const regErr = await registerThisDevice(name)
      if (regErr) {
        setError(regErr)
        setBusy(false)
        return
      }
    }
    const joinErr = await join(code)
    setBusy(false)
    if (joinErr) {
      setError(joinErr)
      return
    }
    clearPendingJoin()
    useUi.getState().setTab("devices") // land on the session section
    navigate("/", { replace: true })
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">⛴️ Pontje</CardTitle>
          <CardDescription>
            <span className="inline-flex items-center gap-1.5">
              <Users className="size-4" /> Joining a share session
            </span>
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form className="flex flex-col gap-3" onSubmit={submit}>
            {hadCode ? (
              <p className="text-sm">
                Join the{" "}
                <span className="font-mono text-base font-semibold tracking-[0.2em]">
                  {code}
                </span>{" "}
                session? Only this device is shared with the other side — never your other
                devices.
              </p>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  This link is missing its code — type the 6 characters instead.
                </p>
                <input
                  value={code}
                  onChange={(e) => setCode(e.target.value.toUpperCase())}
                  maxLength={6}
                  placeholder="K3M7PD"
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  className="rounded-md border bg-background px-3 py-2 text-center font-mono text-lg tracking-[0.3em] uppercase"
                  aria-label="Session code"
                  autoFocus
                />
              </>
            )}

            {needsDevice && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-muted-foreground" htmlFor="join-device-name">
                  First time here — name this device for the session:
                </label>
                <input
                  id="join-device-name"
                  className="rounded-md border bg-background px-3 py-2 text-sm"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={64}
                />
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={busy || code.trim().length !== 6}>
              {busy ? "Joining…" : "Join session"}
            </Button>
            <Button asChild variant="ghost">
              <a href="/" onClick={clearPendingJoin}>
                Not now
              </a>
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

export default function JoinSessionPage() {
  takeCode() // scrub the fragment even while the login screen shows
  return (
    <AuthGate>
      <JoinInner />
    </AuthGate>
  )
}
