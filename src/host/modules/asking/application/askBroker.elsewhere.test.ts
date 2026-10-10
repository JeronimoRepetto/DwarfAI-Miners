// layer: L2
// L2 (17 §1.2): an ask resolved outside the app, or cancelled or withdrawn, closes with no notice
// (ADR-010 items 6, 10; 16 §4.7 row `resolveExternally`; 07 S6.11, S6.13, S6.16, S1.13–S1.15;
// 08 §2.7 `AskClosed`; 13 FM-139; 15 §6 C-12, C-13), over the in-memory doubles of answerHarness.ts.
//
// The broker is channel-neutral: every channel's trusted resolution signal reaches it as
// `resolveExternally(dwarfId, providerRequestId, by)`. The only notice the close produces is
// `AskClosed` (the card disappears, the dwarf leaves `asking`); no toast, no refusal mark, no record.
// The resolution held while an answer is in flight (S6.21) is askBroker.refused.test.ts's.
//
// TC-136-01: a trusted resolution closes the ask `answered-elsewhere` or `cancelled` and publishes
// `AskClosed` once. TC-136-02: a submit of the closed card is `not-open` and writes nothing.
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import { ANSWER_DWARF, answerHarness, OTHER_DWARF } from '../testing/answerHarness'
import type { AskingEvent } from '../domain/events'

const R1 = '01890a5d-ac96-774b-bcce-000000001361'
const R2 = '01890a5d-ac96-774b-bcce-000000001362'

/**
 * A fake crew status consumer (07 machine 1, the asking rows only): it follows `AskOpened` and
 * `AskClosed` as crew's status facts do (S1.10, S1.13–S1.15), reading the dwarf's next open ask
 * from the broker's rows when its front ask closes. The real route is ISSUE-140's.
 */
function crewStatus(
  h: ReturnType<typeof answerHarness>,
  turnActive: (dwarfId: DwarfId) => boolean
) {
  const status = new Map<DwarfId, 'working' | 'asking' | 'idle'>()
  const changes: { dwarfId: DwarfId; to: string }[] = []
  const set = (dwarfId: DwarfId, to: 'working' | 'asking' | 'idle') => {
    if (status.get(dwarfId) === to) return
    status.set(dwarfId, to)
    changes.push({ dwarfId, to })
  }
  h.bus.subscribe('AskOpened', (event) => set(event.payload.ask.dwarfId as DwarfId, 'asking'))
  h.bus.subscribe('AskClosed', (event) => {
    const { dwarfId } = event.payload
    // S1.15: another open ask of the dwarf becomes the front one; the status stays `asking`.
    if (h.asks.openFor(dwarfId) !== null) return
    set(dwarfId, turnActive(dwarfId) ? 'working' : 'idle')
  })
  return { of: (dwarfId: DwarfId) => status.get(dwarfId), changes, set }
}

