import { useEffect, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { useSession } from "@/stores/session"

export function AuthGate({ children }: { children: ReactNode }) {
  const status = useSession((s) => s.status)
  const fetchMe = useSession((s) => s.fetchMe)

  useEffect(() => {
    void fetchMe()
  }, [fetchMe])

  if (status === "loading") {
    return (
      <div className="flex min-h-svh items-center justify-center text-muted-foreground">
        ⛴️ …
      </div>
    )
  }
  if (status === "anon") return <LoginScreen />
  return <>{children}</>
}

function LoginScreen() {
  const devLogin = useSession((s) => s.devLogin)
  const [email, setEmail] = useState("")
  const [error, setError] = useState<string | null>(null)

  const params = new URLSearchParams(location.search)
  const loginError = params.get("error")

  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-2xl">⛴️ Pontje</CardTitle>
          <CardDescription>
            Self-hosted P2P file, link &amp; clipboard relay between your devices.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {loginError === "not_allowed" && (
            <p className="text-sm text-destructive">
              That Google account isn't on the allowlist.
            </p>
          )}
          <Button asChild className="w-full">
            <a href="/api/v1/auth/login">Continue with Google</a>
          </Button>
          {import.meta.env.DEV && (
            <form
              className="flex flex-col gap-2 border-t pt-3"
              onSubmit={(e) => {
                e.preventDefault()
                void devLogin(email).then(setError)
              }}
            >
              <p className="text-xs text-muted-foreground">
                Dev login (requires PONTJE_DEV_FAKE_LOGIN=1)
              </p>
              <input
                className="rounded-md border bg-background px-3 py-2 text-sm"
                placeholder="allowlisted@email.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Button type="submit" variant="secondary">
                Dev login
              </Button>
              {error && <p className="text-sm text-destructive">{error}</p>}
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
