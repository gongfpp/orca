export type BrowserDevToolsDockSide = 'bottom' | 'right'

/** Where docked DevTools sit and how much of the pane they take, per side. */
export type BrowserDevToolsDockLayout = {
  side: BrowserDevToolsDockSide
  bottomFraction: number
  rightFraction: number
}

export type BrowserDevToolsDockBounds = { x: number; y: number; width: number; height: number }

export const DEFAULT_BROWSER_DEVTOOLS_DOCK_LAYOUT: BrowserDevToolsDockLayout = {
  side: 'bottom',
  bottomFraction: 0.4,
  rightFraction: 0.45
}

/** Share of the pane DevTools take on their current side. */
export function browserDevToolsDockFraction(layout: BrowserDevToolsDockLayout): number {
  return layout.side === 'bottom' ? layout.bottomFraction : layout.rightFraction
}

export const MIN_BROWSER_DEVTOOLS_DOCK_FRACTION = 0.15
export const MAX_BROWSER_DEVTOOLS_DOCK_FRACTION = 0.85

export function clampBrowserDevToolsDockFraction(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(
        MAX_BROWSER_DEVTOOLS_DOCK_FRACTION,
        Math.max(MIN_BROWSER_DEVTOOLS_DOCK_FRACTION, value)
      )
    : fallback
}

export function normalizeBrowserDevToolsDockLayout(value: unknown): BrowserDevToolsDockLayout {
  const defaults = DEFAULT_BROWSER_DEVTOOLS_DOCK_LAYOUT
  if (typeof value !== 'object' || value === null) {
    return defaults
  }
  return {
    side: 'side' in value && value.side === 'right' ? 'right' : 'bottom',
    bottomFraction: clampBrowserDevToolsDockFraction(
      'bottomFraction' in value ? value.bottomFraction : undefined,
      defaults.bottomFraction
    ),
    rightFraction: clampBrowserDevToolsDockFraction(
      'rightFraction' in value ? value.rightFraction : undefined,
      defaults.rightFraction
    )
  }
}
