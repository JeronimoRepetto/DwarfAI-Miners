// layer: L6
import { describe, expect, it } from 'vitest'
import { CHANNELS, UNROUTED, type ChannelKey } from '@dwarfai/contracts'
import { InMemorySessionStore } from '../../window/adapters/InMemorySessionStore'
import { RecordingHostClient } from '../../window/ports/fakes/RecordingHostClient'
import { createUiSession, UI_SESSION_CHANGED_PUSH } from '../../window/application/uiSession'
import type { ChannelRoute } from '../channelRoute'
import { createRouter, type RouteTarget } from '../router'
import type { IpcSenderEvent, SenderPolicy } from '../senderCheck'
import { createUiSessionRows, UI_SESSION_GET, UI_SESSION_PATCH, UI_SESSION_ROWS } from './uiSession'

/**
 * A-N17 `getUiSession`, A-N18 `patchUiSession`, A-N19 `onUiSessionChanged` (14 §2.2, §3.9; ADR-024 items 1, 3): the
 * real router and seam A gate in front of the real session store. The rows are unrouted until the cut-1 switch
 * (ISSUE-123), so the routes here are the ones that switch gives them: `ui-local`, `target`, from the registry's own
 * placement.
 */
const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const VETA_ID = 8
const MODES: Readonly<Record<number, 'panel' | 'veta'>> = { [PANEL_ID]: 'panel', [VETA_ID]: 'veta' }
const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id in MODES }
const from = (id: number): IpcSenderEvent => ({ sender: { id }, senderFrame: { url: APP_ENTRY } })
const BORIN = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01'
const MESSAGE = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1d01'

const routeOf = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: CHANNELS[channel].placement === 'ui-local' ? 'ui-local' : 'host',
  since: 'cut-1',
  parity: 'n/a',
  shape: 'target'
})

function world() {
  const host = new RecordingHostClient()
  const pushes: Array<{ to: number; push: string; payload: unknown }> = []
  const session = createUiSession({
    store: new InMemorySessionStore(),
    windows: () =>
      [PANEL_ID, VETA_ID].map((id) => ({
        webContentsId: id,
        send: (push: string, payload: unknown) => void pushes.push({ to: id, push, payload })
      })),
    host
  })
  const rows = createUiSessionRows(session, (id) => MODES[id])
  const legacy: RouteTarget = { serve: () => Promise.reject(new Error('never legacy')) }
  const router = createRouter({
    routes: UI_SESSION_ROWS.map(routeOf),
    legacy,
    uiLocal: rows,
    senders
  })
  return { host, pushes, router }
}

describe('the UI session rows over seam A (14 §2.2 A-N17…A-N19)', () => {
  it('[ADR-024] A-N17, A-N18, A-N19 validate UiSessionSnapshot and UiSessionPatch strictly and an unknown patch kind is dropped', async () => {
    const { host, pushes, router } = world()
    // The registry places the three rows `ui-local`, unrouted until the cut-1 switch routes them.
    for (const key of ['ui:session:get', 'ui:session:patch', 'ui:session:changed'] as const) {
      expect(CHANNELS[key].placement, key).toBe('ui-local')
      expect(UNROUTED[key], key).toBe('cut-1')
    }
    const snapshotSchema = CHANNELS['ui:session:get'].response
    const changeSchema = CHANNELS['ui:session:changed'].response

    // A-N18 from the Panel: applied, and pushed to Veta (A-N19) with its origin, in the registry's push shape.
    const patch = {
      kind: 'chat-view',
      dwarfId: BORIN,
      view: { scrollAnchor: { messageId: MESSAGE, offsetPx: 16 } }
    }
    expect(await router.dispatch(UI_SESSION_PATCH, from(PANEL_ID), patch)).toBeUndefined()
    expect(pushes).toEqual([
      { to: VETA_ID, push: UI_SESSION_CHANGED_PUSH, payload: { ...patch, origin: 'panel' } }
    ])
    expect(changeSchema.safeParse(pushes[0]?.payload).success).toBe(true)

    // A-N17 from Veta: the whole store, valid under the strict snapshot schema.
    const snapshot = await router.dispatch(UI_SESSION_GET, from(VETA_ID), undefined)
    expect(snapshotSchema.safeParse(snapshot).success).toBe(true)
    expect(snapshot).toEqual({
      drafts: {},
      chatViews: { [BORIN]: patch.view },
      askPicks: {},
      openChat: {},
      currentMine: {},
      valle: {}
    })
    // The snapshot schema is strict: an extra field, here or in a nested object, is refused.
    expect(snapshotSchema.safeParse({ ...(snapshot as object), presence: {} }).success).toBe(false)
    expect(snapshotSchema.safeParse({ ...(snapshot as object), valle: { zoom: 2 } }).success).toBe(
      false
    )

    // An unknown patch kind, an extra key, a wrong type or a draft that is not for a DwarfId: each is dropped by the
    // gate and counted; nothing changes and nothing is pushed.
    const invalid: unknown[] = [
      { kind: 'cleared-except-drafts' },
      { kind: 'draft', dwarfId: BORIN, text: 'x', origin: 'panel' },
      { kind: 'draft', dwarfId: BORIN, text: 3 },
      { kind: 'draft', dwarfId: 'claude:legacy-session', text: 'x' },
      { kind: 'current-mine', host: 'veta', mineId: null }
    ]
    for (const payload of invalid) {
      expect(await router.dispatch(UI_SESSION_PATCH, from(PANEL_ID), payload)).toBeUndefined()
    }
    expect(router.refusalCount(UI_SESSION_PATCH, 'INVALID_PARAMS')).toBe(invalid.length)
    expect(await router.dispatch(UI_SESSION_GET, from(PANEL_ID), undefined)).toEqual(snapshot)
    expect(pushes).toHaveLength(1)

    // A-N17 takes no payload; a call with one is refused.
    expect(await router.dispatch(UI_SESSION_GET, from(PANEL_ID), { all: true })).toMatchObject({
      ok: false,
      error: { code: 'INVALID_PARAMS' }
    })
    // Nothing of the session reached the Host.
    expect(host.calls).toEqual([{ member: 'subscribe' }])
  })
})
