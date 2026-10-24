import { acquireElectronDebugger } from './electron-debugger-lease'
import { errorMessage } from '../../shared/error-message'

/** A trackpad pinch over a page; x and y are fractions of the page's width and height. */
export type BrowserPagePinch = { deltaY: number; x: number; y: number }

// Chromium's own pinch limits (blink web_preferences.h).
const MAX_PINCH_SCALE = process.platform === 'darwin' ? 3 : 4
// Why: a wheel this far outside the viewport hits no element, so only the visual viewport pans and the page sees no wheel event.
const VIEWPORT_ONLY_WHEEL_POINT = 100_000

type PinchJob = BrowserPagePinch | 'reset'

const pendingJobsByGuest = new WeakMap<Electron.WebContents, PinchJob[]>()

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
  const jobs = pendingJobsByGuest.get(guest) ?? []
  const last = jobs.at(-1)
  if (last && last !== 'reset') {
    jobs[jobs.length - 1] = { ...pinch, deltaY: last.deltaY + pinch.deltaY }
  } else {
    jobs.push(pinch)
  }
  queueJobs(guest, jobs)
}

// Reset zoom clears the pinch too, as Chrome does; it queues behind an in-flight pinch so it wins.
export function resetGuestPinchZoom(guest: Electron.WebContents): void {
  queueJobs(guest, ['reset'])
}

function queueJobs(guest: Electron.WebContents, jobs: PinchJob[]): void {
  const flushing = pendingJobsByGuest.has(guest)
  pendingJobsByGuest.set(guest, jobs)
  if (!flushing) {
    void flushJobs(guest, jobs)
  }
}

async function flushJobs(guest: Electron.WebContents, jobs: PinchJob[]): Promise<void> {
  let release: (() => void) | null = null
  try {
    release = acquireElectronDebugger(guest).release
    for (let job = jobs.shift(); job; job = pendingJobsByGuest.get(guest)?.shift()) {
      if (guest.isDestroyed()) {
        break
      }
      await (job === 'reset'
        ? guest.debugger.sendCommand('Emulation.setPageScaleFactor', { pageScaleFactor: 1 })
        : applyPinch(guest, job))
    }
  } catch (error) {
    // DevTools can hold the debugger; a new document resets the scale anyway.
    console.warn('[browser-pinch-zoom] failed to zoom the page', { error: errorMessage(error) })
  } finally {
    release?.()
    pendingJobsByGuest.delete(guest)
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
