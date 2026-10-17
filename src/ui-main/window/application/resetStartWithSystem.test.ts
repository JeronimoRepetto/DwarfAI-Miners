// layer: L2
// L2 (17 §1.2): the UI-main half of the Reset saga's `ui-prefs` step for "Start with the system"
// (ADR-023 item 1; 07 S13.04, S40.10; ADR-024 item 8). The person turned the option off, so the
// login entry is gone; the Host's `ui.resetPreferences {epoch}` (B-F26) then turns it on again and
// the login entry exists, and the Host gets its acknowledgement (B-M09). Lead decision 2026-10-16
// (ISSUE-233): this case lives in UI main, because the Host never imports the UI trees (05 R10), so
// the Host flow suite proves only that the step reaches every attached UI.
//
// TC-233-03 (the "Start with the system" half).
import { describe, expect, it } from 'vitest'
import type { EvtFrame } from '@dwarfai/contracts'
import { InMemorySessionStore } from '../adapters/InMemorySessionStore'
import { FakeAutostartPort } from '../ports/fakes/FakeAutostartPort'
import {
  createInMemoryUiPreferenceStorage,
  InMemoryUiPreferenceStore
} from '../ports/fakes/InMemoryUiPreferenceStore'
import { RecordingHostClient } from '../ports/fakes/RecordingHostClient'
import type { HostEvent } from '../ports/hostClient'
import { createStartWithSystem } from './startWithSystem'
import { createUiPreferencesReset } from './uiPreferencesReset'
import { createUiSession } from './uiSession'

function resetFrame(epoch: number): HostEvent {
  const frame = {
    type: 'evt',
    seq: 9,
    epoch: 'boot-1',
    name: 'ui.resetPreferences',
    data: { epoch }
  }
  return { kind: 'frame', frame: frame as unknown as EvtFrame }
}

/** UI main with "Start with the system" on and its login entry written, as at first start. */
function world() {
  const store = new InMemoryUiPreferenceStore(createInMemoryUiPreferenceStorage())
  const entry = new FakeAutostartPort()
  const startWithSystem = createStartWithSystem({ autostart: entry, store, log: () => undefined })
  startWithSystem.applyAtStart()
  const host = new RecordingHostClient()
  const acks: unknown[] = []
  const calls = {
    subscribe: host.subscribe.bind(host),
    call: ((method: string, params: unknown) => {
      if (method === 'ui.resetPreferences.ack') acks.push(params)
      return host.call(method as 'ui.resetPreferences.ack', params as { epoch: number })
    }) as RecordingHostClient['call']
  }
  const reset = createUiPreferencesReset({
    store,
    session: createUiSession({ store: new InMemorySessionStore(), windows: () => [], host: calls }),
    startWithSystem,
    push: () => undefined,
    host: calls
  })
  reset.listen()
  return { store, entry, startWithSystem, host, acks }
}

describe('Reset metrics and Start with the system (07 S40.10)', () => {
  it('[US-SET-010.AC10, S40.10] Start with the system reads on again and the login entry exists', () => {
    const { store, entry, startWithSystem, host, acks } = world()
    // The person turned it off: the setting reads off and no login entry remains.
    startWithSystem.toggle(false)
    expect(store.load('startWithSystem')).toBe(false)
    expect(entry.entry).toBe('absent')

    host.deliver(resetFrame(4))

    expect(store.load('startWithSystem')).toBe(true)
    expect(startWithSystem.stored()).toBe(true)
    expect(entry.entry).toBe('enabled')
    expect(entry.get()).toBe(true)
    expect(acks).toStrictEqual([{ epoch: 4 }])
  })
})
