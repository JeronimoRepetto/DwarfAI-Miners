// layer: L2
import { describe, expect, it } from 'vitest'
import type { DwarfId, EvtFrame, MessageId, SnapshotPage } from '@dwarfai/contracts'
import { InMemorySessionStore } from '../adapters/InMemorySessionStore'
import { defaultsOf } from '../domain/uiPreferenceValues'
import { FakeAutostartPort } from '../ports/fakes/FakeAutostartPort'
import {
  createInMemoryUiPreferenceStorage,
  InMemoryUiPreferenceStore
} from '../ports/fakes/InMemoryUiPreferenceStore'
import { RecordingHostClient } from '../ports/fakes/RecordingHostClient'
import type { HostEvent } from '../ports/hostClient'
import type { UiPreferenceStoreKey } from '../ports/uiPreferenceStore'
import { NON_DEFAULT_VALUES, STORE_KEYS } from '../testing/uiPreferenceStore.contract'
import { createStartWithSystem, type AutostartRegisterRecord } from './startWithSystem'
import { createUiPreferencesReset } from './uiPreferencesReset'
import { createUiSession } from './uiSession'

/**
 * The Reset metrics UI step (ADR-024 item 8; ADR-023 item 4 step 5; 07 S13.04, S13.09, S40.10; 14 §4.3 rule 4): on the
 * Host's `ui.resetPreferences {epoch}`, or at attach when the snapshot's `meta.resetEpoch` is newer than the epoch UI
 * main applied last, every persisted UI store returns to its defaults, the session store is emptied but for its drafts,
 * "Start with the system" returns to ON and is applied, the epoch is stored, every window is told (A-N12), and the Host
 * gets its acknowledgement (B-M09) whatever happened to the login entry.
 */
const BORIN = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a01' as DwarfId
const DAIN = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a02' as DwarfId
const MESSAGE = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1d01' as MessageId
const ASK = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1e01'
const MINE = 'mine-7'

/** The stores this step returns to their defaults itself (not `startWithSystem`, not `resetEpochApplied`). */
const PLAIN_KEYS: readonly UiPreferenceStoreKey[] = STORE_KEYS.filter(
  (key) => key !== 'startWithSystem' && key !== 'resetEpochApplied'
)

/** UI main with every store away from its defaults, an entry the OS holds OFF, and a session with work in it. */
function world({ applied = 0 }: { applied?: number } = {}) {
  const storage = createInMemoryUiPreferenceStorage()
  const store = new InMemoryUiPreferenceStore(storage)
  for (const key of STORE_KEYS) store.save(key, structuredClone(NON_DEFAULT_VALUES[key]))
  store.save('resetEpochApplied', applied)
  const entry = new FakeAutostartPort()
  const logged: AutostartRegisterRecord[] = []
  const startWithSystem = createStartWithSystem({
    autostart: entry,
    store,
    log: (record) => logged.push(record)
  })
  const recording = new RecordingHostClient()
  /** What reached the windows and the Host, in order. */
  const trace: string[] = []
  const acks: unknown[] = []
  const host = {
    subscribe: recording.subscribe.bind(recording),
    call: ((method: string, params: unknown) => {
      trace.push(method)
      if (method === 'ui.resetPreferences.ack') acks.push(params)
      return recording.call(method as 'ui.resetPreferences.ack', params as { epoch: number })
    }) as RecordingHostClient['call']
  }
  const session = createUiSession({ store: new InMemorySessionStore(), windows: () => [], host })
  const origin = { webContentsId: 7, mode: 'panel' as const }
  session.patch({ kind: 'draft', dwarfId: BORIN, text: 'half a thought' }, origin)
  session.patch(
    {
      kind: 'chat-view',
      dwarfId: BORIN,
      view: { scrollAnchor: { messageId: MESSAGE, offsetPx: 16 } }
    },
    origin
  )
  session.patch({ kind: 'chat-view', dwarfId: DAIN, view: { scrollAnchor: 'bottom' } }, origin)
  session.patch({ kind: 'ask-picks', askId: ASK as never, picks: {} as never }, origin)
  session.patch({ kind: 'open-chat', host: 'panel', dwarfId: BORIN }, origin)
  session.patch({ kind: 'current-mine', host: 'panel', mineId: MINE as never }, origin)
  /** The windows: each push A-N12 carries, per window. */
  const windows: Array<{ to: number; reset: { epoch: number } }> = []
  const reset = createUiPreferencesReset({
    store,
    session,
    startWithSystem,
    push: (payload) => {
      trace.push('onUiPreferencesReset')
      for (const to of [7, 8]) windows.push({ to, reset: payload })
    },
    host
  })
  const stopListening = reset.listen()
  return {
    storage,
    store,
    entry,
    logged,
    recording,
    trace,
    acks,
    session,
    windows,
    reset,
    stopListening
  }
}

function resetFrame(epoch: number, seq = 9): HostEvent {
  const frame = { type: 'evt', seq, epoch: 'boot-1', name: 'ui.resetPreferences', data: { epoch } }
  return { kind: 'frame', frame: frame as unknown as EvtFrame }
}

