import { acquireElectronDebugger } from './electron-debugger-lease'
import { errorMessage } from '../../shared/error-message'

/** A trackpad pinch over a page; x and y are fractions of the page's width and height. */
export type BrowserPagePinch = { deltaY: number; x: number; y: number }

// Chromium's own pinch limits (blink web_preferences.h).
const MAX_PINCH_SCALE = process.platform === 'darwin' ? 3 : 4
// Why: a wheel this far outside the viewport hits no element, so only the visual viewport pans and the page sees no wheel event.
const VIEWPORT_ONLY_WHEEL_POINT = 100_000

// Why: holding the debugger for a whole gesture avoids an attach/detach per wheel event.
const LEASE_IDLE_MS = 1_000

type PendingPinch = {
  reset: boolean
  pinch: BrowserPagePinch | null
  running: boolean
  release: (() => void) | null
  idleTimer: ReturnType<typeof setTimeout> | null
}

const pendingByGuest = new WeakMap<Electron.WebContents, PendingPinch>()

export function enableGuestPinchZoom(guest: Electron.WebContents): void {
  const embedder = guest.hostWebContents
  if (!embedder) {
    return
  }
  // Why no await: the limits land in the guest's prefs at once; the promise only waits for its renderer, which may not exist yet.
  guest.setVisualZoomLevelLimits(1, MAX_PINCH_SCALE).catch(() => {})
  // Why: Electron copies a guest's limits onto its embedder, which would let pinch zoom Orca's own UI.
  embedder.setVisualZoomLevelLimits(1, 1).catch(() => {})
}

// Why: Chromium hands a pinch over a <webview> to the embedder, so Orca applies it to the guest's visual viewport.
export function pinchGuestPage(guest: Electron.WebContents, pinch: BrowserPagePinch): void {
  schedule(guest, (pending) => {
    pending.pinch = pending.pinch
      ? { ...pinch, deltaY: pending.pinch.deltaY + pinch.deltaY }
      : pinch
  })
}

// Reset zoom clears the pinch too, as Chrome does; it runs after an in-flight pinch so it wins.
export function resetGuestPinchZoom(guest: Electron.WebContents): void {
  schedule(guest, (pending) => {
    pending.reset = true
    pending.pinch = null
  })
}

function schedule(guest: Electron.WebContents, update: (pending: PendingPinch) => void): void {
  let pending = pendingByGuest.get(guest)
  if (!pending) {
    pending = { reset: false, pinch: null, running: false, release: null, idleTimer: null }
    pendingByGuest.set(guest, pending)
  }
  update(pending)
  if (!pending.running) {
    void run(guest, pending)
  }
}

async function run(guest: Electron.WebContents, pending: PendingPinch): Promise<void> {
  pending.running = true
  if (pending.idleTimer) {
    clearTimeout(pending.idleTimer)
  }
  try {
    pending.release ??= acquireElectronDebugger(guest).release
    while (!guest.isDestroyed() && (pending.reset || pending.pinch)) {
      if (pending.reset) {
        pending.reset = false
        await guest.debugger.sendCommand('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
      } else if (pending.pinch) {
        const pinch = pending.pinch
        pending.pinch = null
        await applyPinch(guest, pinch)
      }
    }
  } catch (error) {
    // DevTools can hold the debugger; a new document resets the scale anyway.
    pending.reset = false
    pending.pinch = null
    pending.release?.()
    pending.release = null
    console.warn('[browser-pinch-zoom] failed to zoom the page', { error: errorMessage(error) })
  } finally {
    pending.running = false
    pending.idleTimer = setTimeout(() => {
      pending.release?.()
      pendingByGuest.delete(guest)
    }, LEASE_IDLE_MS)
  }
}

type ViewportMetrics = {
  cssLayoutViewport: { clientWidth: number; clientHeight: number }
  cssVisualViewport: {
    offsetX: number
    offsetY: number
    clientWidth: number
    clientHeight: number
    scale: number
    zoom?: number
  }
}

async function applyPinch(guest: Electron.WebContents, pinch: BrowserPagePinch): Promise<void> {
  const readMetrics = (): Promise<ViewportMetrics> =>
    guest.debugger.sendCommand('Page.getLayoutMetrics')
  const { cssVisualViewport: before } = await readMetrics()
  // Chromium's pinch wheel carries deltaY = -100 * ln(scale change) in DIP; the DOM divided it by Orca's UI zoom.
  const deltaY = pinch.deltaY * (guest.hostWebContents?.getZoomFactor() ?? 1)
  // Blink clamps to the page's limits.
  await guest.debugger.sendCommand('Emulation.setPageScaleFactor', {
    pageScaleFactor: before.scale * Math.exp(-deltaY / 100)
  })
  const { cssLayoutViewport: layout, cssVisualViewport: after } = await readMetrics()
  if (after.scale === before.scale) {
    return
  }
  // Keep the page point under the fingers in place, within the layout viewport.
  const pan = (
    fraction: number,
    offset: 'offsetX' | 'offsetY',
    size: 'clientWidth' | 'clientHeight'
  ): number => {
    const target = before[offset] + fraction * (before[size] - after[size])
    return Math.min(layout[size] - after[size], Math.max(0, target)) - after[offset]
  }
  const dipPerCssPixel = after.scale * (after.zoom ?? 1)
  const panX = pan(pinch.x, 'offsetX', 'clientWidth') * dipPerCssPixel
  const panY = pan(pinch.y, 'offsetY', 'clientHeight') * dipPerCssPixel
  if (panX === 0 && panY === 0) {
    return
  }
  await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: VIEWPORT_ONLY_WHEEL_POINT,
    y: VIEWPORT_ONLY_WHEEL_POINT,
    deltaX: panX,
    deltaY: panY
  })
}
