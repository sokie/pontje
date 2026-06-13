import { Navigate } from "react-router-dom"

// Share-target landing (PLAN.md §16). The service worker normally intercepts
// the POST and 303s to /?share=1 itself; this SPA route only catches the
// cold-start fallback (Caddy `redir /share / 303` → GET) or a direct visit.
export default function SharePage() {
  return <Navigate to="/?share=1" replace />
}