function snapshotWith(resetEpoch: number, seq = 4): HostEvent {
  const snapshot = {
    snapshotId: 's-1',
    seq,
    epoch: 'boot-1',
    chunks: [
      {
        section: 'meta',
        data: {
          hostVersion: '0.20.0',
          state: 'ready',
          resetEpoch,
          snapshotTail: 20,
          minesEverKnown: false
        }
      }
    ]
  }
  return { kind: 'snapshot', snapshot: snapshot as unknown as SnapshotPage }
}

describe('the Reset metrics UI step (ADR-024 item 8)', () => {
  it('[ADR-024] ui.resetPreferences rewrites every UI store to its defaults and stores the new resetEpochApplied', () => {
    const { store, recording, acks } = world()

    recording.deliver(resetFrame(3))

    for (const key of PLAIN_KEYS) expect(store.load(key), key).toEqual(defaultsOf(key))
    expect(store.load('resetEpochApplied')).toBe(3)
    expect(acks).toEqual([{ epoch: 3 }])
  })

  it('[ADR-024] the session store is cleared except drafts', () => {
    const { session, recording } = world()

    recording.deliver(resetFrame(3))

    // INV-113: the drafts are UI-memory only and survive the reset; everything else of the session goes.
    expect(session.get()).toEqual({
      drafts: { [BORIN]: 'half a thought' },
      chatViews: {},
      askPicks: {},
      openChat: {},
      currentMine: {},
      valle: {}
    })
  })

  it('[S40.10] Start with the system returns to ON and is applied, and the ack is sent even when the OS refuses the entry', () => {
    // Applied: the entry is written and read back, and the verified ON is stored.
    const applied = world()
    applied.recording.deliver(resetFrame(3))
    expect(applied.entry.entry).toBe('enabled')
    expect(applied.store.load('startWithSystem')).toBe(true)
    expect(applied.logged.at(-1)).toMatchObject({ causeClass: 'written', msg: 'reset on' })
    expect(applied.acks).toEqual([{ epoch: 3 }])

    // Refused: the real state (OFF) is stored, the refusal logged, and the reset still completes and acks.
    const refused = world()
    refused.entry.refuse = 'always'
    refused.recording.deliver(resetFrame(3))
    expect(refused.entry.entry).toBe('absent')
    expect(refused.store.load('startWithSystem')).toBe(false)
    expect(refused.logged.at(-1)).toMatchObject({
      level: 'warn',
      causeClass: 'failed',
      errCode: 'EACCES',
      msg: 'reset on'
    })
    for (const key of PLAIN_KEYS) expect(refused.store.load(key), key).toEqual(defaultsOf(key))
    expect(refused.store.load('resetEpochApplied')).toBe(3)
    expect(refused.windows).toEqual([
      { to: 7, reset: { epoch: 3 } },
      { to: 8, reset: { epoch: 3 } }
    ])
    expect(refused.acks).toEqual([{ epoch: 3 }])
  })

  it('[ADR-023] every open window receives onUiPreferencesReset with the epoch before the ack is sent', () => {
    const { recording, windows, trace } = world()

    recording.deliver(resetFrame(3))

    expect(windows).toEqual([
      { to: 7, reset: { epoch: 3 } },
      { to: 8, reset: { epoch: 3 } }
    ])
    expect(trace).toEqual(['onUiPreferencesReset', 'ui.resetPreferences.ack'])
  })

  it('[ADR-024] at attach a snapshot resetEpoch newer than the applied one runs the same reset once', () => {
    const { store, session, recording, windows, acks, entry } = world({ applied: 1 })

    recording.deliver(snapshotWith(2))
    // A re-snapshot of the same Host state (a resync, a new subscriber) carries the same epoch: nothing runs again.
    recording.deliver(snapshotWith(2, 6))

    for (const key of PLAIN_KEYS) expect(store.load(key), key).toEqual(defaultsOf(key))
    expect(store.load('resetEpochApplied')).toBe(2)
    expect(store.load('startWithSystem')).toBe(true)
    expect(entry.writes).toBe(1)
    expect(session.get().chatViews).toEqual({})
    expect(windows).toEqual([
      { to: 7, reset: { epoch: 2 } },
      { to: 8, reset: { epoch: 2 } }
    ])
    expect(acks).toEqual([{ epoch: 2 }])
  })

  it('[ADR-024] an epoch already applied is not applied again and is acked once more', () => {
    const { store, recording, windows, acks, entry } = world()
    recording.deliver(resetFrame(3))
    expect(store.load('resetEpochApplied')).toBe(3)
    // The person changes a store after the reset; the Host sends the same epoch again (it was not attached when the
    // first ack left, or the attach-time check ran first): nothing is reset, and the Host still gets its ack.
    store.save('dockSide', 'left')

    recording.deliver(resetFrame(3))
    recording.deliver(snapshotWith(3))

    expect(store.load('dockSide')).toBe('left')
    expect(entry.writes).toBe(1)
    expect(windows).toHaveLength(2)
    expect(acks).toEqual([{ epoch: 3 }, { epoch: 3 }])
  })
})
