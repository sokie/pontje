// Robust clipboard copy. The async Clipboard API (navigator.clipboard) only
// exists in *secure* contexts — over plain HTTP on a LAN IP (the phone hitting
// http://10.80.40.20) it's undefined, so navigator.clipboard.writeText throws
// synchronously and the copy silently no-ops. That's the "copy icon does
// nothing on mobile" bug. We try the modern API when it's actually available,
// then fall back to the legacy execCommand path which works on insecure
// origins. Returns whether the copy succeeded so callers can show real
// feedback instead of a fake checkmark.
export async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // Permission denied / document not focused / blocked — drop to legacy.
  }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  const ta = document.createElement("textarea")
  ta.value = text
  // Stay inside the viewport (off-screen elements break selection on iOS) but
  // invisible and non-disruptive.
  Object.assign(ta.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "1px",
    height: "1px",
    padding: "0",
    border: "none",
    outline: "none",
    boxShadow: "none",
    background: "transparent",
    fontSize: "16px", // keeps iOS from zooming/scrolling to it
  })
  document.body.appendChild(ta)

  const selection = document.getSelection()
  const saved = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  try {
    if (/ipad|iphone|ipod/i.test(navigator.userAgent)) {
      // iOS Safari ignores textarea.select(); select via a Range instead.
      ta.contentEditable = "true"
      ta.readOnly = false
      const range = document.createRange()
      range.selectNodeContents(ta)
      selection?.removeAllRanges()
      selection?.addRange(range)
      ta.setSelectionRange(0, text.length)
    } else {
      ta.select()
    }
    return document.execCommand("copy")
  } catch {
    return false
  } finally {
    if (saved && selection) {
      selection.removeAllRanges()
      selection.addRange(saved) // restore the user's prior selection
    }
    document.body.removeChild(ta)
  }
}
