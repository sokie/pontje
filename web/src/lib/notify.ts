// Module-scope toast wiring (PLAN.md §17), imported once for side effects from
// main.tsx. Lives outside the React tree (engine-outside-tree discipline, §5):
// it listens to the WS bus and the transfers store directly, so a device
// linking or a file arriving is surfaced from whatever tab you're on.

import { onWs } from "@/lib/ws/bus"
import { useTransfers } from "@/stores/transfers"
import { toast } from "@/stores/toast"

// A second device finished claiming a device-link QR.
onWs("device-linked", (msg) => {
  const name = typeof msg.deviceName === "string" ? msg.deviceName : "A device"
  toast(`${name} linked`, { description: "Signed in on another device", tone: "success" })
})

// Surface transfer outcomes the cards can't show when you're on another tab:
// an incoming file that finished saving, or any transfer that failed.
useTransfers.subscribe((state, prev) => {
  for (const id in state.transfers) {
    const cur = state.transfers[id]
    const before = prev.transfers[id]
    if (!before || before.status === cur.status) continue
    if (cur.status === "done" && cur.direction === "recv") {
      toast(`Received ${cur.name}`, { tone: "success" })
    } else if (cur.status === "failed") {
      toast("Transfer failed", { description: cur.name, tone: "error" })
    }
  }
})
