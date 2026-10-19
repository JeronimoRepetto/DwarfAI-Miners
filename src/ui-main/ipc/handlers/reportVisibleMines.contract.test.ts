// layer: L6
// L6 (17 §1.6): A-44 `reportVisibleMines` (14 §2.1 row A-44, CHANGE; ADR-019 items 7, 8; ADR-024 item 7) through the
// real router and seam A gate, served `ui-local` in its 14 shape as the cut-1 switch will route it (ISSUE-123), and
// feeding the real PresenceTracker over the recording HostClient. A one-way call the gate refuses is dropped and
// counted, never answered.
//
// TC-111-01, TC-111-03.
import { describe, expect, it } from 'vitest'
import type { ChannelKey, MineId } from '@dwarfai/contracts'
import { FakeHostClientTimers } from '../../host-client/testing/FakeHostClientTimers'
import {
  createPresenceTracker,
  PRESENCE_DEBOUNCE_MS
} from '../../window/application/presenceTracker'
import { RecordingHostClient } from '../../window/ports/fakes/RecordingHostClient'
import type { Presence } from '../../window/ports/hostClient'
import type { ChannelRoute } from '../channelRoute'
import { createRouter, type RouteTarget } from '../router'
import type { IpcSenderEvent, SenderPolicy } from '../senderCheck'
import { createReportVisibleMinesRow, REPORT_VISIBLE_MINES } from './reportVisibleMines'

const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const STRANGER_ID = 99
const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id === PANEL_ID }
const FROM_PANEL: IpcSenderEvent = { sender: { id: PANEL_ID }, senderFrame: { url: APP_ENTRY } }
const FROM_STRANGER: IpcSenderEvent = {
  sender: { id: STRANGER_ID },
  senderFrame: { url: APP_ENTRY }
}
const FROM_FOREIGN_PAGE: IpcSenderEvent = {
  sender: { id: PANEL_ID },
  senderFrame: { url: 'https://example.invalid/index.html' }
}
const MINE = '01890a5d-ac96-774b-bcce-b302099a8111' as MineId

/** A-44 as the cut-1 switch routes it: `ui-local`, its 14 shape. */
const ROUTE: ChannelRoute = {
  channel: REPORT_VISIBLE_MINES satisfies ChannelKey,
  owner: 'ui-local',
  since: 'cut-1',
  parity: 'n/a',
  shape: 'target'
}

function world() {
  const host = new RecordingHostClient()
  const timers = new FakeHostClientTimers()
  const tracker = createPresenceTracker({ host, timers, visibleWindows: () => [PANEL_ID] })
  const legacy: RouteTarget = { serve: () => Promise.reject(new Error('never legacy')) }
  const router = createRouter({
    routes: [ROUTE],
    legacy,
    uiLocal: createReportVisibleMinesRow(tracker),
    senders
  })
  const sent = (): Presence[] =>
    host.calls.flatMap((c) => (c.member === 'reportPresence' ? [c.presence] : []))
  return { router, timers, sent }
}

describe('reportVisibleMines over seam A (14 A-44)', () => {
  it('[ADR-019] reportVisibleMines validates { mineIds } in main and rejects extra keys and unknown senders', async () => {
    const { router, timers, sent } = world()
    const refused: Array<[IpcSenderEvent, unknown]> = [
      [FROM_PANEL, { mineIds: [MINE], extra: true }],
      [FROM_PANEL, { mineIds: ['mine-1'] }],
      [FROM_PANEL, MINE], // today's shape is not the 14 shape
      [FROM_PANEL, { mineIds: MINE }],
      [FROM_STRANGER, { mineIds: [MINE] }],
      [FROM_FOREIGN_PAGE, { mineIds: [MINE] }]
    ]
    for (const [sender, payload] of refused) {
      expect(await router.dispatch(REPORT_VISIBLE_MINES, sender, payload)).toBeUndefined()
    }
    timers.advance(PRESENCE_DEBOUNCE_MS)
    expect(sent()).toStrictEqual([])
    expect(router.refusalCount(REPORT_VISIBLE_MINES, 'INVALID_PARAMS')).toBe(4)
    expect(router.refusalCount(REPORT_VISIBLE_MINES, 'SENDER_REJECTED')).toBe(2)

    expect(
      await router.dispatch(REPORT_VISIBLE_MINES, FROM_PANEL, { mineIds: [MINE] })
    ).toBeUndefined()
    timers.advance(PRESENCE_DEBOUNCE_MS)
    expect(sent()).toStrictEqual([{ onScreenMineIds: [MINE], anyWindowVisible: true, seq: 1 }])
  })
})
