import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Rect = { x: number; y: number; width: number; height: number }

const electronMocks = vi.hoisted(() => {
  class FakeView {
    bounds: Rect = { x: 0, y: 0, width: 0, height: 0 }
    visible = true
    onDestroyed: (() => void) | null = null
    destroyed = false
    webContents = {
      close: vi.fn(() => {
        this.destroyed = true
        this.onDestroyed?.()
      }),
      isDestroyed: () => this.destroyed,
      focus: vi.fn(),
      capturePage: vi.fn()
    }
    constructor() {
      electronMocks.views.push(this)
    }
    setVisible(visible: boolean): void {
      this.visible = visible
    }
    getVisible(): boolean {
      return this.visible
    }
    setBounds(bounds: Rect): void {
      this.bounds = bounds
    }
    getBounds(): Rect {
      return this.bounds
    }
  }
  const views: FakeView[] = []
  const state: { FakeView: typeof FakeView; views: FakeView[]; window: unknown } = {
    FakeView,
    views,
    window: null
  }
  return state
})

vi.mock('electron', () => ({
  WebContentsView: electronMocks.FakeView,
  BrowserWindow: { fromWebContents: () => electronMocks.window }
}))

import { BrowserGuestDevToolsDock } from './browser-guest-devtools-dock'

const GUEST_ID = 7

function createGuest(): EventEmitter & {
  id: number
  closeDevTools: ReturnType<typeof vi.fn>
  setDevToolsWebContents: ReturnType<typeof vi.fn>
} {
  const guest = Object.assign(new EventEmitter(), {
    id: GUEST_ID,
    hostWebContents: {},
    isDevToolsOpened: () => false,
    closeDevTools: vi.fn(),
    openDevTools: vi.fn(),
    setDevToolsWebContents: vi.fn((devTools: unknown) => {
      // Electron reports a destroyed custom host as DevTools closing on the inspected page.
      const view = electronMocks.views.find((v) => v.webContents === devTools)
      if (view) {
        view.onDestroyed = () => guest.emit('devtools-closed')
      }
    })
  })
  return guest
}

function openDock(onClosed = vi.fn()) {
  const dock = new BrowserGuestDevToolsDock()
  const guest = createGuest()
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the fake implements every guest member the dock calls.
  dock.open(guest as unknown as Electron.WebContents, onClosed)
  return { dock, guest, onClosed }
}

describe('BrowserGuestDevToolsDock', () => {
  let children: unknown[]

  beforeEach(() => {
    electronMocks.views.length = 0
    children = []
    electronMocks.window = {
      isDestroyed: () => false,
      contentView: {
        addChildView: (view: unknown) => children.push(view),
        removeChildView: (view: unknown) => children.splice(children.indexOf(view), 1)
      },
      webContents: { getZoomFactor: () => 1 }
    }
  })

  it('closes by destroying its host, which a closeDevTools() call would leave frozen', () => {
    const { dock, guest, onClosed } = openDock()
    const [view] = electronMocks.views

    dock.close(GUEST_ID)

    expect(view.webContents.close).toHaveBeenCalled()
    expect(guest.closeDevTools).not.toHaveBeenCalled()
    expect(children).toEqual([])
    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(dock.isDocked(GUEST_ID)).toBe(false)
  })

  it("closes when DevTools' own close button closes them", () => {
    const { guest, onClosed } = openDock()

    guest.emit('devtools-closed')

    expect(onClosed).toHaveBeenCalledTimes(1)
    expect(children).toEqual([])
  })

  it('reconnects a fresh frontend in the same place once a crashed page is back', async () => {
    const { dock, guest, onClosed } = openDock()
    await dock.setBounds(GUEST_ID, { x: 10, y: 20, width: 300, height: 200 }, false)
    const [stale] = electronMocks.views

    guest.emit('render-process-gone')
    guest.emit('dom-ready')

    const fresh = electronMocks.views[1]
    expect(stale.webContents.close).toHaveBeenCalled()
    expect(guest.setDevToolsWebContents).toHaveBeenLastCalledWith(fresh.webContents)
    expect(fresh.bounds).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    expect(fresh.visible).toBe(true)
    expect(children).toEqual([fresh])
    expect(onClosed).not.toHaveBeenCalled()
    expect(dock.isDocked(GUEST_ID)).toBe(true)
  })

  it('keeps a view shown again while the snapshot for an overlay was still capturing', async () => {
    const { dock } = openDock()
    await dock.setBounds(GUEST_ID, { x: 0, y: 0, width: 100, height: 100 }, false)
    const [view] = electronMocks.views
    let finishCapture: (image: unknown) => void = () => {}
    view.webContents.capturePage.mockReturnValue(
      new Promise((resolve) => {
        finishCapture = resolve
      })
    )

    const hidden = dock.setBounds(GUEST_ID, null, true)
    await dock.setBounds(GUEST_ID, { x: 0, y: 0, width: 120, height: 100 }, false)
    finishCapture({ isEmpty: () => false, toDataURL: () => 'data:image/png;base64,' })

    await expect(hidden).resolves.toBe('data:image/png;base64,')
    expect(view.visible).toBe(true)
  })
})
