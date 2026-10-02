// layer: L2
// L2 (17 §1.2): the attention policy over FakeAttentionSettings, InMemoryAttentionLedger and a
// recording bus that refuses a publish inside a transaction (16 §2.3); machine 17 (07 §17).
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type {
  AttentionFact,
  Level3Names,
  Level3TitleFormatter,
  Presence
} from '../domain/decideLevel3'
import type { AttentionEvent } from '../domain/events'
import { FakeAttentionSettings } from '../ports/fakes/FakeAttentionSettings'
import { InMemoryAttentionLedger } from '../ports/fakes/InMemoryAttentionLedger'
import { AttentionPolicy } from './attentionPolicy'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-0109'
const DWARF = 'dwarf-0001' as DwarfId
const MINE = 'mine-0001' as MineId
const OTHER_MINE = 'mine-0002' as MineId
const NAMES: Level3Names = { displayName: 'Gimli', mineName: 'Moria' }
const TITLE: Level3TitleFormatter = (kind, name) => `title(${kind}, ${name})`

const ASK: AttentionFact = {
  key: `${DWARF}:question:ask-1`,
  kind: 'question',
  dwarfId: DWARF,
  mineId: MINE,
  at: T0,
  reannounce: true
}

function report(seq: number, onScreen: readonly MineId[], anyWindowVisible = true): Presence {
  return { anyUiAttached: true, anyWindowVisible, onScreenMineIds: new Set(onScreen), seq }
}

function policy() {
  const settings = new FakeAttentionSettings()
  const ledger = new InMemoryAttentionLedger()
  let open = false
  const transactions: TransactionRunner = {
    inTransaction<T>(work: () => T): T {
      open = true
      try {
        return work()
      } finally {
        open = false
      }
    }
  }
  const bus = new RecordingEventBus<AttentionEvent>({
    transactionScope: { isInTransaction: () => open }
  })
  const attention = new AttentionPolicy({
    settings,
    ledger,
    transactions,
    bus,
    clock: new FakeClock(T0),
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH,
    titles: TITLE
  })
  return { attention, settings, ledger, bus }
}

describe('AttentionInputs.onFact (16 §4.11)', () => {
  it('[S17.03] a gated ask becomes a notification when the mine leaves the screen while the ask is still open', () => {
    const { attention, ledger, bus } = policy()
    attention.presenceChanged('ui-1', report(1, [MINE]))

    attention.onFact(ASK, NAMES)
    expect(bus.published).toStrictEqual([])
    expect(ledger.writes).toStrictEqual([])

    attention.presenceChanged('ui-1', report(2, [OTHER_MINE]))
    attention.presenceChanged('ui-1', report(3, []))

    expect(bus.ofType('AttentionNotified')).toStrictEqual([
      {
        type: 'AttentionNotified',
        v: 1,
        id: expect.any(String) as string,
        at: T0,
        hostEpoch: EPOCH,
        payload: {
          key: ASK.key,
          dwarfId: DWARF,
          mineId: MINE,
          kind: 'question',
          notification: {
            key: ASK.key,
            kind: 'question',
            title: 'title(question, Gimli)',
            body: 'Moria',
            mineId: MINE,
            dwarfId: DWARF,
            sensitive: true
          }
        }
      }
    ])
    expect(ledger.writes).toStrictEqual([
      { key: ASK.key, dwarfId: DWARF, kind: 'question', suppressed: false }
    ])
  })

  it('[S17.01] an ask arriving with no ui attached still notifies once through the notifier path', () => {
    const { attention, ledger, bus } = policy()

    attention.onFact(ASK, NAMES)
    attention.onFact(ASK, NAMES)
    attention.presenceChanged('ui-1', report(1, []))

    expect(bus.ofType('AttentionNotified').map((e) => e.payload.notification.title)).toStrictEqual([
      'title(question, Gimli)'
    ])
    expect(ledger.writes).toStrictEqual([
      { key: ASK.key, dwarfId: DWARF, kind: 'question', suppressed: false }
    ])
  })

  it('[S17.08] a turn-finished fact is suppressed with no ui attached and never shown because a ui client re-attached', () => {
    const turn: AttentionFact = {
      ...ASK,
      key: `${DWARF}:turn-finished:turn-7`,
      kind: 'turn-finished'
    }
    const gatedTurn: AttentionFact = { ...turn, key: `${DWARF}:turn-finished:turn-8` }
    const { attention, ledger, bus } = policy()

    attention.onFact(turn, NAMES) // the app is closed
    attention.presenceChanged('ui-1', report(1, [MINE])) // a window opens, the mine on screen
    attention.onFact(gatedTurn, NAMES) // gated
    attention.presenceChanged('ui-1', 'detached') // the last window closes
    attention.presenceChanged('ui-2', report(1, [])) // a window re-attaches, nothing on screen

    expect(bus.published).toStrictEqual([])
    expect(ledger.writes).toStrictEqual([
      { key: turn.key, dwarfId: DWARF, kind: 'turn-finished', suppressed: true },
      { key: gatedTurn.key, dwarfId: DWARF, kind: 'turn-finished', suppressed: true }
    ])
  })

  it('[S17.03] an older presence report of a client is ignored, and a gate opened by another client counts', () => {
    const { attention, bus } = policy()
    attention.presenceChanged('ui-1', report(5, [MINE]))
    attention.presenceChanged('ui-2', report(1, [MINE]))
    attention.onFact(ASK, NAMES)

    attention.presenceChanged('ui-1', report(4, [])) // older than seq 5: still on screen in ui-1
    attention.presenceChanged('ui-2', report(2, []))
    expect(bus.published).toStrictEqual([])

    attention.presenceChanged('ui-1', report(6, []))
    expect(bus.ofType('AttentionNotified')).toHaveLength(1)
  })

  it('[S17.03] a gated ask becomes a notification when system notifications are turned on while it is still open', () => {
    const { attention, settings, ledger, bus } = policy()
    settings.set(false)
    attention.onFact(ASK, NAMES)
    attention.preferencesChanged()
    expect(bus.published).toStrictEqual([])

    settings.set(true)
    attention.preferencesChanged()
    attention.preferencesChanged()

    expect(bus.ofType('AttentionNotified')).toHaveLength(1)
    expect(ledger.writes).toStrictEqual([
      { key: ASK.key, dwarfId: DWARF, kind: 'question', suppressed: false }
    ])
  })
})
