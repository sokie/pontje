// Server timestamps are naive UTC ISO strings (no offset) — re-attach Z.
export function parseUtc(s: string): Date {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(s) ? s : s + "Z")
}

/** Day bucket for grouped lists: Today / Yesterday / "Mon 8 Jun". */
export function dayLabel(iso: string): string {
  const date = parseUtc(iso)
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86_400_000)
  if (diffDays <= 0) return "Today"
  if (diffDays === 1) return "Yesterday"
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })
}

export function timeAgo(s: string): string {
  const diffMs = Date.now() - parseUtc(s).getTime()
  const min = Math.round(diffMs / 60_000)
  if (min < 1) return "just now"
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `${h} h ago`
  return parseUtc(s).toLocaleDateString()
}
