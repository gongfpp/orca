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

function takePinch(guest: Electron.WebContents): BrowserPagePinch | undefined {
  const pinch = pendingPinchByGuest.get(guest)
  pendingPinchByGuest.delete(guest)
  return guest.isDestroyed() ? undefined : pinch
}

type ViewportMetrics = {
  cssLayoutViewport: { clientWidth: number; clientHeight: number }
  cssVisualViewport: { offsetX: number; offsetY: number; scale: number; zoom?: number }
}

async function applyPinch(guest: Electron.WebContents, pinch: BrowserPagePinch): Promise<void> {
  const metrics: ViewportMetrics = await guest.debugger.sendCommand('Page.getLayoutMetrics')
  const { clientWidth, clientHeight } = metrics.cssLayoutViewport
  const { offsetX, offsetY, scale, zoom = 1 } = metrics.cssVisualViewport
  // Chromium's pinch wheel carries deltaY = -100 * ln(scale change).
  const nextScale = Math.min(MAX_PINCH_SCALE, Math.max(1, scale * Math.exp(-pinch.deltaY / 100)))
  if (nextScale === scale) {
    return
  }
  await guest.debugger.sendCommand('Emulation.setPageScaleFactor', { pageScaleFactor: nextScale })
  // Keep the page point under the fingers in place; Blink kept the offset, clamped to the new scale.
  const pan = (offset: number, fraction: number, size: number): number => {
    const max = size - size / nextScale
    const target = offset + fraction * size * (1 / scale - 1 / nextScale)
    return Math.min(max, Math.max(0, target)) - Math.min(max, offset)
  }
  const dipPerCssPixel = nextScale * zoom
  const deltaX = pan(offsetX, pinch.x, clientWidth) * dipPerCssPixel
  const deltaY = pan(offsetY, pinch.y, clientHeight) * dipPerCssPixel
  if (deltaX === 0 && deltaY === 0) {
    return
  }
  await guest.debugger.sendCommand('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: VIEWPORT_ONLY_WHEEL_POINT,
    y: VIEWPORT_ONLY_WHEEL_POINT,
    deltaX,
    deltaY
  })
}
