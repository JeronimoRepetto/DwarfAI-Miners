// layer: L2
// L2 (17 §1.2): UI main's `PresenceTracker` (ADR-024 item 7; 14 A-44, B-M07) over a manual timer queue and the
// recording HostClient double: per-window reports, debounced 100 ms; the union of the visible mode window; a
// `presence` report only on a change, with an increasing `seq`.
//
// TC-111-01.
import { describe, expect, it } from 'vitest'
import type { MineId } from '@dwarfai/contracts'
import { FakeHostClientTimers } from '../../host-client/testing/FakeHostClientTimers'
import { RecordingHostClient } from '../ports/fakes/RecordingHostClient'
import type { Presence } from '../ports/hostClient'
import { createPresenceTracker, PRESENCE_DEBOUNCE_MS } from './presenceTracker'

const PANEL = 7
const OTHER_WINDOW = 9
const MINE = '01890a5d-ac96-774b-bcce-b302099a8111' as MineId
const OTHER_MINE = '01890a5d-ac96-774b-bcce-b302099a8112' as MineId

function world() {
  const host = new RecordingHostClient()
  const timers = new FakeHostClientTimers()
  /** The mode windows shown and not minimized right now, by `webContents` id. */
  const visible = new Set<number>([PANEL])
  const tracker = createPresenceTracker({
    host,
    timers,
    visibleWindows: () => [...visible]
  })
  const sent = (): Presence[] =>
    host.calls.flatMap((c) => (c.member === 'reportPresence' ? [c.presence] : []))
  return { tracker, timers, visible, sent }
}

describe('PresenceTracker (ADR-024 item 7)', () => {
  it("[ADR-024] the Panel's open mine is on screen only while the Panel is shown and not minimized", () => {
    const { tracker, timers, visible, sent } = world()
    tracker.report(PANEL, [MINE])
    timers.advance(PRESENCE_DEBOUNCE_MS)
    expect(sent().at(-1)).toStrictEqual({ onScreenMineIds: [MINE], anyWindowVisible: true, seq: 1 })

    visible.delete(PANEL) // minimized, or hidden
    tracker.windowsChanged()
    expect(sent().at(-1)).toStrictEqual({ onScreenMineIds: [], anyWindowVisible: false, seq: 2 })

    visible.add(PANEL) // restored: its last report counts again
    tracker.windowsChanged()
    expect(sent().at(-1)).toStrictEqual({ onScreenMineIds: [MINE], anyWindowVisible: true, seq: 3 })
  })

  it('[ADR-024] reports are debounced 100 ms and presence is sent once per change with an increasing seq', () => {
    const { tracker, timers, sent } = world()
    tracker.report(PANEL, [MINE])
    timers.advance(50)
    tracker.report(PANEL, [OTHER_MINE]) // within 100 ms: replaces the first report
    timers.advance(PRESENCE_DEBOUNCE_MS - 1)
    expect(sent()).toStrictEqual([])

    timers.advance(1)
    expect(sent()).toStrictEqual([
      { onScreenMineIds: [OTHER_MINE], anyWindowVisible: true, seq: 1 }
    ])

    tracker.report(PANEL, [OTHER_MINE]) // the same set: no change, nothing sent
    timers.advance(PRESENCE_DEBOUNCE_MS)
    tracker.windowsChanged()
    expect(sent()).toHaveLength(1)

    tracker.report(PANEL, [])
    timers.advance(PRESENCE_DEBOUNCE_MS)
    expect(sent()).toStrictEqual([
      { onScreenMineIds: [OTHER_MINE], anyWindowVisible: true, seq: 1 },
      { onScreenMineIds: [], anyWindowVisible: true, seq: 2 }
    ])
  })

  it('[ADR-024] a hidden mode window contributes no mine', () => {
    const { tracker, timers, visible, sent } = world()
    visible.clear()
    visible.add(OTHER_WINDOW) // the shown mode window; the Panel is hidden
    tracker.report(PANEL, [MINE])
    tracker.report(OTHER_WINDOW, [OTHER_MINE])
    timers.advance(PRESENCE_DEBOUNCE_MS)
    // The Panel's report settled first and added nothing; then the shown window's.
    expect(sent()).toStrictEqual([
      { onScreenMineIds: [], anyWindowVisible: true, seq: 1 },
      { onScreenMineIds: [OTHER_MINE], anyWindowVisible: true, seq: 2 }
    ])

    visible.clear() // the shown window closes: nothing is on screen
    tracker.windowClosed(OTHER_WINDOW)
    expect(sent().at(-1)).toStrictEqual({ onScreenMineIds: [], anyWindowVisible: false, seq: 3 })
  })
})
