// QR device-link claim flow (PLAN.md §7.3): read #lt= token, scrub it from the
// URL, claim it, then name + register this device.

import { useEffect, useState, type FormEvent } from "react"
import { useNavigate } from "react-router-dom"

import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { defaultDeviceName } from "@/lib/device"
import { useDevices } from "@/stores/devices"
import { useSession } from "@/stores/session"

type ClaimResult = { ok: true } | { ok: false; status: number }

// Claim exactly once per page load, even under StrictMode's double-mounted
// effects — the second run reuses the in-flight promise. (A real QR scan is
// always a fresh document load, so module state starts clean.)
let claimPromise: Promise<ClaimResult> | null = null

function claimFromHash(): Promise<ClaimResult> {
  if (claimPromise) return claimPromise
  const token = new URLSearchParams(location.hash.replace(/^#/, "")).get("lt")
  // Scrub the token from the URL bar/history immediately (PLAN.md §7.3).
  history.replaceState(null, "", location.pathname)
  if (!token) return Promise.resolve({ ok: false, status: 0 })
  claimPromise = (async (): Promise<ClaimResult> => {
    try {
      const { error, response } = await api.POST("/api/v1/auth/device-link/claim", {
        body: { token },
      })
      if (error) return { ok: false, status: response?.status ?? 500 }
      return { ok: true }
    } catch {
      return { ok: false, status: 500 }
    }
  })()
  return claimPromise
}

type Phase = "claiming" | "name" | "missing" | "expired" | "throttled" | "error"

export default function LinkClaimPage() {
  const [phase, setPhase] = useState<Phase>("claiming")
  const [name, setName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const navigate = useNavigate()
  const fetchMe = useSession((s) => s.fetchMe)
  const registerThisDevice = useDevices((s) => s.registerThisDevice)

  useEffect(() => {
    let alive = true
    void claimFromHash().then(async (res) => {
      if (!alive) return
      if (res.ok) {
        await fetchMe() // the claim set our session cookie
        if (!alive) return
        setName(defaultDeviceName())
        setPhase("name")
      } else if (res.status === 0) setPhase("missing")
      else if (res.status === 410) setPhase("expired")
      else if (res.status === 429) setPhase("throttled")
      else setPhase("error")
    })
    return () => {
      alive = false
    }
  }, [fetchMe])

  const submitName = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const err = await registerThisDevice(name)
    if (err) {
      setError(err)
      setBusy(false)
      return
    }
    navigate("/", { replace: true })
  }

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">⛴️ Pontje</CardTitle>
          <CardDescription>Linking this device</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {phase === "claiming" && (
            <p className="text-sm text-muted-foreground">Checking your link code…</p>
          )}

          {phase === "name" && (
            <form className="flex flex-col gap-3" onSubmit={submitName}>
              <div>
                <p className="text-sm font-medium">You're in! Name this device</p>
                <p className="text-xs text-muted-foreground">
                  Your other devices will see it under this name.
                </p>
              </div>
              <input
                className="rounded-md border bg-background px-3 py-2 text-sm"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
                maxLength={64}
              />
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button type="submit" disabled={busy}>
                {busy ? "Registering…" : "Continue"}
              </Button>
            </form>
          )}

          {phase === "missing" && (
            <Trouble msg="This link is incomplete — scan the QR code from your other device again." />
          )}
          {phase === "expired" && (
            <Trouble msg="QR code expired or already used — generate a fresh one on your other device." />
          )}
          {phase === "throttled" && (
            <Trouble msg="Too many attempts from this network — wait a minute, then scan a fresh QR code." />
          )}
          {phase === "error" && (
            <Trouble msg="Something went wrong while linking. Generate a fresh QR code and try again." />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Trouble({ msg }: { msg: string }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-destructive">{msg}</p>
      <Button asChild variant="secondary">
        <a href="/">Go to the app</a>
      </Button>
    </div>
  )
}
