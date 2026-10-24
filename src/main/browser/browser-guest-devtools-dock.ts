import { BrowserWindow, WebContentsView } from 'electron'
import type { BrowserDevToolsDockBounds } from '../../shared/browser-devtools-dock'

type DockedDevTools = {
  /** Replaced after a page crash; the entry itself lives until DevTools close. */
  view: WebContentsView
  window: BrowserWindow
  dispose: () => void
  onClosed: () => void
  /** Bumped by every bounds update, so a slow snapshot can't hide a view shown after it. */
  boundsGeneration: number
}

/** DevTools for a page guest, shown in a native view the renderer positions inside the pane.
 *  A <webview> can't host the frontend on Electron 43 (it never connects), so the host is a
 *  WebContentsView laid over the pane's DevTools slot; the renderer owns the slot's layout. */
export class BrowserGuestDevToolsDock {
  private readonly docks = new Map<number, DockedDevTools>()

  isDocked(guestId: number): boolean {
    return this.docks.has(guestId)
  }

  /** Returns false when the guest has no window to dock into. `onClosed` runs however it closes. */
  open(guest: Electron.WebContents, onClosed: () => void): boolean {
    const existing = this.docks.get(guest.id)
    if (existing) {
      existing.view.webContents.focus()
      return true
    }
    const host = guest.hostWebContents
    const window = host ? BrowserWindow.fromWebContents(host) : null
    if (!window || window.isDestroyed()) {
      return false
    }
    if (guest.isDevToolsOpened()) {
      // Electron ignores a custom host while its own DevTools window exists.
      guest.closeDevTools()
    }
    let crashed = false
    let reconnecting: { bounds: Electron.Rectangle; visible: boolean } | null = null
    const handleCrash = (): void => {
      crashed = true
    }
    // A crash leaves the frontend detached for good. Once the page is back, drop the stale host;
    // its devtools-closed then brings up a fresh one in the same place, like Chrome reconnecting.
    const handleDomReady = (): void => {
      const dock = this.docks.get(guest.id)
      if (crashed && dock && !reconnecting) {
        crashed = false
        reconnecting = { bounds: dock.view.getBounds(), visible: dock.view.getVisible() }
        destroyView(window, dock.view)
      }
    }
    // Fires for DevTools' own close button and for the host being destroyed.
    const handleClosed = (): void => {
      const dock = this.docks.get(guest.id)
      if (dock && reconnecting) {
        dock.view = attachDevToolsView(guest, window)
        dock.view.setBounds(reconnecting.bounds)
        dock.view.setVisible(reconnecting.visible)
        reconnecting = null
        return
      }
      this.close(guest.id)
    }
    guest.on('render-process-gone', handleCrash)
    guest.on('dom-ready', handleDomReady)
    guest.on('devtools-closed', handleClosed)
    this.docks.set(guest.id, {
      view: attachDevToolsView(guest, window),
      window,
      dispose: () => {
        try {
          guest.off('render-process-gone', handleCrash)
          guest.off('dom-ready', handleDomReady)
          guest.off('devtools-closed', handleClosed)
        } catch {
          // guest may already be destroyed
        }
      },
      onClosed,
      boundsGeneration: 0
    })
    return true
  }

  /** Bounds are in the host renderer's CSS pixels; null hides the view. With `snapshot`, the
   *  hidden view's last frame comes back so the renderer can paint it under an overlay. */
  async setBounds(
    guestId: number,
    bounds: BrowserDevToolsDockBounds | null,
    snapshot: boolean
  ): Promise<string | null> {
    const dock = this.docks.get(guestId)
    if (!dock || dock.window.isDestroyed()) {
      return null
    }
    const generation = ++dock.boundsGeneration
    if (bounds) {
      const zoom = dock.window.webContents.getZoomFactor()
      dock.view.setBounds({
        x: Math.round(bounds.x * zoom),
        y: Math.round(bounds.y * zoom),
        width: Math.round(bounds.width * zoom),
        height: Math.round(bounds.height * zoom)
      })
      dock.view.setVisible(true)
      return null
    }
    const image =
      snapshot && dock.view.getVisible() ? await dock.view.webContents.capturePage() : null
    if (dock.boundsGeneration === generation) {
      dock.view.setVisible(false)
    }
    return image && !image.isEmpty() ? image.toDataURL() : null
  }

  close(guestId: number): void {
    const dock = this.docks.get(guestId)
    if (!dock) {
      return
    }
    this.docks.delete(guestId)
    dock.dispose()
    destroyView(dock.window, dock.view)
    dock.onClosed()
  }
}

// Each open needs a fresh host: Electron loads the frontend only into one that never navigated.
function attachDevToolsView(guest: Electron.WebContents, window: BrowserWindow): WebContentsView {
  const view = new WebContentsView()
  // Hidden until the renderer reports where the slot is.
  view.setVisible(false)
  window.contentView.addChildView(view)
  guest.setDevToolsWebContents(view.webContents)
  guest.openDevTools()
  return view
}

function destroyView(window: BrowserWindow, view: WebContentsView): void {
  if (!window.isDestroyed()) {
    window.contentView.removeChildView(view)
  }
  // closeDevTools() leaves a custom host attached and frozen; destroying the host detaches it.
  if (!view.webContents.isDestroyed()) {
    view.webContents.close()
  }
}
