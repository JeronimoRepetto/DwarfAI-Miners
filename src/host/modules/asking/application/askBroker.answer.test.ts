// layer: L2
// L2 (17 §1.2): the ask broker's two answer paths (ADR-010 items 2, 4, 5, 8, 13; 16 §4.7 rows
// `answerPermission` / `answerQuestion`; 09 §8.2) over in-memory doubles (answerHarness.ts):
// transaction 1 — `answering`, the pending `ask_answers` row and the "Answers:" record with its
// delivery `sending` — commits before the channel is called outside any transaction, bounded at
// 30 s; transaction 2 records the result; events follow each commit.
//
// TC-128-01 (record before acting, closed answered-in-app with the record delivered), TC-128-02
// (a repeated requestId returns the first result; a stale submit writes nothing).
import { describe, expect, it } from 'vitest'
import type { AnswerOutcome } from '../../../kernel/domain/sharedContracts'
import { ANSWER_DWARF, OTHER_DWARF, answerHarness } from '../testing/answerHarness'

const R1 = '01890a5d-ac96-774b-bcce-000000000001'
const R2 = '01890a5d-ac96-774b-bcce-000000000002'

/** Lets every settled promise run its continuations. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

describe('AskBroker answer paths', () => {
  it('[US-ASK-001.AC10, INV-72, S6.06] submitting every answered step writes one Answers: record with delivery sending before the channel is called, then closes the ask', async () => {
    const h = answerHarness()
    const ask = h.question(1)
    h.channel.hold = true

    const answered = h.paths.answerQuestion(
      ask.id,
      [
        { step: 0, option: 'All' },
        { step: 1, option: 'Yes' },
        { step: 2, option: 'No' }
      ],
      R1
    )
    await flush()

    // At the channel call: committed, outside any transaction, the record already `sending`.
    expect(h.channel.calls).toHaveLength(1)
    expect(h.callsInTransaction).toEqual([false])
    expect(h.asks.byId(ask.id as never)?.state).toBe('answering')
    const [record] = h.records()
    expect(record).toMatchObject({
      text: 'Answers:\n\n- Which files: **All**\n- Run the tests: **Yes**\n- Commit now: **No**',
      askId: ask.id,
      delivery: { phase: 'sending', attempts: 1 }
    })
    expect(h.asks.answerOf(R1)).toEqual({ askId: ask.id, outcome: null, messageId: record?.id })
    expect(h.eventTypes()).toEqual(['MessageSent'])

    h.channel.release()
    expect(await answered).toEqual({ kind: 'accepted' })
    expect(h.asks.byId(ask.id as never)).toMatchObject({ state: 'answered-in-app' })
    expect(h.records()).toHaveLength(1)
    expect(h.records()[0]?.delivery?.phase).toBe('delivered')
    expect(h.asks.answerOf(R1)?.outcome).toEqual({ kind: 'accepted' })
  })

  it("[US-ASK-002.AC04] a free-text answer is accepted as the step's answer like a listed option", async () => {
    const h = answerHarness()
    const ask = h.question(2)
    const answers = [
      { step: 0, freeText: 'Only the cache' },
      { step: 1, option: 'Yes' },
      { step: 2, option: 'Yes' }
    ]

    expect(await h.paths.answerQuestion(ask.id, answers, R1)).toEqual({ kind: 'accepted' })

    expect(h.channel.calls).toEqual([
      {
        method: 'answerQuestion',
        ref: { dwarfId: ANSWER_DWARF },
        providerRequestId: ask.providerRequestId,
        answers
      }
    ])
    expect(h.records()[0]?.text).toContain('- Which files: **Only the cache**')
    expect(h.asks.byId(ask.id as never)?.state).toBe('answered-in-app')
  })

  it('[US-ASK-003.AC07, S6.08] an accepted Allow or Deny closes the ask answered-in-app and the record shows delivered', async () => {
    for (const decision of ['allow', 'deny'] as const) {
      const h = answerHarness()
      const ask = h.permission(3)

      expect(await h.paths.answerPermission(ask.id, decision, R1)).toEqual({ kind: 'accepted' })

      expect(h.channel.calls).toEqual([
        {
          method: 'answerPermission',
          ref: { dwarfId: ANSWER_DWARF },
          providerRequestId: ask.providerRequestId,
          decision
        }
      ])
      expect(h.asks.byId(ask.id as never)).toMatchObject({
        state: 'answered-in-app',
        closedAt: expect.any(Number)
      })
      expect(h.records()).toEqual([
        expect.objectContaining({
          text: `Answers:\n\n- Bash · Run pnpm test: **${decision === 'allow' ? 'Allow' : 'Deny'}**`,
          delivery: expect.objectContaining({ phase: 'delivered' })
        })
      ])
    }
  })

  it("[US-ASK-001.AC12] the record's hand-over is published as MessageHandedOver after the accepted result", async () => {
    const h = answerHarness()
    const ask = h.permission(4)
    h.channel.hold = true

    const answered = h.paths.answerPermission(ask.id, 'allow', R1)
    await flush()
    expect(h.eventTypes()).toEqual(['MessageSent'])

    h.channel.release()
    await answered
    expect(h.eventTypes()).toEqual(['MessageSent', 'AskClosed', 'MessageHandedOver'])
    const messageId = h.records()[0]?.id
    expect(h.bus.ofType('MessageSent')[0]?.payload).toEqual({
      messageId,
      dwarfId: ANSWER_DWARF,
      kind: 'answers-record'
    })
    expect(h.bus.ofType('AskClosed')[0]?.payload).toEqual({
      askId: ask.id,
      dwarfId: ANSWER_DWARF,
      reason: 'answered-in-app'
    })
    expect(h.bus.ofType('MessageHandedOver')[0]?.payload).toEqual({
      messageId,
      dwarfId: ANSWER_DWARF,
      confidence: 'confirmed'
    })
  })

  it('[US-ASK-005.AC04, US-ASK-005.AC05, INV-69] a message sent through Other thing is not an answer: the broker is not called and no Answers: record is written', () => {
    const h = answerHarness()
    const ask = h.permission(5)

    h.sendOtherThing('Use the staging database instead')

    expect(h.channel.calls).toEqual([])
    expect(h.records()).toEqual([])
    expect(h.rows.settlements).toEqual([])
    expect(h.bus.published).toEqual([])
    // The message went out on the send path as an ordinary message.
    expect(h.otherThings).toEqual([
      { dwarfId: ANSWER_DWARF, text: 'Use the staging database instead' }
    ])
    expect(h.asks.byId(ask.id as never)?.state).toBe('open')
  })

  it('[US-ASK-005.AC06, US-ASK-005.AC07] after any number of such messages the permission is still open and waiting on a decision', () => {
    const h = answerHarness()
    const ask = h.permission(6)

    for (let n = 0; n < 4; n += 1) h.sendOtherThing(`note ${n}`)

    expect(h.asks.openFor(ANSWER_DWARF)).toEqual(ask)
    expect(h.records()).toEqual([])
    expect(h.channel.calls).toEqual([])
  })

  it('[US-ASK-005.AC08] a later Allow or Deny decides the permission exactly as without the earlier messages', async () => {
    const decide = async (messages: number) => {
      const h = answerHarness()
      const ask = h.permission(7)
      for (let n = 0; n < messages; n += 1) h.sendOtherThing(`note ${n}`)
      const outcome = await h.paths.answerPermission(ask.id, 'deny', R1)
      return {
        outcome,
        ask: h.asks.byId(ask.id as never),
        calls: h.channel.calls,
        records: h.records().map((r) => ({ text: r.text, phase: r.delivery?.phase })),
        events: h.eventTypes()
      }
    }

    const without = await decide(0)
    const withMessages = await decide(3)

    expect(withMessages).toEqual(without)
    expect(without.outcome).toEqual({ kind: 'accepted' })
    expect(without.ask?.state).toBe('answered-in-app')
  })

  it('[INV-79] the same requestId twice returns the first result and calls the channel once', async () => {
    const h = answerHarness()
    const ask = h.permission(8)
    h.channel.hold = true

    // While the first is in flight, the repeat gets the same answer.
    const first = h.paths.answerPermission(ask.id, 'allow', R1)
    const repeatInFlight = h.paths.answerPermission(ask.id, 'allow', R1)
    await flush()
    h.channel.release()
    const results = await Promise.all([first, repeatInFlight])
    // After it settled, and after a Host restart (the ask_answers PK is durable, 14 §1.6).
    const repeatAfter = await h.paths.answerPermission(ask.id, 'allow', R1)
    const repeatAfterRestart = await h.reboot().answerPermission(ask.id, 'deny', R1)

    expect(results).toEqual([{ kind: 'accepted' }, { kind: 'accepted' }])
    expect(repeatAfter).toEqual({ kind: 'accepted' })
    expect(repeatAfterRestart).toEqual({ kind: 'accepted' })
    expect(h.channel.calls).toHaveLength(1)
    expect(h.records()).toHaveLength(1)
    expect(h.rows.settlements).toHaveLength(1)
    expect(h.eventTypes()).toEqual(['MessageSent', 'AskClosed', 'MessageHandedOver'])
  })

  it('[ADR-010] a stale submit writes no row and no delivery', async () => {
    const h = answerHarness()
    const closed = h.permission(9, { state: 'answered-elsewhere', closedAt: 1 })
    const front = h.permission(10)
    const queued = h.question(11)
    const noChannel = h.seed({ ...h.permission(12), dwarfId: 'dwarf-observed', channel: 'none' })

    const outcomes: AnswerOutcome[] = [
      await h.paths.answerPermission(closed.id, 'allow', R1),
      // Only the dwarf's front ask shows a card (INV-70): the queued one is not open to answers.
      await h.paths.answerQuestion(queued.id, [{ step: 0, option: 'All' }], R2),
      await h.paths.answerPermission(noChannel.id, 'allow', '01890a5d-ac96-774b-bcce-000000000003'),
      await h.paths.answerPermission(h.askId(404), 'allow', '01890a5d-ac96-774b-bcce-000000000004')
    ]

    expect(outcomes).toEqual(Array(4).fill({ kind: 'not-open' }))
    expect(h.rows.settlements).toEqual([])
    expect(h.records()).toEqual([])
    expect(h.channel.calls).toEqual([])
    expect(h.bus.published).toEqual([])
    expect(h.asks.byId(front.id as never)?.state).toBe('open')
    expect(h.asks.byId(closed.id as never)?.state).toBe('answered-elsewhere')
  })

  it('[ADR-010] the answers record and its ask_answers row roll back together when the first transaction fails', async () => {
    const h = answerHarness()
    const ask = h.permission(13)
    h.faults.link = true

    await expect(h.paths.answerPermission(ask.id, 'allow', R1)).rejects.toThrow('linkRecord failed')

    expect(h.asks.byId(ask.id as never)?.state).toBe('open')
    expect(h.rows.settlements).toEqual([])
    expect(h.records()).toEqual([])
    expect(h.channel.calls).toEqual([])
    expect(h.bus.published).toEqual([])
    // Nothing is left half-written: the next submit wins the ask as the first one would have.
    expect(await h.paths.answerPermission(ask.id, 'allow', R2)).toEqual({ kind: 'accepted' })
  })

  it('[ADR-010, INV-72] a second answer while the first is in flight finds the ask not open, and the first answer wins', async () => {
    const h = answerHarness()
    const ask = h.permission(14)
    h.channel.hold = true

    const first = h.paths.answerPermission(ask.id, 'allow', R1)
    const second = await h.paths.answerPermission(ask.id, 'deny', R2)
    h.channel.release()

    expect(second).toEqual({ kind: 'not-open' })
    expect(await first).toEqual({ kind: 'accepted' })
    expect(h.channel.calls).toEqual([expect.objectContaining({ decision: 'allow' })])
    expect(h.rows.settlements.map((row) => row.requestId)).toEqual([R1])
    expect(h.records()).toHaveLength(1)
  })

  it('[INV-74] a channel that does not answer within 30 s refuses with channel-unavailable, the ask opens again and its record shows the refusal', async () => {
    const h = answerHarness()
    const ask = h.permission(15)
    h.channel.hold = true
    let settled: AnswerOutcome | null = null

    void h.paths.answerPermission(ask.id, 'allow', R1).then((outcome) => {
      settled = outcome
    })
    await flush()
    h.clock.advance(29_999)
    await flush()
    expect(settled).toBeNull()

    h.clock.advance(1)
    await flush()
    expect(settled).toEqual({ kind: 'refused', reason: 'channel-unavailable' })
    expect(h.asks.byId(ask.id as never)?.state).toBe('open')
    expect(h.records()[0]?.delivery).toMatchObject({
      phase: 'failed',
      failure: { kind: 'refused', reason: 'channel-unavailable' }
    })
    expect(h.eventTypes()).toEqual(['MessageSent', 'AskReopened', 'MessageDeliveryFailed'])

    // A late answer from the channel changes nothing.
    h.channel.release()
    await flush()
    expect(h.asks.byId(ask.id as never)?.state).toBe('open')
    expect(h.eventTypes()).toHaveLength(3)
  })

  it('[ADR-010] a re-answer after a refusal updates the same Answers: record in place', async () => {
    const h = answerHarness()
    const ask = h.permission(16)
    h.channel.script({ kind: 'refused', reason: 'channel-rejected' })

    expect(await h.paths.answerPermission(ask.id, 'allow', R1)).toEqual({
      kind: 'refused',
      reason: 'channel-rejected'
    })
    const [refused] = h.records()
    expect(await h.paths.answerPermission(ask.id, 'deny', R2)).toEqual({ kind: 'accepted' })

    expect(h.records()).toEqual([
      expect.objectContaining({
        id: refused?.id,
        text: 'Answers:\n\n- Bash · Run pnpm test: **Deny**',
        delivery: expect.objectContaining({ phase: 'delivered', attempts: 2 })
      })
    ])
    expect(h.asks.answerOf(R2)).toEqual({
      askId: ask.id,
      outcome: { kind: 'accepted' },
      messageId: refused?.id
    })
  })

  it('[ADR-010] an ask that closed while its answer was in flight stays closed and the record shows ask-closed', async () => {
    const h = answerHarness()
    const ask = h.permission(17)
    h.channel.hold = true

    const answered = h.paths.answerPermission(ask.id, 'allow', R1)
    await flush()
    // The session ended meanwhile (S6.15): the ask closed by death while answering.
    h.seed({ ...ask, state: 'closed-by-death', closedAt: 99 })
    h.channel.release()

    expect(await answered).toEqual({ kind: 'refused', reason: 'ask-closed' })
    expect(h.asks.byId(ask.id as never)?.state).toBe('closed-by-death')
    expect(h.records()[0]?.delivery).toMatchObject({
      phase: 'failed',
      failure: { kind: 'refused', reason: 'ask-closed' }
    })
    expect(h.eventTypes()).toEqual(['MessageSent', 'MessageDeliveryFailed'])
  })
  it('[ADR-010] an answer of the other kind returns not-open and writes nothing', async () => {
    const h = answerHarness()
    const question = h.question(18)
    const permission = h.permission(19, { dwarfId: OTHER_DWARF })

    const outcomes = [
      await h.paths.answerPermission(question.id, 'allow', R1),
      await h.paths.answerQuestion(permission.id, [{ step: 0, option: 'Yes' }], R2)
    ]

    expect(outcomes).toEqual([{ kind: 'not-open' }, { kind: 'not-open' }])
    expect(h.rows.settlements).toEqual([])
    expect(h.records()).toEqual([])
    expect(h.records(OTHER_DWARF)).toEqual([])
    expect(h.channel.calls).toEqual([])
    expect(h.bus.published).toEqual([])
    expect(h.asks.byId(question.id as never)?.state).toBe('open')
    expect(h.asks.byId(permission.id as never)?.state).toBe('open')
  })

  it('[S6.10] a channel that answers ask-closed while the ask is still answering closes it answered-elsewhere', async () => {
    const h = answerHarness()
    const ask = h.permission(20)
    h.channel.script({ kind: 'refused', reason: 'ask-closed' })

    expect(await h.paths.answerPermission(ask.id, 'allow', R1)).toEqual({
      kind: 'refused',
      reason: 'ask-closed'
    })

    expect(h.asks.byId(ask.id as never)).toMatchObject({
      state: 'answered-elsewhere',
      closedAt: expect.any(Number)
    })
    expect(h.records()[0]?.delivery).toMatchObject({
      phase: 'failed',
      failure: { kind: 'refused', reason: 'ask-closed' }
    })
    expect(h.eventTypes()).toEqual(['MessageSent', 'AskClosed', 'MessageDeliveryFailed'])
    expect(h.bus.ofType('AskClosed')[0]?.payload).toEqual({
      askId: ask.id,
      dwarfId: ANSWER_DWARF,
      reason: 'answered-elsewhere'
    })
  })

  it('[INV-79] a requestId already used for another ask returns not-open and writes nothing', async () => {
    const h = answerHarness()
    const first = h.permission(21)
    expect(await h.paths.answerPermission(first.id, 'allow', R1)).toEqual({ kind: 'accepted' })
    const second = h.permission(22)
    const published = h.bus.published.length

    expect(await h.paths.answerPermission(second.id, 'allow', R1)).toEqual({ kind: 'not-open' })

    expect(h.asks.byId(second.id as never)?.state).toBe('open')
    expect(h.rows.settlements.map((row) => row.askId)).toEqual([first.id])
    expect(h.records()).toHaveLength(1)
    expect(h.channel.calls).toHaveLength(1)
    expect(h.bus.published).toHaveLength(published)
  })

  it('[INV-79] a subscriber of MessageSent that re-submits the same requestId gets the in-flight answer', async () => {
    const h = answerHarness()
    const ask = h.permission(23)
    let resubmitted: Promise<AnswerOutcome> | null = null
    h.bus.subscribe('MessageSent', () => {
      resubmitted ??= h.paths.answerPermission(ask.id, 'allow', R1)
    })

    const answered = await h.paths.answerPermission(ask.id, 'allow', R1)

    expect(answered).toEqual({ kind: 'accepted' })
    expect(await resubmitted).toEqual({ kind: 'accepted' })
    expect(h.channel.calls).toHaveLength(1)
    expect(h.bus.handlerErrors).toEqual([])
  })
})
