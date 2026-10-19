import type { DisplayInfo, ScreenAreaProvider } from '../screenAreaProvider'
import type { DisplayKey, Rect } from '../windowFactory'

/**
 * Hand-written double of `ScreenAreaProvider` (16 §4.14, 16 §2.8): the displays a test hands it, changed at will with
 * `set` (a display plugged in or out, a taskbar moved, a scale change: 13 FM-111). Asking for a key it does not hold is
 * a test defect and throws.
 */
export class FakeScreenAreaProvider implements ScreenAreaProvider {
  private current: DisplayInfo[]

  constructor(displays: DisplayInfo[]) {
    this.current = displays
  }

  /** Replaces the displays, as a display change would. */
  set(displays: DisplayInfo[]): void {
    this.current = displays
  }

  workArea(displayKey: DisplayKey): Rect {
    return this.find(displayKey).workArea
  }

  bounds(displayKey: DisplayKey): Rect {
    return this.find(displayKey).bounds
  }

  displays(): DisplayInfo[] {
    return this.current.map((display) => ({ ...display }))
  }

  private find(displayKey: DisplayKey): DisplayInfo {
    const display = this.current.find((d) => d.displayKey === displayKey)
    if (display === undefined) throw new Error(`FakeScreenAreaProvider: no display ${displayKey}`)
    return display
  }
}
