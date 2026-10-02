// layer: L2
// L2 (17 §1.2): `onFactEnded` over FakeAttentionSettings, InMemoryAttentionLedger and a recording
// bus that refuses a publish inside a transaction (16 §2.3). Machine 17 (07 §17) S17.04, S17.05,
// S17.09; ADR-018 items 3–4; a Host restart is a new policy over a new ledger on the same rows.
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { DwarfId, MineId } from '../../../kernel/domain/values'
import type { TransactionRunner } from '../../../kernel/ports/transactionRunner'
import { carryOverKey } from '../domain/carryOver'
import type { AttentionFact, Level3Names, Presence } from '../domain/decideLevel3'
import type { AttentionEvent } from '../domain/events'
import { FakeAttentionSettings } from '../ports/fakes/FakeAttentionSettings'
import {
  InMemoryAttentionLedger,
  InMemoryAttentionRows
} from '../ports/fakes/InMemoryAttentionLedger'
import { AttentionPolicy } from './attentionPolicy'

const T0 = 1_790_000_000_000
const DWARF = 'dwarf-0001' as DwarfId
const OTHER = 'dwarf-0002' as DwarfId
const MINE = 'mine-0001' as MineId
const NAMES: Level3Names = { displayName: 'Gimli', mineName: 'Moria' }

function ask(askId: string, extra: Partial<AttentionFact> = {}): AttentionFact {
  return {
    key: `${DWARF}:question:${askId}`,
    kind: 'question',
    dwarfId: DWARF,
    mineId: MINE,
    at: T0,
    reannounce: true,
    ...extra
  }
}

function turn(dwarfId: DwarfId, turnKey: string): AttentionFact {
  return {
    key: `${dwarfId}:turn-finished:${turnKey}`,
    kind: 'turn-finished',
    dwarfId,
    mineId: MINE,
    at: T0,
    reannounce: true
  }
}

function report(seq: number, onScreen: readonly MineId[]): Presence {
  return { anyUiAttached: true, anyWindowVisible: true, onScreenMineIds: new Set(onScreen), seq }
}

/** One Host life over `rows`; a second call on the same rows is the next boot. */
function hostLife(rows = new InMemoryAttentionRows(), epoch = 'epoch-0110') {
  const ledger = new InMemoryAttentionLedger(rows, new FakeClock(T0))
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
    hostEpoch: epoch,
    titles: (kind, name) => `title(${kind}, ${name})`
  })
  const withdrawn = () =>
    bus.published.flatMap((e) => (e.type === 'AttentionWithdrawn' ? [e.payload.keys] : []))
  const notified = () =>
    bus.published.flatMap((e) => (e.type === 'AttentionNotified' ? [e.payload.key] : []))
  return { attention, rows, bus, withdrawn, notified }
}

