// layer: L2
// L2 (17 §1.2): the Host boot settlement of the asks a stopped Host left live (07 S6.11, S6.17, S6.18, S6.20;
// ADR-010 item 11; ADR-015 item 4; #1293), over the in-memory doubles of answerHarness.ts. Each `open` or `answering`
// ask moves along machine 6's boot rows by the facts the caller knows of its session and request; every ask that
// closes publishes `AskClosed` after the one transaction, and a closed ask is never touched.
import { describe, expect, it } from 'vitest'
import type { RestartFacts } from '../domain/askMachine'
import { ANSWER_DWARF, answerHarness, OTHER_DWARF } from '../testing/answerHarness'

const GONE: RestartFacts = { sessionSurvived: true, stillPending: false, deliveryEvidence: false }
const PENDING: RestartFacts = { sessionSurvived: true, stillPending: true, deliveryEvidence: false }
const LOST: RestartFacts = { sessionSurvived: false, stillPending: false, deliveryEvidence: false }

describe('the boot settlement of the asks a stopped Host left (#1293)', () => {
  it('[S6.11, S6.20, ADR-010] a request no longer pending closes each live ask answered elsewhere, with AskClosed only', () => {
    const h = answerHarness()
    const front = h.permission(1)
    const answering = h.question(2, { dwarfId: OTHER_DWARF, state: 'answering' })
    const closed = h.permission(3, { state: 'cancelled', closedAt: 1 })

    h.restarts.settleAfterRestart(() => GONE)

    expect(h.asks.byId(front.id as never)).toMatchObject({
      state: 'answered-elsewhere',
      closedAt: expect.any(Number)
    })
    expect(h.asks.byId(answering.id as never)?.state).toBe('answered-elsewhere')
    expect(h.asks.byId(closed.id as never)?.state).toBe('cancelled')
    expect(h.eventTypes()).toEqual(['AskClosed', 'AskClosed'])
    expect(h.bus.ofType('AskClosed').map((event) => event.payload)).toEqual([
      { askId: front.id, dwarfId: ANSWER_DWARF, reason: 'answered-elsewhere' },
      { askId: answering.id, dwarfId: OTHER_DWARF, reason: 'answered-elsewhere' }
    ])
    expect(h.channel.calls).toEqual([])
  })

  it('[S6.17, ADR-010] a request still pending on a re-adopted session keeps the open ask, and publishes nothing', () => {
    const h = answerHarness()
    const ask = h.permission(1)

    h.restarts.settleAfterRestart(() => PENDING)

    expect(h.asks.byId(ask.id as never)?.state).toBe('open')
    expect(h.bus.published).toEqual([])
  })

  it('[S6.18, ADR-015] a session that did not survive closes its asks closed-by-death', () => {
    const h = answerHarness()
    const ask = h.permission(1)

    h.restarts.settleAfterRestart(() => LOST)

    expect(h.asks.byId(ask.id as never)?.state).toBe('closed-by-death')
    expect(h.bus.ofType('AskClosed').map((event) => event.payload.reason)).toEqual([
      'closed-by-death'
    ])
  })
})
