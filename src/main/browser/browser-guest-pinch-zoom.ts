import { acquireElectronDebugger } from './electron-debugger-lease'
import { errorMessage } from '../../shared/error-message'

/** A trackpad pinch over a page; x and y are fractions of the page's width and height. */
export type BrowserPagePinch = { deltaY: number; x: number; y: number }

// Chromium's own pinch limits (blink web_preferences.h).
const MAX_PINCH_SCALE = process.platform === 'darwin' ? 3 : 4
// Why: a wheel this far outside the viewport hits no element, so only the visual viewport pans and the page sees no wheel event.
const VIEWPORT_ONLY_WHEEL_POINT = 100_000

const pendingPinchByGuest = new WeakMap<Electron.WebContents, BrowserPagePinch>()
const flushingGuests = new WeakSet<Electron.WebContents>()

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
  const pending = pendingPinchByGuest.get(guest)
  pendingPinchByGuest.set(guest, { ...pinch, deltaY: (pending?.deltaY ?? 0) + pinch.deltaY })
  if (!flushingGuests.has(guest)) {
    void flushPinches(guest)
  }
}

async function flushPinches(guest: Electron.WebContents): Promise<void> {
  flushingGuests.add(guest)
  let release: (() => void) | null = null
  try {
    release = acquireElectronDebugger(guest).release
    for (let pinch = takePinch(guest); pinch; pinch = takePinch(guest)) {
      await applyPinch(guest, pinch)
    }
  } catch (error) {
    pendingPinchByGuest.delete(guest)
    console.warn('[browser-pinch-zoom] failed to zoom the page', { error: errorMessage(error) })
  } finally {
    release?.()
    flushingGuests.delete(guest)
  }
}

// Reset zoom clears the pinch too, as Chrome does.
export function resetGuestPinchZoom(guest: Electron.WebContents): void {
  pendingPinchByGuest.delete(guest)
  let release: () => void
  try {
    release = acquireElectronDebugger(guest).release
  } catch {
    // DevTools can hold the debugger; a new document resets the scale anyway.
    return
  }
  guest.debugger
    .sendCommand('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
    .catch(() => {})
    .finally(release)
}

function takePinch(guest: Electron.WebContents): BrowserPagePinch | undefined {
  const pinch = pendingPinchByGuest.get(guest)
  pendingPinchByGuest.delete(guest)
  return guest.isDestroyed() ? undefined : pinch
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
  const pan = (fraction: number, axis: 'X' | 'Y'): number => {
    const size = axis === 'X' ? 'clientWidth' : 'clientHeight'
    const offset = `offset${axis}` as const
    const target = before[offset] + fraction * (before[size] - after[size])
    return Math.min(layout[size] - after[size], Math.max(0, target)) - after[offset]
  }
  const dipPerCssPixel = after.scale * (after.zoom ?? 1)
  const panX = pan(pinch.x, 'X') * dipPerCssPixel
  const panY = pan(pinch.y, 'Y') * dipPerCssPixel
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
