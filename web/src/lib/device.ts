const KEY = "pontje.deviceId"

export function deviceId(): string {
  let id = localStorage.getItem(KEY)
  if (!id) {
    id = randomUuid()
    localStorage.setItem(KEY, id)
  }
  return id
}

function randomUuid(): string {
  // crypto.randomUUID only exists in secure contexts; LAN-IP dev
  // (http://192.168.x.y:5173, phone QR testing) needs the manual v4 path.
  // getRandomValues is available everywhere.
  const c = crypto as Crypto & { randomUUID?: () => string }
  if (typeof c.randomUUID === "function") return c.randomUUID()
  const bytes = c.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export function guessPlatform(): string {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes("android")) return "android"
  if (ua.includes("mac")) return "mac"
  if (ua.includes("windows")) return "windows"
  if (ua.includes("linux")) return "linux"
  return "other"
}

export function defaultDeviceName(): string {
  const platform = guessPlatform()
  const pretty: Record<string, string> = {
    android: "Android",
    mac: "Mac",
    windows: "Windows PC",
    linux: "Linux",
    other: "Device",
  }
  const ua = navigator.userAgent
  const browser = ua.includes("Firefox")
    ? "Firefox"
    : ua.includes("Edg")
      ? "Edge"
      : ua.includes("Chrome")
        ? "Chrome"
        : ua.includes("Safari")
          ? "Safari"
          : ""
  return browser ? `${pretty[platform]} · ${browser}` : pretty[platform]
}
