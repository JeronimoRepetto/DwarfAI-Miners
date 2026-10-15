// L1 (17 §1.1): machine 7, message delivery (07 §7; ADR-022 items 1–3, 5), as a diagram-conformance
// walk — every listed transition is reached once with its guard, and a pair the machine does not
// list is refused — plus the NFR-TIM-05 rule that no time ever moves ✓ to ✓✓.
//
// TC-166-01 (every transition reached, an unlisted one refused).
import { describe, expect, it } from 'vitest'
import type { DwarfId, Instant, MessageId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import {
  advance,
  reconcileDelivery,
  startDelivery,
  type DeliveryFact,
  type DeliveryTransitionId
} from './delivery'
import type { Delivery, DeliveryFailure } from './messages'

const DWARF = '00000000-0000-7000-8000-0000000000d1' as DwarfId
const MESSAGE = '00000000-0000-7000-8000-0000000000a1' as MessageId
const T0 = 1_790_000_000_000 as Instant
const T1 = (T0 + 1_000) as Instant

function sending(overrides: Partial<Delivery> = {}): Delivery {
  return {
    messageId: MESSAGE,
    dwarfId: DWARF,
    kind: 'message',
    phase: 'sending',
    attempts: 1,
    phaseAt: T0,
    ...overrides
  }
}

function delivered(overrides: Partial<Delivery> = {}): Delivery {
  return sending({ phase: 'delivered', confidence: 'confirmed', ...overrides })
}

function failed(failure: DeliveryFailure, overrides: Partial<Delivery> = {}): Delivery {
  return sending({ phase: 'failed', failure, ...overrides })
}

/** The step `fact` takes from `from`, which must be a listed transition. */
function step(
  from: Delivery,
  fact: DeliveryFact
): { transition: DeliveryTransitionId; delivery: Delivery } {
  const result = advance(from, fact, T1)
  if (!result.ok) throw new Error(`refused ${fact.t} from ${from.phase}`)
  return { transition: result.transition, delivery: result.delivery }
}

describe('message delivery machine 7', () => {
  it('[TC-166-01, S7.01, US-MSG-001.AC01] a person message starts sending, attempt 1, before any hand-over', () => {
    expect(startDelivery({ messageId: MESSAGE, dwarfId: DWARF, kind: 'message', at: T0 })).toEqual({
      transition: 'S7.01',
      delivery: sending()
    })
  })

  it('[TC-166-01, S7.02] an accepted answers-record starts sending', () => {
    expect(
      startDelivery({ messageId: MESSAGE, dwarfId: DWARF, kind: 'answers-record', at: T0 })
    ).toEqual({ transition: 'S7.02', delivery: sending({ kind: 'answers-record' }) })
  })

  it('[TC-166-01, S7.03] a message queued behind a running turn stays sending, held until the turn ends', () => {
    expect(step(sending(), { t: 'held' })).toEqual({
      transition: 'S7.03',
      delivery: sending({ heldUntilTurnEnd: true })
    })
  })

  it('[TC-166-01, S7.04, US-MSG-001.AC03] a channel acceptance makes it delivered with its confidence, no longer held', () => {
    expect(
      step(sending({ heldUntilTurnEnd: true }), { t: 'accepted', confidence: 'unconfirmed' })
    ).toEqual({
      transition: 'S7.04',
      delivery: delivered({ confidence: 'unconfirmed', phaseAt: T1 })
    })
  })

  it('[TC-166-01, S7.05] correlated activity makes a delivered message reacted, keeping its confidence', () => {
    expect(step(delivered(), { t: 'activity-correlated', reactionEvidence: 'turn-id' })).toEqual({
      transition: 'S7.05',
      delivery: delivered({ phase: 'reacted', phaseAt: T1 })
    })
  })

  it('[TC-166-01, S7.06, FM-076] a channel error fails a message channel-error', () => {
    expect(step(sending(), { t: 'channel-error', reason: 'pipe closed' })).toEqual({
      transition: 'S7.06',
      delivery: failed({ kind: 'channel-error', reason: 'pipe closed' }, { phaseAt: T1 })
    })
  })

  it('[TC-166-01, S7.07, FM-078] a session that ended fails a sending message session-closed', () => {
    expect(step(sending(), { t: 'session-closed' })).toEqual({
      transition: 'S7.07',
      delivery: failed({ kind: 'session-closed' }, { phaseAt: T1 })
    })
  })

  it('[TC-166-01, S7.08] a refused answers-record fails refused with its reason', () => {
    const record = sending({ kind: 'answers-record' })
    expect(step(record, { t: 'refused', reason: 'channel-rejected' })).toEqual({
      transition: 'S7.08',
      delivery: failed(
        { kind: 'refused', reason: 'channel-rejected' },
        { kind: 'answers-record', phaseAt: T1 }
      )
    })
  })

  it('[TC-166-01, S7.09, BR-17] Retry of a channel-error or host-interrupted message sends it again, same id, attempts + 1', () => {
    for (const failure of [
      { kind: 'channel-error', reason: 'x' },
      { kind: 'host-interrupted' }
    ] satisfies DeliveryFailure[]) {
      expect(step(failed(failure), { t: 'retry', canReceiveMessages: true })).toEqual({
        transition: 'S7.09',
        delivery: sending({ attempts: 2, phaseAt: T1 })
      })
    }
  })

  it('[TC-166-01, S7.10] a re-answer on the reopened card sends the refused record again in place', () => {
    const refused = failed(
      { kind: 'refused', reason: 'invalid-answer' },
      { kind: 'answers-record' }
    )
    expect(step(refused, { t: 're-answer', askOpen: true })).toEqual({
      transition: 'S7.10',
      delivery: sending({ kind: 'answers-record', attempts: 2, phaseAt: T1 })
    })
  })

  it('[TC-166-01, S7.11] Copy leaves a failed message unchanged', () => {
    const row = failed({ kind: 'channel-error', reason: 'x' })
    expect(step(row, { t: 'copied' })).toEqual({ transition: 'S7.11', delivery: row })
  })

  it('[TC-166-01, S7.12, US-MSG-013.AC02] a failed message of a dwarf that can no longer receive keeps its failure', () => {
    const row = failed({ kind: 'host-interrupted' })
    expect(step(row, { t: 'cannot-receive' })).toEqual({ transition: 'S7.12', delivery: row })
  })

  it('[TC-166-01, S7.13, S7.14] the boot reconcile of a sending row with evidence makes it delivered', () => {
    expect(reconcileDelivery(sending(), { found: true, actedAfter: false }, T1)).toEqual({
      ok: true,
      transition: 'S7.14',
      delivery: delivered({ phaseAt: T1 })
    })
  })

  it('[TC-166-01, S7.13, S7.15] the boot reconcile with evidence that the dwarf acted after it makes it reacted', () => {
    expect(reconcileDelivery(sending(), { found: true, actedAfter: true }, T1)).toEqual({
      ok: true,
      transition: 'S7.15',
      delivery: delivered({ phase: 'reacted', phaseAt: T1 })
    })
  })

  it('[TC-166-01, S7.13, S7.16] the boot reconcile with no evidence fails it host-interrupted', () => {
    expect(reconcileDelivery(sending({ heldUntilTurnEnd: true }), { found: false }, T1)).toEqual({
      ok: true,
      transition: 'S7.16',
      delivery: failed({ kind: 'host-interrupted' }, { phaseAt: T1 })
    })
  })

  it('[TC-166-01, S7.17] a session, window or Host that closes later leaves delivered and reacted as they are', () => {
    for (const row of [delivered(), delivered({ phase: 'reacted' })]) {
      for (const what of ['session', 'window', 'host'] as const) {
        expect(step(row, { t: 'closed-later', what })).toEqual({
          transition: 'S7.17',
          delivery: row
        })
      }
    }
  })

  it('[TC-166-01, S7.18, US-RES-003.AC03] a detached UI leaves a sending message sending', () => {
    const row = sending({ heldUntilTurnEnd: true })
    expect(step(row, { t: 'ui-detached' })).toEqual({ transition: 'S7.18', delivery: row })
  })

  it('[TC-166-01, S7.19] Reset metrics keeps an in-flight delivery as it is', () => {
    const row = sending()
    expect(step(row, { t: 'metrics-reset' })).toEqual({ transition: 'S7.19', delivery: row })
  })

  it('[TC-166-01] a pair the machine does not list is refused and changes nothing', () => {
    const refusals: Array<[Delivery, DeliveryFact]> = [
      [sending(), { t: 'activity-correlated', reactionEvidence: 'turn-id' }],
      [delivered(), { t: 'activity-correlated', reactionEvidence: 'none' }],
      [delivered(), { t: 'channel-error', reason: 'x' }],
      [delivered(), { t: 'session-closed' }],
      [delivered(), { t: 'accepted', confidence: 'confirmed' }],
      [delivered({ phase: 'reacted' }), { t: 'activity-correlated', reactionEvidence: 'turn-id' }],
      [sending(), { t: 'refused', reason: 'ask-closed' }],
      [sending({ kind: 'answers-record' }), { t: 'channel-error', reason: 'x' }],
      [sending({ kind: 'answers-record' }), { t: 'session-closed' }],
      [failed({ kind: 'session-closed' }), { t: 'retry', canReceiveMessages: true }],
      [failed({ kind: 'channel-error', reason: 'x' }), { t: 'retry', canReceiveMessages: false }],
      [
        failed({ kind: 'refused', reason: 'ask-closed' }, { kind: 'answers-record' }),
        { t: 're-answer', askOpen: true }
      ],
      [
        failed({ kind: 'refused', reason: 'invalid-answer' }, { kind: 'answers-record' }),
        { t: 're-answer', askOpen: false }
      ],
      [sending(), { t: 'retry', canReceiveMessages: true }],
      [sending(), { t: 'copied' }],
      [sending(), { t: 'closed-later', what: 'window' }],
      [delivered(), { t: 'ui-detached' }],
      [delivered(), { t: 'held' }],
      [failed({ kind: 'channel-error', reason: 'x' }), { t: 'accepted', confidence: 'confirmed' }]
    ]
    for (const [from, fact] of refusals) {
      expect({ from: from.phase, fact, step: advance(from, fact, T1) }).toEqual({
        from: from.phase,
        fact,
        step: { ok: false, refused: 'not-in-machine-7' }
      })
    }
    expect(reconcileDelivery(delivered(), { found: false }, T1)).toEqual({
      ok: false,
      refused: 'not-in-machine-7'
    })
    // The refusals are the machine's, not a blanket one: the listed pair next to them is taken.
    expect(
      advance(delivered(), { t: 'activity-correlated', reactionEvidence: 'turn-id' }, T1)
    ).toMatchObject({
      ok: true
    })
  })

  it('[US-MSG-001.AC04, NFR-TIM-05, S7.05] delivered becomes reacted only on correlated activity, and never by time', () => {
    const clock = new FakeClock(T0)
    const uncorrelated: DeliveryFact[] = [
      { t: 'activity-correlated', reactionEvidence: 'none' },
      { t: 'closed-later', what: 'window' },
      { t: 'closed-later', what: 'session' }
    ]
    let row = delivered()
    for (let hour = 0; hour < 48; hour += 1) {
      clock.advance(3_600_000)
      for (const fact of uncorrelated) {
        const result = advance(row, fact, clock.now())
        if (result.ok) row = result.delivery
      }
      expect(row.phase).toBe('delivered')
    }
    const reacted = advance(
      row,
      { t: 'activity-correlated', reactionEvidence: 'transcript-match' },
      clock.now()
    )
    expect(reacted).toMatchObject({ ok: true, transition: 'S7.05', delivery: { phase: 'reacted' } })
  })

  it('[US-MSG-001.AC05, NFR-TIM-05] a delivered message stays delivered however long the FakeClock advances', () => {
    const clock = new FakeClock(T0)
    const row = delivered()
    for (const ms of [1, 30_000, 60_000, 3_600_000, 86_400_000 * 30]) {
      clock.advance(ms)
      // Time alone is no fact of machine 7: the only facts a delivered row accepts are listed ones.
      expect(advance(row, { t: 'ui-detached' }, clock.now())).toEqual({
        ok: false,
        refused: 'not-in-machine-7'
      })
      expect(row).toEqual(delivered())
    }
    // Only correlated activity moves it, at whatever instant it comes.
    expect(
      advance(row, { t: 'activity-correlated', reactionEvidence: 'turn-id' }, clock.now())
    ).toMatchObject({ ok: true, transition: 'S7.05', delivery: { phase: 'reacted' } })
  })
})
