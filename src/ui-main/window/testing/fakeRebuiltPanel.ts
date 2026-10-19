// The rebuilt Panel window (ISSUE-047) over the fake window factory, for the composition root's tests. Test-only
// (05 R14): no production path imports it. ADDED for ISSUE-243: with today's runtime deleted, every start of the root
// builds the rebuilt Panel, so the root's tests that ran on today's Panel window compose this one instead.
import { createPanelWindow, type PanelWindowUseCases } from '../application/panelWindow'
import type { ModeWindowRegistry } from '../application/modeWindowRegistry'
import { FakeScreenAreaProvider } from '../ports/fakes/FakeScreenAreaProvider'
import { FakeWindowFactory } from '../ports/fakes/FakeWindowFactory'
import { InMemoryUiPreferenceStore } from '../ports/fakes/InMemoryUiPreferenceStore'

/**
 * A `panelWindow` factory for `startUiMain`: the Panel over `windows`, on one 1920×1080 display, with its own preference
 * store. `onBuilt` runs when its window is first built (the first paint of a normal start).
 */
export function fakeRebuiltPanel(
  windows: FakeWindowFactory = new FakeWindowFactory(),
  onBuilt: () => void = () => {}
): (modeWindows: ModeWindowRegistry) => PanelWindowUseCases {
  return () =>
    createPanelWindow({
      windows: {
        panel: () => {
          if (windows.built.length === 0) onBuilt()
          return windows.panel()
        },
        veta: (key) => windows.veta(key),
        valle: (from) => windows.valle(from)
      },
      surface: {
        applyZoom: (factor) => factor,
        bounds: () => windows.panel().bounds ?? { x: 0, y: 0, width: 0, height: 0 },
        setAlwaysOnTop: (on) => on,
        isAlwaysOnTop: () => false,
        raise: () => undefined,
        isMinimized: () => false,
        isVisible: () => windows.built.length > 0 && windows.panel().visible,
        onMinimizedChanged: () => undefined
      },
      screen: new FakeScreenAreaProvider([
        {
          displayKey: 'primary',
          bounds: { x: 0, y: 0, width: 1920, height: 1080 },
          workArea: { x: 0, y: 0, width: 1920, height: 1040 },
          primary: true
        }
      ]),
      store: new InMemoryUiPreferenceStore(),
      floor: 32,
      onDisplaysChanged: () => undefined
    })
}
