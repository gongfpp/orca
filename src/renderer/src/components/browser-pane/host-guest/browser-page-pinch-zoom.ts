// Why: Chromium hands a trackpad pinch over a <webview> to Orca's DOM as Ctrl+wheel; a mouse Ctrl+wheel goes to the page itself.
export function forwardBrowserPagePinchZoom(browserPageId: string, webview: HTMLElement): void {
  webview.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey) {
        return
      }
      const rect = webview.getBoundingClientRect()
      window.api.browser.pinchPage({
        browserPageId,
        deltaY: event.deltaY,
        x: (event.clientX - rect.left) / rect.width,
        y: (event.clientY - rect.top) / rect.height
      })
    },
    { passive: true }
  )
}
