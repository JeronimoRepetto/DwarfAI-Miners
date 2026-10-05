// layer: L6
import { describe, expect, it } from 'vitest'
import { CHANNELS, UNROUTED, type ChannelKey } from '@dwarfai/contracts'
import { createStartWithSystem } from '../../window/application/startWithSystem'
import { createUiPreferenceMap } from '../../window/application/uiPreferenceMap'
import { FakeAutostartPort } from '../../window/ports/fakes/FakeAutostartPort'
import { InMemoryUiPreferenceStore } from '../../window/ports/fakes/InMemoryUiPreferenceStore'
import type { ChannelRoute } from '../channelRoute'
import { createRouter, type RouteTarget } from '../router'
import type { IpcSenderEvent, SenderPolicy } from '../senderCheck'
import {
  createUiPreferenceMapRows,
  UI_PREFERENCE_MAP_ROWS,
  UI_PREFERENCES_GET,
  UI_PREFERENCES_SET
} from './uiPreferenceMap'

/**
 * A-N20 `getUiPreferences`, A-N21 `setUiPreference` (14 §2.2, §3.9; ADR-024 items 1, 9; AMENDMENT-6): the real router
 * and seam A gate in front of the real use cases over the store and login-entry doubles. The rows are unrouted until
 * the cut-1 switch (ISSUE-123), so the routes here are the ones that switch gives them: `ui-local`, `target`.
 */
const APP_ENTRY = 'file:///opt/DwarfAI/out/renderer/index.html'
const PANEL_ID = 7
const senders: SenderPolicy = { appEntry: APP_ENTRY, isModeWindow: (id) => id === PANEL_ID }
const FROM_PANEL: IpcSenderEvent = { sender: { id: PANEL_ID }, senderFrame: { url: APP_ENTRY } }

const routeOf = (channel: ChannelKey): ChannelRoute => ({
  channel,
  owner: 'ui-local',
  since: 'cut-1',
  parity: 'n/a',
  shape: 'target'
})

/** The rows composed as UI main composes them; `loginEntry` = S-027-4 passed on this OS (the gate is open). */
function world(loginEntry = true) {
  const store = new InMemoryUiPreferenceStore()
  const entry = new FakeAutostartPort()
  // With the gate closed UI main composes no "Start with the system" at all (loginEntryGate.ts).
  const startWithSystem = loginEntry
    ? createStartWithSystem({ autostart: entry, store, log: () => {} })
    : undefined
  startWithSystem?.applyAtStart()
  const map = createUiPreferenceMap(startWithSystem === undefined ? {} : { startWithSystem })
  const legacy: RouteTarget = { serve: () => Promise.reject(new Error('never legacy')) }
  const router = createRouter({
    routes: UI_PREFERENCE_MAP_ROWS.map(routeOf),
    legacy,
    uiLocal: createUiPreferenceMapRows(map),
    senders
  })
  return { router, entry, store }
}

describe('the UI preference map rows over seam A (14 §2.2 A-N20, A-N21)', () => {
  it('[ADR-024] setUiPreference answers the verified value, and lastMode or resetEpochApplied from a renderer is INVALID_PARAMS', async () => {
    for (const key of UI_PREFERENCE_MAP_ROWS) {
      expect(CHANNELS[key].placement, key).toBe('ui-local')
      expect(UNROUTED[key], key).toBe('cut-1')
    }
    const { router, entry, store } = world()
    const answerSchema = CHANNELS[UI_PREFERENCES_SET].response

    // The OS refuses the removal: the answer is the stored real state, ON, not the OFF that was asked for.
    entry.refuse = 'next'
    const refused = await router.dispatch(UI_PREFERENCES_SET, FROM_PANEL, {
      key: 'startWithSystem',
      value: false
    })
    expect(refused).toEqual({ key: 'startWithSystem', value: true })
    expect(answerSchema.safeParse(refused).success).toBe(true)
    // Accepted: the entry is removed, read back, and OFF is stored and answered.
    expect(
      await router.dispatch(UI_PREFERENCES_SET, FROM_PANEL, {
        key: 'startWithSystem',
        value: false
      })
    ).toEqual({ key: 'startWithSystem', value: false })
    expect(store.load('startWithSystem')).toBe(false)

    // UI main's own keys, a key not built, an extra field or a wrong type: refused by the gate, never written.
    const invalid: unknown[] = [
      { key: 'lastMode', value: 'panel' },
      { key: 'resetEpochApplied', value: 3 },
      { key: 'vetaDock', value: {} },
      { key: 'startWithSystem', value: 'yes' },
      { key: 'startWithSystem', value: true, origin: 'panel' }
    ]
    for (const payload of invalid) {
      expect(await router.dispatch(UI_PREFERENCES_SET, FROM_PANEL, payload)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
    expect(router.refusalCount(UI_PREFERENCES_SET, 'INVALID_PARAMS')).toBe(invalid.length)
    expect(store.load('startWithSystem')).toBe(false)
    expect(entry.entry).toBe('absent')
  })

  it('[ADR-024] getUiPreferences answers the stored value of each asked key and nothing for a key not asked', async () => {
    const { router } = world()
    const answerSchema = CHANNELS[UI_PREFERENCES_GET].response

    const asked = await router.dispatch(UI_PREFERENCES_GET, FROM_PANEL, {
      keys: ['startWithSystem']
    })
    expect(asked).toEqual({ startWithSystem: true })
    expect(answerSchema.safeParse(asked).success).toBe(true)
    // Not asked: nothing. Asked but not built yet (a Veta or Valle key, ADR-034): nothing either.
    expect(await router.dispatch(UI_PREFERENCES_GET, FROM_PANEL, { keys: [] })).toEqual({})
    expect(
      await router.dispatch(UI_PREFERENCES_GET, FROM_PANEL, { keys: ['vetaDock', 'lastMode'] })
    ).toEqual({})
    // A key 14 §3.9 does not have, or no key list at all: refused.
    for (const payload of [{ keys: ['theme'] }, {}, undefined]) {
      expect(await router.dispatch(UI_PREFERENCES_GET, FROM_PANEL, payload)).toMatchObject({
        ok: false,
        error: { code: 'INVALID_PARAMS' }
      })
    }
  })

  it('[S-027-4] while S-027-4 has not passed on this OS, Start with the system is neither answered nor written', async () => {
    const { router, entry, store } = world(false)
    expect(
      await router.dispatch(UI_PREFERENCES_GET, FROM_PANEL, { keys: ['startWithSystem'] })
    ).toEqual({})
    expect(
      await router.dispatch(UI_PREFERENCES_SET, FROM_PANEL, {
        key: 'startWithSystem',
        value: false
      })
    ).toMatchObject({ ok: false, error: { code: 'NOT_SUPPORTED', retryable: false } })
    expect(entry.calls).toEqual([])
    expect(store.storage.stored).toEqual({})
  })
})
