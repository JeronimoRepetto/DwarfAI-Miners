// layer: L2
// L2 (17 §1.2): which mode windows count for UI main's `PresenceTracker` (ADR-024 item 7; 14 A-44, B-M07; 07 S39.04,
// S39.05; US-SHELL-010.AC08): the Panel while it is shown and not minimized, and the Veta or the Valle window while the
// mode shell shows it. A hidden window's last report stops counting; it counts again once shown. Driven over the
// tracker with the manual timer queue and the recording HostClient double.
import { describe, expect, it } from 'vitest'
import type { MineId } from '@dwarfai/contracts'
import { FakeHostClientTimers } from '../../host-client/testing/FakeHostClientTimers'
import { RecordingHostClient } from '../ports/fakes/RecordingHostClient'
import type { Presence } from '../ports/hostClient'
import { createPresenceTracker, PRESENCE_DEBOUNCE_MS } from './presenceTracker'
import { RecordingUiLog } from '../../hostLauncher/fakes/RecordingUiLog'
import { RecordingNotificationDisplay } from '../ports/fakes/RecordingNotificationDisplay'
import { startNotificationPresenter } from './notificationPresenter'
import {
  anyModeShown,
  shownModeWindows,
  type ShownModes,
  type WindowMode
} from './shownModeWindows'

const PANEL = 7
const VETA = 8
const VALLE = 9
const MODES: Record<number, WindowMode> = { [PANEL]: 'panel', [VETA]: 'veta', [VALLE]: 'valle' }
const PANEL_MINE = '01890a5d-ac96-774b-bcce-b302099a8111' as MineId
const VALLE_MINE = '01890a5d-ac96-774b-bcce-b302099a8112' as MineId
const VETA_MINE = '01890a5d-ac96-774b-bcce-b302099a8113' as MineId

function world() {
  const host = new RecordingHostClient()
  const timers = new FakeHostClientTimers()
  const shown: ShownModes = { panel: false, veta: false, valle: false }
  const tracker = createPresenceTracker({
    host,
    timers,
    visibleWindows: () => shownModeWindows([PANEL, VETA, VALLE], (id) => MODES[id]!, shown)
  })
  const onScreen = (): MineId[] | undefined =>
    host.calls.flatMap((c) => (c.member === 'reportPresence' ? [c.presence] : [])).at(-1)
      ?.onScreenMineIds as MineId[] | undefined
  const sent = (): Presence[] =>
    host.calls.flatMap((c) => (c.member === 'reportPresence' ? [c.presence] : []))
  /** Each window reports the mines it shows, settled. */
  const reportAll = (): void => {
    tracker.report(PANEL, [PANEL_MINE])
    tracker.report(VETA, [VETA_MINE])
    tracker.report(VALLE, [VALLE_MINE])
    timers.advance(PRESENCE_DEBOUNCE_MS)
  }
  const show = (patch: Partial<ShownModes>): void => {
    Object.assign(shown, patch)
    tracker.windowsChanged()
  }
  return { reportAll, show, onScreen, sent }
}

describe('the shown mode windows for presence (ISSUE-306)', () => {
  it("[US-SHELL-010.AC08, S39.04, S39.05, ADR-024] the Valle window's report counts as on screen only while Valle is shown, and the Panel's only while the Panel is", () => {
    const w = world()
    w.show({ panel: true })
    w.reportAll()
    // The Panel shown, Valle and Veta hidden: only the Panel's mines are on screen (unchanged behaviour).
    expect(w.onScreen()).toEqual([PANEL_MINE])
    // Valle shown, the Panel hidden: Valle's reported mines are on screen, the Panel's no longer.
    w.show({ panel: false, valle: true })
    expect(w.onScreen()).toEqual([VALLE_MINE])
    expect(w.sent().at(-1)?.anyWindowVisible).toBe(true)
    // Valle hidden too: nothing is on screen; its last report is kept for its next show.
    w.show({ valle: false })
    expect(w.onScreen()).toEqual([])
    expect(w.sent().at(-1)?.anyWindowVisible).toBe(false)
    w.show({ valle: true })
    expect(w.onScreen()).toEqual([VALLE_MINE])
    // Veta shown instead: its mines, not Valle's.
    w.show({ valle: false, veta: true })
    expect(w.onScreen()).toEqual([VETA_MINE])
    // The Panel back: its last report counts again.
    w.show({ veta: false, panel: true })
    expect(w.onScreen()).toEqual([PANEL_MINE])
  })
})

// The level-3 presenter's `anyWindowOpen`, while S-018-1 has not passed (the window-only fallback on every OS, 21 §9):
// a notification is drawn with any mode window shown, Veta or Valle included, not only the Panel.
describe('a mode window open for the level-3 fallback (ISSUE-306)', () => {
  it('[US-SHELL-010.AC08, ADR-018] a level-3 notification is drawn with Valle or Veta shown, and not with every mode window hidden', () => {
    const display = new RecordingNotificationDisplay()
    const shown: ShownModes = { panel: false, veta: false, valle: true }
    let handler: ((frame: { name: 'attention.notify'; data: unknown }) => void) | undefined
    startNotificationPresenter({
      onAttentionFrame: (h) => {
        handler = h as typeof handler
        return () => {}
      },
      display,
      drawsWithoutWindow: false,
      anyWindowOpen: () => anyModeShown(shown),
      log: new RecordingUiLog()
    })
    const notify = (key: string): void =>
      handler?.({
        name: 'attention.notify',
        data: {
          key,
          kind: 'permission',
          title: 't',
          body: 'gamma',
          mineId: VALLE_MINE,
          dwarfId: 'd',
          sensitive: true
        }
      })
    notify('k-valle')
    expect(display.shown.map((n) => n.key)).toEqual(['k-valle'])
    Object.assign(shown, { valle: false, veta: true })
    notify('k-veta')
    expect(display.shown.map((n) => n.key)).toEqual(['k-valle', 'k-veta'])
    Object.assign(shown, { veta: false })
    notify('k-none')
    expect(display.shown.map((n) => n.key)).toEqual(['k-valle', 'k-veta'])
    Object.assign(shown, { panel: true })
    notify('k-panel')
    expect(display.shown.map((n) => n.key)).toEqual(['k-valle', 'k-veta', 'k-panel'])
  })
})
