import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

// Self-hosted variable fonts (bundled, offline-friendly — PLAN.md §17).
import "@fontsource-variable/hanken-grotesk"
import "@fontsource-variable/jetbrains-mono"

import App from "./App"
import "./index.css"
// Module-scope toast wiring (device-linked + transfer outcomes, PLAN.md §17).
import "./lib/notify"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
