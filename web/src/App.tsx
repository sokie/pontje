import { useEffect, useState } from "react"
import { BrowserRouter, Route, Routes, useNavigate } from "react-router-dom"
import { ClipboardList, FolderDown, Link2, MonitorSmartphone, Users } from "lucide-react"

import { AuthGate } from "@/components/AuthGate"
import { ErrorBoundary } from "@/components/ErrorBoundary"
import { InstallHint } from "@/components/InstallHint"
import { SessionDialog } from "@/components/SessionDialog"
import { Toaster } from "@/components/Toaster"
import { Button } from "@/components/ui/button"
import JoinSessionPage, { pendingJoinCode } from "@/pages/JoinSessionPage"
import LinkClaimPage from "@/pages/LinkClaimPage"
import SharePage from "@/pages/SharePage"
import { useDevices } from "@/stores/devices"
import { consumePendingShare } from "@/stores/pendingShare"
import { useSession } from "@/stores/session"
import { useShareSession } from "@/stores/shareSession"
import { useUi, type TabKey } from "@/stores/ui"
import ClipsView from "@/views/ClipsView"
import DevicesView from "@/views/DevicesView"
import FilesView from "@/views/FilesView"
import LinksView from "@/views/LinksView"

const TABS: { key: TabKey; label: string; icon: typeof Link2 }[] = [
  { key: "devices", label: "Devices", icon: MonitorSmartphone },
  { key: "files", label: "Files", icon: FolderDown },
  { key: "links", label: "Links", icon: Link2 },
  { key: "clips", label: "Clips", icon: ClipboardList },
]

function MainScreen() {
  const tab = useUi((s) => s.tab)
  const setTab = useUi((s) => s.setTab)
  const ensure = useDevices((s) => s.ensureRegisteredAndConnected)
  const logout = useSession((s) => s.logout)
  const me = useSession((s) => s.me)
  const sessionActive = useShareSession((s) => s.session !== null)
  const [sessionOpen, setSessionOpen] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    // Stage any files the OS share sheet handed us (PLAN.md §22 Phase 7) —
    // they surface as a card on Devices. Runs first so the files survive even
    // if a pending join navigates us away below.
    void consumePendingShare()
    // A scanned /join#c=… interrupted by the Google sign-in redirect lands
    // back on "/" — resume the join flow (JoinSessionPage stashed the code).
    if (pendingJoinCode()) {
      navigate("/join", { replace: true })
      return
    }
    void ensure()
    // The session button/section needs the current state even before the
    // first session-state push (WS connects only after registration).
    void useShareSession.getState().load()
  }, [ensure, navigate])

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-2xl flex-col p-4">
      <Toaster />
      <header className="mb-4 flex items-center justify-between">
        <h1 className="flex items-center gap-1.5 text-lg font-semibold tracking-tight">
          <span aria-hidden>⛴️</span>
          <span className="bg-gradient-to-r from-foreground to-primary bg-clip-text text-transparent">
            Pontje
          </span>
        </h1>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            aria-label={sessionActive ? "Share session (active)" : "Share session"}
            className={sessionActive ? "text-primary" : "text-muted-foreground"}
            onClick={() => setSessionOpen(true)}
          >
            <Users />
            {sessionActive && <span className="size-1.5 rounded-full bg-primary" aria-hidden />}
          </Button>
          <span className="text-xs text-muted-foreground">{me?.user.email}</span>
          <Button variant="ghost" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>

      {sessionOpen && <SessionDialog onClose={() => setSessionOpen(false)} />}

      <InstallHint />

      <nav className="mb-4 grid grid-cols-4 gap-1 rounded-xl border border-border/60 bg-muted/60 p-1">
        {TABS.map((t) => {
          const Icon = t.icon
          const active = tab === t.key
          return (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              aria-current={active ? "page" : undefined}
              className={`flex items-center justify-center gap-1.5 rounded-lg px-2 py-1.5 text-xs transition-all active:scale-[0.97] sm:text-sm ${
                active
                  ? "bg-card font-medium text-foreground shadow-sm ring-1 ring-border/70"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className={`size-4 shrink-0 ${active ? "text-primary" : ""}`} aria-hidden />
              {t.label}
            </button>
          )
        })}
      </nav>

      <main className="flex-1">
        <ErrorBoundary>
          {tab === "devices" && <DevicesView />}
          {tab === "files" && <FilesView />}
          {tab === "links" && <LinksView />}
          {tab === "clips" && <ClipsView />}
        </ErrorBoundary>
      </main>
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/link" element={<LinkClaimPage />} />
        <Route path="/join" element={<JoinSessionPage />} />
        <Route path="/share" element={<SharePage />} />
        <Route
          path="/*"
          element={
            <AuthGate>
              <MainScreen />
            </AuthGate>
          }
        />
      </Routes>
    </BrowserRouter>
  )
}
