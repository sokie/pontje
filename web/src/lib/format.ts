/** 1234567 → "1.2 MB" (binary units, short labels for tight transfer rows). */
export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B"
  if (n < 1024) return `${Math.round(n)} B`
  const units = ["KB", "MB", "GB", "TB"]
  let value = n
  let i = -1
  do {
    value /= 1024
    i += 1
  } while (value >= 1024 && i < units.length - 1)
  return `${value >= 100 ? Math.round(value).toString() : value.toFixed(1)} ${units[i]}`
}
