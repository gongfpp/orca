import { describe, expect, it, vi } from 'vitest'
import {
  enableGuestPinchZoom,
  pinchGuestPage,
  resetGuestPinchZoom
} from './browser-guest-pinch-zoom'

type Viewport = {
  offsetX: number
  offsetY: number
  clientWidth: number
  clientHeight: number
  scale: number
  zoom: number
}

// Metrics before and after Emulation.setPageScaleFactor, as Blink reports them.
function fakeGuest(before: Viewport, after: Viewport, orcaUIZoomFactor = 1) {
  const visualViewports = [before, after]
  const sendCommand = vi.fn(async (method: string, _params?: object) =>
    method === 'Page.getLayoutMetrics'
      ? {
          cssLayoutViewport: { clientWidth: 1000, clientHeight: 800 },
          cssVisualViewport: visualViewports.shift()
        }
      : {}
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lease and pinch code only call isDestroyed, hostWebContents.getZoomFactor, debugger.isAttached and debugger.sendCommand.
  const guest = {
    isDestroyed: () => false,
    hostWebContents: { getZoomFactor: () => orcaUIZoomFactor },
    debugger: { isAttached: () => true, sendCommand }
  } as unknown as Electron.WebContents
  return { guest, sendCommand }
}

const settled = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('browser guest pinch zoom', () => {
  it('keeps Orca unpinchable without waiting for the guest renderer', () => {
    const embedder = { setVisualZoomLevelLimits: vi.fn(async () => {}) }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: enableGuestPinchZoom only reads hostWebContents and calls setVisualZoomLevelLimits.
    const guest = {
      hostWebContents: embedder,
      // Electron's promise waits on the guest renderer, which may not exist yet at attach.
      setVisualZoomLevelLimits: vi.fn(() => new Promise<void>(() => {}))
    } as unknown as Electron.WebContents

    enableGuestPinchZoom(guest)

    expect(embedder.setVisualZoomLevelLimits).toHaveBeenCalledWith(1, 1)
  })

  it('scales the page and keeps the point under the fingers in place', async () => {
    const { guest, sendCommand } = fakeGuest(
      { offsetX: 0, offsetY: 0, clientWidth: 1000, clientHeight: 800, scale: 1, zoom: 1.25 },
      { offsetX: 0, offsetY: 0, clientWidth: 500, clientHeight: 400, scale: 2, zoom: 1.25 },
      1.2
    )

    // At 120% Orca UI zoom the DOM reports the 2x pinch's wheel delta divided by 1.2.
    pinchGuestPage(guest, { deltaY: (-100 * Math.log(2)) / 1.2, x: 0.5, y: 0.25 })
    await settled()

    expect(sendCommand).toHaveBeenCalledWith('Emulation.setPageScaleFactor', {
      pageScaleFactor: expect.closeTo(2)
    })
    // The anchor moves 250 x 100 CSS px; wheel deltas are DIP, so times scale 2 and page zoom 1.25.
    expect(sendCommand).toHaveBeenCalledWith(
      'Input.dispatchMouseEvent',
      expect.objectContaining({ deltaX: expect.closeTo(625), deltaY: expect.closeTo(250) })
    )
  })

  it('lets Reset zoom win over a pinch already in flight', async () => {
    const { guest, sendCommand } = fakeGuest(
      { offsetX: 0, offsetY: 0, clientWidth: 1000, clientHeight: 800, scale: 1, zoom: 1 },
      { offsetX: 0, offsetY: 0, clientWidth: 500, clientHeight: 400, scale: 2, zoom: 1 }
    )

    pinchGuestPage(guest, { deltaY: -100 * Math.log(2), x: 0.5, y: 0.5 })
    resetGuestPinchZoom(guest)
    await settled()

    expect(sendCommand.mock.calls.at(-1)).toEqual([
      'Emulation.setPageScaleFactor',
      { pageScaleFactor: 1 }
    ])
  })

  it.each([
    [
      'zooming out pins the viewport to its edge',
      100 * Math.log(4),
      { offsetX: 500, offsetY: 400, clientWidth: 500, clientHeight: 400, scale: 2, zoom: 1 },
      { offsetX: 0, offsetY: 0, clientWidth: 1000, clientHeight: 800, scale: 1, zoom: 1 }
    ],
    [
      'the page refuses to scale (maximum-scale=1 under mobile emulation)',
      -50,
      { offsetX: 0, offsetY: 0, clientWidth: 1000, clientHeight: 800, scale: 1, zoom: 1 },
      { offsetX: 0, offsetY: 0, clientWidth: 1000, clientHeight: 800, scale: 1, zoom: 1 }
    ]
  ])('does not pan when %s', async (_case, deltaY, before, after) => {
    const { guest, sendCommand } = fakeGuest(before, after)

    pinchGuestPage(guest, { deltaY, x: 0.9, y: 0.9 })
    await settled()

    // A leftover pan would scroll the page itself.
    expect(sendCommand.mock.calls.map(([method]) => method)).toEqual([
      'Page.getLayoutMetrics',
      'Emulation.setPageScaleFactor',
      'Page.getLayoutMetrics'
    ])
  })
})