describe('AskBroker resolveExternally (16 §4.7)', () => {
  it('[US-OBS-004.AC09, S6.11] an ask resolved outside the app closes answered-elsewhere and publishes AskClosed with no toast', () => {
    for (const make of ['permission', 'question'] as const) {
      const h = answerHarness()
      const ask = h[make](1)

      h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, 'elsewhere')

      expect(h.asks.byId(ask.id as never)?.state).toBe('answered-elsewhere')
      // The close is the only event: no toast, no refusal mark (`AskReopened`), no delivery failure.
      expect(h.bus.published).toEqual([
        expect.objectContaining({
          type: 'AskClosed',
          payload: { askId: ask.id, dwarfId: ANSWER_DWARF, reason: 'answered-elsewhere' }
        })
      ])
      // Nothing was answered and nothing written: no channel call, no "Answers:" record.
      expect(h.channel.calls).toEqual([])
      expect(h.records()).toEqual([])
    }
  })

  it('[US-ASK-006.AC06, S6.13] an ask cancelled or withdrawn closes cancelled with no notice', () => {
    const h = answerHarness()
    const ask = h.question(1, { currentStep: 1 })

    h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, 'cancelled')

    expect(h.asks.byId(ask.id as never)?.state).toBe('cancelled')
    expect(h.eventTypes()).toEqual(['AskClosed'])
    expect(h.bus.ofType('AskClosed')[0]?.payload).toEqual({
      askId: ask.id,
      dwarfId: ANSWER_DWARF,
      reason: 'cancelled'
    })
    expect(h.channel.calls).toEqual([])
    expect(h.records()).toEqual([])
  })

  it('[S1.13, S1.14] after the close the dwarf leaves asking (working if its turn is active, else idle)', () => {
    const h = answerHarness()
    const active = new Set<DwarfId>([ANSWER_DWARF])
    const crew = crewStatus(h, (dwarfId) => active.has(dwarfId))
    const working = h.permission(1)
    const resting = h.permission(2, { dwarfId: OTHER_DWARF })
    crew.set(ANSWER_DWARF, 'asking')
    crew.set(OTHER_DWARF, 'asking')

    h.paths.resolveExternally(ANSWER_DWARF, working.providerRequestId, 'elsewhere')
    h.paths.resolveExternally(OTHER_DWARF, resting.providerRequestId, 'cancelled')

    // The close is committed before `AskClosed` is published: the consumer reads no open ask.
    expect(crew.of(ANSWER_DWARF)).toBe('working')
    expect(crew.of(OTHER_DWARF)).toBe('idle')
    expect(h.bus.ofType('AskClosed').map((event) => event.payload.dwarfId)).toEqual([
      ANSWER_DWARF,
      OTHER_DWARF
    ])
  })

  it('[C-12, C-13, FM-139] a submit of that card afterwards returns not-open and writes nothing', async () => {
    const h = answerHarness()
    const permission = h.permission(1)
    const question = h.question(2, { dwarfId: OTHER_DWARF })
    h.paths.resolveExternally(ANSWER_DWARF, permission.providerRequestId, 'elsewhere')
    h.paths.resolveExternally(OTHER_DWARF, question.providerRequestId, 'cancelled')
    const before = h.bus.published.length
    const transactions = h.transactions()

    await expect(h.paths.answerPermission(permission.id, 'allow', R1)).resolves.toEqual({
      kind: 'not-open'
    })
    await expect(
      h.paths.answerQuestion(question.id, [{ step: 0, option: 'All' }], R2)
    ).resolves.toEqual({ kind: 'not-open' })

    // Renders nothing: no record, no channel call, no event, no `ask_answers` row.
    expect(h.records()).toEqual([])
    expect(h.records(OTHER_DWARF)).toEqual([])
    expect(h.channel.calls).toEqual([])
    expect(h.bus.published.length).toBe(before)
    expect(h.rows.settlements).toEqual([])
    expect(h.transactions()).toBe(transactions + 2)
    expect(h.asks.byId(permission.id as never)?.state).toBe('answered-elsewhere')
    expect(h.asks.byId(question.id as never)?.state).toBe('cancelled')
  })

  it("[S6.16] the dwarf's next queued ask becomes the front with no second attention fact", () => {
    const h = answerHarness()
    const crew = crewStatus(h, () => true)
    const front = h.permission(1)
    const queued = h.question(2)
    crew.set(ANSWER_DWARF, 'asking')
    expect(h.asks.openFor(ANSWER_DWARF)?.id).toBe(front.id)

    h.paths.resolveExternally(ANSWER_DWARF, front.providerRequestId, 'elsewhere')

    expect(h.asks.openFor(ANSWER_DWARF)?.id).toBe(queued.id)
    expect(h.asks.byId(queued.id as never)?.state).toBe('open')
    // Only the close: the queued ask is not opened again, so no second attention fact (S17.01).
    expect(h.eventTypes()).toEqual(['AskClosed'])
    // S1.15: the dwarf stays `asking`, with no status change.
    expect(crew.of(ANSWER_DWARF)).toBe('asking')
    expect(crew.changes).toEqual([{ dwarfId: ANSWER_DWARF, to: 'asking' }])
  })

  it('[ADR-010] a second resolution of the same ask changes nothing', () => {
    for (const [first, second] of [
      ['elsewhere', 'cancelled'],
      ['cancelled', 'elsewhere'],
      ['elsewhere', 'elsewhere']
    ] as const) {
      const h = answerHarness()
      const ask = h.permission(1)
      h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, first)
      const state = h.asks.byId(ask.id as never)?.state

      h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, second)

      expect(h.asks.byId(ask.id as never)?.state).toBe(state)
      expect(h.bus.ofType('AskClosed')).toHaveLength(1)
      expect(h.eventTypes()).toEqual(['AskClosed'])
    }

    // An unknown request, or another dwarf's request id, changes nothing either.
    const h = answerHarness()
    const ask = h.permission(1)
    h.paths.resolveExternally(ANSWER_DWARF, 'request-unknown', 'elsewhere')
    h.paths.resolveExternally(OTHER_DWARF, ask.providerRequestId, 'elsewhere')
    expect(h.asks.byId(ask.id as never)?.state).toBe('open')
    expect(h.bus.published as AskingEvent[]).toEqual([])
  })
})
