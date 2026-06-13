// Shared empty state (PLAN.md §17: "empty states that teach"). A framed icon
// over a short instruction, used across every view so first-run reads as one
// designed surface rather than scattered grey paragraphs.

import type { ComponentType, ReactNode } from "react"

export function EmptyState({
  icon: Icon,
  children,
}: {
  icon: ComponentType<{ className?: string }>
  children: ReactNode
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <div className="rounded-full border border-border/60 bg-muted/40 p-3 text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <p className="max-w-xs text-sm text-muted-foreground">{children}</p>
    </div>
  )
}
