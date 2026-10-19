// layer: L2
// L2 (17 §1.2): the policy's side of the tray notifier connection (ISSUE-112) over
// FakeAttentionSettings, InMemoryAttentionLedger, RecordingLevel3Sink and a recording bus that
// refuses a publish inside a transaction (16 §2.3). 16 §4.11 rows `Level3Sink` and `clicked`;
// 14 §2.3 "Notifier scope" (a notification is state, sent again while its fact stands); ADR-018
// items 4–6; 07 S17.01, S17.06, S12.C03.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import type { AttentionFact, Level3Names } from '../domain/decideLevel3'
import type { AttentionEvent } from '../domain/events'
import { FakeAttentionSettings } from '../ports/fakes/FakeAttentionSettings'
import { InMemoryAttentionLedger } from '../ports/fakes/InMemoryAttentionLedger'
import { RecordingLevel3Sink } from '../ports/fakes/RecordingLevel3Sink'
import { AttentionPolicy } from './attentionPolicy'

const T0 = 1_790_000_000_000
const EPOCH = 'epoch-0112'
const DWARF = 'dwarf-0001' as DwarfId
const MINE = 'mine-0001' as MineId
const NAMES: Level3Names = { displayName: 'Gimli', mineName: 'Moria' }

function ask(askId: string): AttentionFact {
  return {
    key: `${DWARF}:question:${askId}`,
    kind: 'question',
    dwarfId: DWARF,
    mineId: MINE,
    at: T0,
    reannounce: true
  }
}

function policy(attached = true) {
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
  const sink = new RecordingLevel3Sink(attached)
  const inTransactionAtSink: boolean[] = []
  const notify = sink.notify.bind(sink)
  sink.notify = (n) => {
    inTransactionAtSink.push(open)
    return notify(n)
  }
  const attention = new AttentionPolicy({
    settings: new FakeAttentionSettings(),
    ledger,
    transactions,
    bus,
    sink,
    clock: new FakeClock(T0),
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH,
    titles: (kind, name) => `title(${kind}, ${name})`
  })
  return { attention, ledger, bus, sink, inTransactionAtSink }
}

describe('the Level3Sink side of the policy (16 §4.11, ADR-018 items 4–5)', () => {
  it('[ADR-018] an emitted notification is handed to the Level3Sink after its commit', () => {
    const { attention, sink, bus, inTransactionAtSink } = policy()

    attention.onFact(ask('ask-1'), NAMES)

    expect(sink.calls).toStrictEqual([
      {
        call: 'notify',
        outcome: 'delivered',
        notification: {
          key: ask('ask-1').key,
          kind: 'question',
          title: 'title(question, Gimli)',
          body: 'Moria',
          mineId: MINE,
          dwarfId: DWARF,
          sensitive: true
        }
      }
    ])
    expect(inTransactionAtSink).toStrictEqual([false])
    expect(bus.ofType('AttentionNotified')).toHaveLength(1)
  })

  it('[ADR-018] a withdrawal hands the withdrawn keys to the Level3Sink', () => {
    const { attention, sink } = policy()
    attention.onFact(ask('ask-1'), NAMES)

    attention.onFactEnded(ask('ask-1').key)
    attention.onFactEnded(ask('ask-1').key) // a fact that already ended withdraws nothing

    expect(sink.calls.slice(1)).toStrictEqual([{ call: 'withdraw', keys: [ask('ask-1').key] }])
  })

  it('[ADR-018, S17.01] a notification decided with no notifier attached is sent when a notifier attaches, unless its fact ended meanwhile', () => {
    const { attention, sink } = policy(false)
    attention.onFact(ask('ask-1'), NAMES)
    attention.onFact(ask('ask-2'), NAMES)
    expect(sink.calls.map((c) => c.call === 'notify' && c.outcome)).toStrictEqual([
      'no-ui',
      'no-ui'
    ])
    attention.onFactEnded(ask('ask-1').key)

    sink.attached = true
    attention.notifierAttached()

    expect(sink.notifiedKeys()).toStrictEqual([
      ask('ask-1').key,
      ask('ask-2').key,
      ask('ask-2').key
    ])
    expect(sink.calls.at(-1)).toMatchObject({ call: 'notify', outcome: 'delivered' })
  })

  it('[ADR-018] a notification is state: a notifier that attaches later receives every notification whose fact still stands', () => {
    const { attention, sink } = policy(true)
    attention.onFact(ask('ask-1'), NAMES)
    attention.onFact(ask('ask-2'), NAMES)
    attention.onFactEnded(ask('ask-2').key)

    attention.notifierAttached()

    expect(sink.notifiedKeys()).toStrictEqual([
      ask('ask-1').key,
      ask('ask-2').key,
      ask('ask-1').key
    ])
  })
})

describe('AttentionInputs.clicked (16 §4.11; ADR-018 item 6)', () => {
  it('[S17.06] a click only increments the diagnostics counter', () => {
    const { attention, sink, bus, ledger } = policy()
    attention.onFact(ask('ask-1'), NAMES)
    const before = { calls: sink.calls.length, events: bus.published.length }
    const writes = ledger.writes.length

    attention.clicked(ask('ask-1').key)
    attention.clicked('a-key-the-host-never-decided')

    expect(attention.clicks()).toBe(2)
    expect(sink.calls).toHaveLength(before.calls)
    expect(bus.published).toHaveLength(before.events)
    expect(ledger.writes).toHaveLength(writes)
  })
})
