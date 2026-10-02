// layer: L2
// L2 (17 §1.2): the presence half of the attention policy (16 §4.11 row `presenceChanged`; ADR-018
// item 2; ADR-024 D7; INV-101; machine 17 S17.03, S17.08) over FakeAttentionSettings,
// InMemoryAttentionLedger and a recording bus that refuses a publish inside a transaction (16 §2.3).
// The on-screen set is observed through what the policy decides for an open fact.
//
// TC-111-01, TC-111-02.
import { describe, expect, it } from 'vitest'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { AttentionFact, Level3Names, Presence } from '../domain/decideLevel3'
import type { AttentionEvent } from '../domain/events'
import { FakeAttentionSettings } from '../ports/fakes/FakeAttentionSettings'
import { InMemoryAttentionLedger } from '../ports/fakes/InMemoryAttentionLedger'
import { AttentionPolicy } from './attentionPolicy'
import { RecordingLevel3Sink } from '../ports/fakes/RecordingLevel3Sink'

const T0 = 1_790_000_000_000
const DWARF = 'dwarf-0111' as DwarfId
const MINE = 'mine-0111' as MineId
const OTHER_MINE = 'mine-0112' as MineId
const NAMES: Level3Names = { displayName: 'Gimli', mineName: 'Moria' }

const ask = (id: string, mineId: MineId): AttentionFact => ({
  key: `${DWARF}:question:${id}`,
  kind: 'question',
  dwarfId: DWARF,
  mineId,
  at: T0,
  reannounce: true
})

/** One `ui` client's report, as the transport hands it on (B-M07). */
function report(seq: number, onScreen: readonly MineId[]): Presence {
  return { anyUiAttached: true, anyWindowVisible: true, onScreenMineIds: new Set(onScreen), seq }
}

function policy() {
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
    settings: new FakeAttentionSettings(),
    ledger,
    transactions,
    bus,
    clock: new FakeClock(T0),
    ids: new SequenceIdGenerator(),
    hostEpoch: 'epoch-0111',
    sink: new RecordingLevel3Sink(),
    titles: (kind, name) => `${kind}:${name}`
  })
  const notified = (): string[] => bus.ofType('AttentionNotified').map((e) => e.payload.key)
  return { attention, ledger, notified }
}

describe('AttentionInputs.presenceChanged (16 §4.11)', () => {
  it('[INV-101] the on-screen set is the union of every attached ui client, and empty with no ui client attached', () => {
    const { attention, notified } = policy()
    const first = ask('ask-1', MINE)
    const second = ask('ask-2', OTHER_MINE)

    attention.presenceChanged('ui-1', report(1, [MINE]))
    attention.presenceChanged('ui-2', report(1, [OTHER_MINE])) // the last report names only OTHER_MINE
    attention.onFact(first, NAMES)
    attention.onFact(second, NAMES)
    expect(notified()).toStrictEqual([]) // both mines are on screen: the union of ui-1 and ui-2

    attention.presenceChanged('ui-1', 'detached')
    expect(notified()).toStrictEqual([first.key]) // MINE left the screen with ui-1

    attention.presenceChanged('ui-2', 'detached')
    expect(notified()).toStrictEqual([first.key, second.key]) // no ui client: nothing on screen
  })

  it('[S17.08] when the last ui connection closes a gated turn-finished fact becomes suppressed', () => {
    const { attention, ledger, notified } = policy()
    const turn: AttentionFact = {
      ...ask('turn-7', MINE),
      key: `${DWARF}:turn-finished:turn-7`,
      kind: 'turn-finished'
    }

    attention.presenceChanged('ui-1', report(1, [MINE]))
    attention.presenceChanged('ui-2', report(1, [MINE]))
    attention.onFact(turn, NAMES) // on screen: gated, no key claimed
    attention.presenceChanged('ui-1', 'detached') // ui-2 still shows the mine
    expect(ledger.writes).toStrictEqual([])

    attention.presenceChanged('ui-2', 'detached') // the last ui connection closes
    attention.presenceChanged('ui-3', report(1, [])) // a window re-attaches, nothing on screen

    expect(notified()).toStrictEqual([])
    expect(ledger.writes).toStrictEqual([
      { key: turn.key, dwarfId: DWARF, kind: 'turn-finished', suppressed: true }
    ])
  })
})
