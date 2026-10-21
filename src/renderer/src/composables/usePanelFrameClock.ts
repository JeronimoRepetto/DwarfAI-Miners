/**
 * The Panel window's sprite clock, held still while the Panel window is hidden (ISSUE-297; ADR-025 item 7;
 * NFR-PERF-04).
 *
 * The one shared frame clock halts on `document.hidden` (frameClock.ts), but for a hidden frameless window that is a
 * platform detail: on Windows the perf lane saw the Panel hidden behind Veta keep `document.hidden` false, and its
 * sleeping dwarf kept changing frame about five times a second. UI main knows whether the Panel is on screen and says
 * so (A-P1 `panel:visible:changed`, and `getPanelVisible` for the first mount, the same pair `useAudio` follows), so the
 * Panel pauses its clock on that fact. Both halts hold: the window hidden, or the document hidden.
 *
 * Only the Panel's app installs it (main.ts): the Veta window has its own renderer and its own clock, which keeps
 * playing while Veta is shown.
 */
import type { App } from 'vue'
import {
  browserFrameClockEnv,
  createFrameClock,
  type PausableFrameClock
} from '../lib/sprite/frameClock'
import { FRAME_CLOCK_KEY } from './useFramePlayer'

/** What the Panel hears from UI main about its own window (A-P1 and its first read). */
export interface PanelVisibilitySource {
  getPanelVisible(): Promise<boolean>
  onPanelVisibility(listener: (visible: boolean) => void): () => void
}

/**
 * Gives every sprite of the Panel's `app` one clock that pauses while the Panel window is hidden and resumes when it
 * shows. A push always wins over the first read when it arrives first (the read was asked before it). An unreachable
 * main is not a hidden window: the clock keeps running until a push says otherwise. Answers `stop`, which lets go of
 * the push.
 */
export function usePanelFrameClock(
  app: App,
  source: PanelVisibilitySource,
  clock: PausableFrameClock = createFrameClock(browserFrameClockEnv())
): { clock: PausableFrameClock; stop(): void } {
  let pushed = false
  const follow = (visible: boolean): void => {
    if (visible) clock.resume()
    else clock.pause()
  }
  const unlisten = source.onPanelVisibility((visible) => {
    pushed = true
    follow(visible)
  })
  source.getPanelVisible().then(
    (visible) => {
      if (!pushed) follow(visible)
    },
    () => {}
  )
  app.provide(FRAME_CLOCK_KEY, clock)
  return { clock, stop: unlisten }
}