describe('withdrawal (ADR-018 item 4)', () => {
  it('[US-SHELL-010.AC06, S17.05] answering an ask or ending its session withdraws its key and publishes AttentionWithdrawn once', () => {
    const { attention, rows, withdrawn, notified } = hostLife()
    const fact = ask('ask-1')
    attention.onFact(fact, NAMES)
    expect(notified()).toStrictEqual([fact.key])

    attention.onFactEnded(fact.key) // answered in the app
    attention.onFactEnded(fact.key) // then its session ended: the same fact, already withdrawn

    expect(withdrawn()).toStrictEqual([[fact.key]])
    expect(rows.withdrawnAt).toStrictEqual(new Map([[fact.key, T0]]))
  })

  it('[US-SHELL-010.AC06] a finished-turn key is withdrawn when the next turn starts or the dwarf departs', () => {
    const { attention, withdrawn } = hostLife()
    const first = turn(DWARF, 'turn-1')
    const second = turn(OTHER, 'turn-1')
    attention.presenceChanged('ui-1', report(1, []))
    attention.onFact(first, NAMES)
    attention.onFact(second, NAMES)

    attention.onFactEnded(first.key) // the routed next turn start of DWARF (later: ISSUE-120)
    attention.onFactEnded(second.key) // the routed departure of OTHER

    expect(withdrawn()).toStrictEqual([[first.key], [second.key]])
  })

  it('[ADR-018, FM-017] after a simulated Host restart a re-raised need is not announced and answering it withdraws both the new key and the pre-crash key', () => {
    const before = hostLife()
    const preCrash = ask('ask-before-crash')
    before.attention.onFact(preCrash, NAMES)
    expect(before.notified()).toStrictEqual([preCrash.key])
    // The Host stops with the ask open (FM-017); the recovery pass records the announced need
    // (ADR-015 item 5; later: ISSUE-173) and marks the re-raised ask `reannounce: false`.
    before.rows.announced.set(carryOverKey(DWARF, 'question'), preCrash.key)

    const after = hostLife(before.rows, 'epoch-0111')
    const reRaised = ask('ask-re-raised', { reannounce: false })
    after.attention.onFact(reRaised, NAMES)

    expect(after.notified()).toStrictEqual([])
    expect(after.rows.announced).toStrictEqual(new Map()) // consumed by this ask (S6.19)
    expect(after.rows.keys.get(reRaised.key)?.suppressed).toBe(true)

    after.attention.onFactEnded(reRaised.key)

    expect(after.withdrawn()).toStrictEqual([[reRaised.key, preCrash.key]])
    expect(after.notified()).toStrictEqual([])
  })

  it('[S6.19, INV-103] a carried-over need is consumed by the first ask of that dwarf and kind only, and the next one is announced', () => {
    const rows = new InMemoryAttentionRows()
    rows.announced.set(carryOverKey(DWARF, 'question'), `${DWARF}:question:ask-before-crash`)
    rows.announced.set(carryOverKey(DWARF, 'permission'), `${DWARF}:permission:ask-before-crash`)
    const { attention, notified } = hostLife(rows)
    const reRaised = ask('ask-re-raised')
    const next = ask('ask-new')

    attention.onFact(reRaised, NAMES)
    attention.onFact(next, NAMES)

    expect(notified()).toStrictEqual([next.key])
    expect(rows.announced).toStrictEqual(
      new Map([[carryOverKey(DWARF, 'permission'), `${DWARF}:permission:ask-before-crash`]])
    )
  })

  it('[S17.05, ADR-018] a fact that names the key it replaces withdraws both keys when it ends', () => {
    const before = hostLife()
    const preCrash = ask('ask-before-crash')
    before.attention.onFact(preCrash, NAMES)
    const after = hostLife(before.rows, 'epoch-0111')
    const reRaised = ask('ask-re-raised', { reannounce: false, replacesKey: preCrash.key })

    after.attention.onFact(reRaised, NAMES)
    after.attention.onFactEnded(reRaised.key)

    expect(after.withdrawn()).toStrictEqual([[reRaised.key, preCrash.key]])
  })

  it('[S17.04, S17.09] a gated or suppressed fact that ends is withdrawn with nothing shown', () => {
    const { attention, rows, withdrawn, notified } = hostLife()
    const suppressed = turn(DWARF, 'turn-1') // no ui attached: suppressed (S17.08)
    attention.onFact(suppressed, NAMES)
    attention.presenceChanged('ui-1', report(1, [MINE]))
    const gated = ask('ask-1') // its mine is on screen: gated (S17.01)
    attention.onFact(gated, NAMES)

    attention.onFactEnded(suppressed.key)
    attention.onFactEnded(gated.key)
    attention.presenceChanged('ui-1', report(2, [])) // the gate opens after the fact ended

    expect(notified()).toStrictEqual([])
    expect(withdrawn()).toStrictEqual([[suppressed.key], [gated.key]])
    expect(rows.withdrawnAt).toStrictEqual(new Map([[suppressed.key, T0]]))
    expect(rows.keys.has(gated.key)).toBe(false)
  })
})
