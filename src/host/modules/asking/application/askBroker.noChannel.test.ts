// layer: L2
// L2 (17 §1.2): `AskBroker.open` for providers without an answer channel (ADR-011 items 3–5;
// ADR-010 items 3, 12; 16 §4.7 row `open`; 07 S6.01–S6.03, S1.16, S1.17; UC-016) over the
// in-memory doubles of answerHarness.ts. The sessions are capability data: no provider id decides.
//
// TC-132-02 (an auto-denied request leaves one `system-line`, and no `AskOpened` follows, so no
// card, cue or notification), TC-132-03 (a synthetic provider id with the same capability data
// behaves identically, R12).
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { DwarfId } from '../../../kernel/domain/values'
import type { AskInput } from '../../suppliers'
import { AUTO_DENIED_LINE_TEXT } from '../domain/emission'
import type { AskCapabilities, AskSession } from '../ports/sessionCapabilities'
import { ANSWER_DWARF, ANSWER_T0, OTHER_DWARF, answerHarness } from '../testing/answerHarness'

const R1 = '01890a5d-ac96-774b-bcce-000000001321'
const R2 = '01890a5d-ac96-774b-bcce-000000001322'

/** Lets every settled promise run its continuations. */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve()
}

const INTERACTIVE: AskCapabilities = {
  permission: 'interactive',
  question: 'form',
  observedPermission: 'detected',
  observedQuestion: 'detected'
}
const POLICY_ONLY: AskCapabilities = {
  permission: 'policy-only',
  question: 'none',
  observedPermission: 'none',
  observedQuestion: 'none'
}
const NO_CHANNEL_DETECTED: AskCapabilities = {
  permission: 'none',
  question: 'none',
  observedPermission: 'detected',
  observedQuestion: 'detected'
}

const session = (
  origin: AskSession['origin'],
  capabilities: AskCapabilities,
  providerId = 'catalog-provider'
): AskSession => ({ providerId, origin, capabilities })

const permission = (
  providerRequestId: string,
  channel: AskInput['channel'] = 'driver',
  hasAllowOnce = true
): AskInput => ({
  kind: 'permission',
  providerRequestId,
  channel,
  payload: { toolName: 'Bash', requestText: 'Run pnpm test' },
  options: { hasAllowOnce, hasRejectOnce: true }
})

const question = (
  providerRequestId: string,
  channel: AskInput['channel'] = 'driver'
): AskInput => ({
  kind: 'question',
  providerRequestId,
  channel,
  payload: { steps: [{ text: 'Which files?', options: ['All', 'Some'], allowsFreeText: true }] },
  secret: false
})

