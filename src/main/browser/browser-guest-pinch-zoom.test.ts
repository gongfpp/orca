import { describe, expect, it, vi } from 'vitest'
import { enableGuestPinchZoom, pinchGuestPage } from './browser-guest-pinch-zoom'

function fakeGuest(viewport: {
  width: number
  height: number
  offsetX: number
  offsetY: number
  scale: number
  zoom: number
}) {
  const sendCommand = vi.fn(async (method: string) =>
    method === 'Page.getLayoutMetrics'
      ? {
          cssLayoutViewport: { clientWidth: viewport.width, clientHeight: viewport.height },
          cssVisualViewport: viewport
        }
      : {}
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lease and pinch code only call isDestroyed, debugger.isAttached and debugger.sendCommand.
  const guest = {
    isDestroyed: () => false,
    debugger: { isAttached: () => true, sendCommand }
  } as unknown as Electron.WebContents
  return { guest, sendCommand }
}

describe('browser guest pinch zoom', () => {
  it('keeps Orca unpinchable without waiting for the guest renderer', () => {
    const calls: string[] = []
    const embedder = {
      setVisualZoomLevelLimits: vi.fn(async (min: number, max: number) => {
        calls.push(`embedder ${min}-${max}`)
      })
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: enableGuestPinchZoom only reads hostWebContents and calls setVisualZoomLevelLimits.
    const guest = {
      hostWebContents: embedder,
      // Electron's promise waits on the guest renderer, which may not exist yet at attach.
      setVisualZoomLevelLimits: vi.fn((min: number, max: number) => {
        calls.push(`guest ${min}-${max}`)
        return new Promise<void>(() => {})
      })
    } as unknown as Electron.WebContents

    enableGuestPinchZoom(guest)

    expect(calls).toEqual([expect.stringMatching(/^guest 1-[34]$/), 'embedder 1-1'])
  })

  it('scales the page and keeps the point under the fingers in place', async () => {
    const { guest, sendCommand } = fakeGuest({
      width: 1000,
      height: 800,
      offsetX: 0,
      offsetY: 0,
      scale: 1,
      zoom: 1.25
    })

    pinchGuestPage(guest, { deltaY: -100 * Math.log(2), x: 0.5, y: 0.25 })

    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(3))
    expect(sendCommand.mock.calls[1][1]).toEqual({ pageScaleFactor: expect.closeTo(2) })
    // The anchor moves 250 x 100 CSS px; wheel deltas are DIP, so times scale 2 and page zoom 1.25.
    expect(sendCommand.mock.calls[2][1]).toMatchObject({
      type: 'mouseWheel',
      deltaX: expect.closeTo(625),
      deltaY: expect.closeTo(250)
    })
  })

  it('does not pan when zooming out pins the viewport to its edge', async () => {
    const { guest, sendCommand } = fakeGuest({
      width: 1000,
      height: 800,
      offsetX: 500,
      offsetY: 400,
      scale: 2,
      zoom: 1
    })

    pinchGuestPage(guest, { deltaY: 100 * Math.log(4), x: 0.9, y: 0.9 })

    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(2))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(sendCommand.mock.calls[1][1]).toEqual({ pageScaleFactor: 1 })
    // A leftover pan at scale 1 would scroll the page itself.
    expect(sendCommand).toHaveBeenCalledTimes(2)
  })
})
