// "Link a device" QR dialog (PLAN.md §7.3, §17): mints a one-time link token,
// renders it as a QR, counts down its 60 s TTL and silently re-mints while open.

import { useEffect, useState } from "react"
import { Check, Copy } from "lucide-react"
import QRCode from "qrcode"

import { api } from "@/api/client"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { parseUtc } from "@/lib/time"

type DeviceLink = { token: string; expires_at: string; link_url: string }

// Encode the origin THIS browser is using, not the server's link_url (built
// from PONTJE_PUBLIC_BASE_URL): in dev you may be browsing the LAN IP while
// the server's base URL stays localhost for Google OAuth — the claiming
// device can only reach the origin you're actually on. In prod they're equal.
const linkUrlFor = (token: string) => `${location.origin}/link#lt=${token}`

// Module-scope dedupe: StrictMode double-mounts effects in dev, and the mint
// budget is 10/hour — don't burn two tokens per dialog open.
let lastMint: { at: number; data: DeviceLink } | null = null

async function mintDeviceLink(): Promise<DeviceLink | null> {
  if (lastMint && Date.now() - lastMint.at < 2000) return lastMint.data
  try {
    const { data, error } = await api.POST("/api/v1/auth/device-link")
    if (error || !data) return null
    lastMint = { at: Date.now(), data }
    return data
  } catch {
    return null
  }
}

const REMINT_EVERY_MS = 50_000 // < 60 s TTL → a scannable code at all times

export function QrLinkDialog({ onClose }: { onClose: () => void }) {
  const [link, setLink] = useState<DeviceLink | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)

  // Mint on open, re-mint while open; closing unmounts and stops the interval.
  useEffect(() => {
    let alive = true
    const mint = async () => {
      const data = await mintDeviceLink()
      if (!alive) return
      if (data) {
        setLink(data)
        setFailed(false)
      } else {
        setFailed(true)
      }
    }
    void mint()
    const timer = setInterval(() => void mint(), REMINT_EVERY_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  // 1 s countdown tick.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // Render the QR whenever the link rotates.
  useEffect(() => {
    if (!link) return
    let alive = true
    void QRCode.toDataURL(linkUrlFor(link.token), { width: 512, margin: 1 }).then(
      (url) => {
        if (alive) setQr(url)
      },
      () => {
        if (alive) setFailed(true)
      },
    )
    return () => {
      alive = false
    }
  }, [link])

  const secondsLeft = link
    ? Math.max(0, Math.ceil((parseUtc(link.expires_at).getTime() - now) / 1000))
    : null

  const copy = async () => {
    if (!link) return
    try {
      await navigator.clipboard.writeText(linkUrlFor(link.token))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard unavailable — the URL is selectable in the input
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <Card className="w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
        <CardHeader>
          <CardTitle>Link a device</CardTitle>
          <CardDescription>
            Scan this with the new device — it signs in without touching Google.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          {qr ? (
            <img
              src={qr}
              alt="Device link QR code"
              className="size-56 rounded-md bg-white p-2"
            />
          ) : (
            <div className="size-56 animate-pulse rounded-md bg-muted" />
          )}

          {failed ? (
            <p className="text-center text-xs text-destructive">
              Couldn't create a link code (rate limited?). Close and try again later.
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {secondsLeft !== null
                ? `Code expires in ${secondsLeft} s — refreshes automatically`
                : "Creating a fresh code…"}
            </p>
          )}

          <div className="flex w-full items-center gap-2">
            <input
              readOnly
              value={link ? linkUrlFor(link.token) : ""}
              onFocus={(e) => e.currentTarget.select()}
              className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1.5 text-xs text-muted-foreground"
            />
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => void copy()}
              disabled={!link}
              aria-label="Copy link URL"
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>

          <Button variant="secondary" className="w-full" onClick={onClose}>
            Done
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
