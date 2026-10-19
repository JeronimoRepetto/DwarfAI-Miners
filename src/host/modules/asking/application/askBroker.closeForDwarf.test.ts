// layer: L2
// L2 (17 §1.2): closing by death (ADR-010 items 5, 11; 16 §4.7 row `closeForDwarf`; 07 S6.14,
// S6.15; INV-77; 08 §2.7 `AskClosed`), over the in-memory doubles of answerHarness.ts. The dwarf's
// session ended: each of its `open` or `answering` asks closes `closed-by-death`, its card
// disappears with no notice (`AskClosed` only), and an answer in flight then settles `ask-closed`
// with no card back. Another dwarf's asks and an ask already closed are untouched.
import { describe, expect, it } from 'vitest'
import type { AnswerOutcome } from '../../../kernel/domain/sharedContracts'
import { ANSWER_DWARF, answerHarness, OTHER_DWARF } from '../testing/answerHarness'

const R1 = '01890a5d-ac96-774b-bcce-000000001401'

/** Lets every settled promise run its continuations. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('AskBroker closeForDwarf (16 §4.7)', () => {
  it('[S6.14, INV-77] the dwarf departing closes every open ask of it closed-by-death, front first, with AskClosed only', () => {
    const h = answerHarness()
    const front = h.permission(1)
    const queued = h.question(2)
    const others = h.permission(3, { dwarfId: OTHER_DWARF })

    h.paths.closeForDwarf(ANSWER_DWARF)

    expect(h.asks.byId(front.id as never)).toMatchObject({
      state: 'closed-by-death',
      closedAt: expect.any(Number)
    })
    expect(h.asks.byId(queued.id as never)?.state).toBe('closed-by-death')
    expect(h.asks.openFor(ANSWER_DWARF)).toBeNull()
    expect(h.eventTypes()).toEqual(['AskClosed', 'AskClosed'])
    expect(h.bus.ofType('AskClosed').map((event) => event.payload)).toEqual([
      { askId: front.id, dwarfId: ANSWER_DWARF, reason: 'closed-by-death' },
      { askId: queued.id, dwarfId: ANSWER_DWARF, reason: 'closed-by-death' }
    ])
    // Another dwarf's ask stays open; nothing was answered or written.
    expect(h.asks.byId(others.id as never)?.state).toBe('open')
    expect(h.channel.calls).toEqual([])
    expect(h.records()).toEqual([])
  })

  it('[S6.15, INV-77] an ask whose answer is in flight closes closed-by-death, and the answer settles ask-closed with no card back', async () => {
    const h = answerHarness()
    const ask = h.permission(1)
    h.channel.hold = true

    const answered: Promise<AnswerOutcome> = h.paths.answerPermission(ask.id, 'allow', R1)
    await flush()
    h.paths.closeForDwarf(ANSWER_DWARF)

    expect(h.asks.byId(ask.id as never)?.state).toBe('closed-by-death')
    expect(h.bus.ofType('AskClosed').map((event) => event.payload.reason)).toEqual([
      'closed-by-death'
    ])
    h.channel.release()
    expect(await answered).toEqual({ kind: 'refused', reason: 'ask-closed' })
    expect(h.asks.byId(ask.id as never)?.state).toBe('closed-by-death')
    expect(h.bus.ofType('AskReopened')).toEqual([])
    expect(h.bus.ofType('AskClosed')).toHaveLength(1)
  })

  it('[ADR-010, S6.14] a second departure, or a dwarf with no live ask, changes nothing and publishes nothing', () => {
    const h = answerHarness()
    h.permission(1)
    h.paths.closeForDwarf(ANSWER_DWARF)
    const published = h.bus.published.length

    h.paths.closeForDwarf(ANSWER_DWARF)
    h.paths.closeForDwarf(OTHER_DWARF)

    expect(h.bus.published).toHaveLength(published)
  })
})
