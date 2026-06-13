import { Component, type ReactNode } from "react"

import { Button } from "@/components/ui/button"

// A render error inside a view should degrade to a reload card, never a
// blank page.
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="flex flex-col items-center gap-3 p-8 text-center">
        <p className="text-sm font-medium">Something broke while rendering this view.</p>
        <p className="max-w-sm font-mono text-xs break-all text-muted-foreground">
          {this.state.error.message}
        </p>
        <Button size="sm" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    )
  }
}
