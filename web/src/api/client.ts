import createClient from "openapi-fetch"

import type { paths } from "./schema"

// Every request carries X-Pontje: 1 — the CSRF header required on
// cookie-authenticated mutations (PLAN.md §7.1).
export const api = createClient<paths>({
  headers: { "X-Pontje": "1" },
})