describe('AskBroker.open for a provider without an answer channel', () => {
  it("[US-ASK-006.AC10, S1.16] an auto-denied request writes one system line, answers Deny or decline through the channel, publishes no AskOpened and leaves the dwarf's status unchanged", async () => {
    const h = answerHarness()
    h.sessions.set(ANSWER_DWARF, session('launched', POLICY_ONLY))
    h.clock.advance(1_000)

    const denied = h.opens.open(ANSWER_DWARF, permission('perm-1'))
    const declined = h.opens.open(ANSWER_DWARF, question('question-1'))
    await flush()

    // Born auto-denied and closed at once (S6.03): the ask row records the degradation.
    for (const ask of [denied, declined]) {
      expect(ask).toMatchObject({ state: 'auto-denied', closedAt: ANSWER_T0 + 1_000 })
      expect(h.asks.byId(ask.id as never)).toEqual(ask)
    }
    // Deny for the permission, the explicit decline for the question, outside any transaction.
    expect(h.channel.calls).toEqual([
      expect.objectContaining({
        method: 'answerPermission',
        providerRequestId: 'perm-1',
        decision: 'deny'
      }),
      expect.objectContaining({ method: 'declineQuestion', providerRequestId: 'question-1' })
    ])
    expect(h.callsInTransaction).toEqual([false, false])
    // One ordinary chat line per request, its copy design's (K1).
    expect(h.lines.rows.map((row) => [row.dwarfId, row.entry.role, row.entry.text])).toEqual([
      [ANSWER_DWARF, 'system-line', AUTO_DENIED_LINE_TEXT],
      [ANSWER_DWARF, 'system-line', AUTO_DENIED_LINE_TEXT]
    ])
    expect(h.lines.appended.flat()).toHaveLength(2)
    // No AskOpened: no card, no attention cue, no notification; the dwarf has no open ask, so it
    // never becomes asking (INV-24).
    expect(h.eventTypes()).toEqual(['AskClosed', 'AskClosed'])
    expect(h.bus.ofType('AskClosed').map((event) => event.payload)).toEqual([
      { askId: denied.id, dwarfId: ANSWER_DWARF, reason: 'auto-denied' },
      { askId: declined.id, dwarfId: ANSWER_DWARF, reason: 'auto-denied' }
    ])
    expect(h.asks.openFor(ANSWER_DWARF)).toBeNull()

    // The same provider request again (INV-71): the first record, nothing written or sent again.
    expect(h.opens.open(ANSWER_DWARF, permission('perm-1'))).toEqual(denied)
    await flush()
    expect(h.channel.calls).toHaveLength(2)
    expect(h.lines.rows).toHaveLength(2)
    expect(h.eventTypes()).toEqual(['AskClosed', 'AskClosed'])
  })

  it('[US-ASK-006.AC11, INV-76] a channel-none ask makes the dwarf asking and every submit returns not-open', async () => {
    const h = answerHarness()
    h.sessions.set(ANSWER_DWARF, session('observed', NO_CHANNEL_DETECTED))

    const ask = h.opens.open(ANSWER_DWARF, permission('perm-1', 'none'))

    // S6.02: open with no answer channel, published like any ask (crew `startAsking`, attention).
    expect(ask).toMatchObject({ state: 'open', channel: 'none', kind: 'permission' })
    expect(h.asks.openFor(ANSWER_DWARF)).toEqual(ask)
    expect(h.eventTypes()).toEqual(['AskOpened'])
    expect(h.bus.ofType('AskOpened')[0]?.payload).toEqual({ ask })

    // Only "Jump to terminal": every submit is not-open, nothing written, nothing sent.
    expect(await h.paths.answerPermission(ask.id, 'allow', R1)).toEqual({ kind: 'not-open' })
    expect(await h.paths.answerPermission(ask.id, 'deny', R2)).toEqual({ kind: 'not-open' })
    expect(h.channel.calls).toEqual([])
    expect(h.records()).toEqual([])
    expect(h.lines.rows).toEqual([])
    expect(h.asks.byId(ask.id as never)?.state).toBe('open')

    // A question of the same session, and a permission reported on a channel kind: no card either.
    const q = h.opens.open(ANSWER_DWARF, question('question-1', 'none'))
    const onChannel = h.opens.open(ANSWER_DWARF, permission('perm-2', 'hook-keystroke'))
    expect([q.channel, onChannel.channel]).toEqual(['none', 'none'])
    expect(await h.paths.answerQuestion(q.id, [{ step: 0, option: 'All' }], R1)).toEqual({
      kind: 'not-open'
    })
  })

  it('[C-10] the no-allow_once fixture yields zero cards, one auto-denied ask and one chat line', async () => {
    const h = answerHarness()
    // An interactive launched session whose permission lacks allow_once (OQ-42 B).
    h.sessions.set(ANSWER_DWARF, session('launched', INTERACTIVE))

    const ask = h.opens.open(ANSWER_DWARF, permission('perm-1', 'driver', false))
    await flush()

    expect(h.bus.ofType('AskOpened')).toEqual([])
    expect(ask.state).toBe('auto-denied')
    expect(h.lines.rows).toHaveLength(1)
    expect(h.channel.calls).toEqual([
      expect.objectContaining({ method: 'answerPermission', decision: 'deny' })
    ])

    // Observed, the same option set opens with channel none: no card, "Jump to terminal" (FM-071).
    h.sessions.set(OTHER_DWARF, session('observed', INTERACTIVE))
    const observed = h.opens.open(OTHER_DWARF, permission('perm-1', 'hook-keystroke', false))
    expect(observed).toMatchObject({ state: 'open', channel: 'none' })
  })

  it('[S6.01, ADR-010] a request the session can answer opens a card ask on its channel', () => {
    const h = answerHarness()
    h.sessions.set(ANSWER_DWARF, session('launched', INTERACTIVE))

    const ask = h.opens.open(ANSWER_DWARF, permission('perm-1'))

    expect(ask).toMatchObject({ state: 'open', channel: 'driver', reannounce: true })
    expect(h.eventTypes()).toEqual(['AskOpened'])
    expect(h.lines.rows).toEqual([])
    expect(h.channel.calls).toEqual([])
  })

  it('[US-ASK-006.AC12, S1.17] an observed request of a kind the provider cannot detect opens nothing', () => {
    const h = answerHarness()
    h.sessions.set(
      ANSWER_DWARF,
      session('observed', { ...NO_CHANNEL_DETECTED, observedPermission: 'none' })
    )

    expect(() => h.opens.open(ANSWER_DWARF, permission('perm-1', 'none'))).toThrow(
      HostInvariantError
    )
    expect(h.asks.openFor(ANSWER_DWARF)).toBeNull()
    expect(h.asks.byProviderRequest({ dwarfId: ANSWER_DWARF }, 'perm-1')).toBeNull()
    expect(h.eventTypes()).toEqual([])
    expect(h.lines.rows).toEqual([])
  })

  it('[R12] a synthetic provider id with the same capability data behaves identically', async () => {
    const outcomes = []
    for (const providerId of ['opencode', 'synthetic-provider-zz']) {
      const h = answerHarness()
      const launched = '00000000-0000-7000-8000-000000013201' as DwarfId
      const observed = '00000000-0000-7000-8000-000000013202' as DwarfId
      h.sessions.set(launched, session('launched', POLICY_ONLY, providerId))
      h.sessions.set(observed, session('observed', NO_CHANNEL_DETECTED, providerId))
      const asks = [
        h.opens.open(launched, permission('perm-1')),
        h.opens.open(launched, question('question-1')),
        h.opens.open(observed, permission('perm-1', 'none'))
      ]
      await flush()
      outcomes.push({
        asks: asks.map(({ state, channel, kind }) => ({ state, channel, kind })),
        events: h.eventTypes(),
        calls: h.channel.calls.map((call) => call.method),
        lines: h.lines.rows.length
      })
    }
    expect(outcomes[1]).toEqual(outcomes[0])
    expect(outcomes[0]?.asks.map((ask) => ask.state)).toEqual([
      'auto-denied',
      'auto-denied',
      'open'
    ])
  })
})
