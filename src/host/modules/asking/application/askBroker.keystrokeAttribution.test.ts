// layer: L2
// L2 (17 §1.2): the keystroke channel's attribution and late-Deny status line in the broker
// (ADR-010 item 10; ADR-012 items 3–4; 07 S6.08, S6.09, S6.11, S6.12; 16 §4.7 row
// `resolveExternally`) over the in-memory doubles of answerHarness.ts.
//
// TC-134-02: a resolution within 10 s of an injection is `answered-in-app`, any other is
// `answered-elsewhere`. The keystroke channel's resolution evidence cannot tell who answered, so the
// broker records `{askId, injectedAt, decision}` when it hands a decision to that channel. An ask is
// `open` after an injection when the channel refused (the relay failed or timed out, so the keys may
// have landed, S6.09): a resolution then is attributed by the window.
import { describe, expect, it } from 'vitest'
import { ANSWER_DWARF, answerHarness } from '../testing/answerHarness'
import { KEYSTROKE_ATTRIBUTION_WINDOW_MS, LATE_DENY_STATUS_LINE } from '../domain/attribution'

const R1 = '01890a5d-ac96-774b-bcce-000000001341'

/** A keystroke-channel permission whose injection was refused, so the ask is `open` again. */
async function injectedThenReopened() {
  const h = answerHarness()
  const ask = h.permission(1, { channel: 'hook-keystroke' })
  h.channel.script({ kind: 'refused', reason: 'channel-unavailable' })
  await h.paths.answerPermission(ask.id, 'allow', R1)
  expect(h.asks.byId(ask.id as never)?.state).toBe('open')
  return { h, ask }
}

describe('AskBroker keystroke attribution (ADR-010 item 10)', () => {
  it('[S6.12, ADR-010] a resolution observed within 10 s of an injection closes the ask answered-in-app', async () => {
    for (const after of [0, 9_999, KEYSTROKE_ATTRIBUTION_WINDOW_MS]) {
      const { h, ask } = await injectedThenReopened()
      h.clock.advance(after)

      h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, 'elsewhere')

      expect(h.asks.byId(ask.id as never)?.state).toBe('answered-in-app')
      expect(h.bus.ofType('AskClosed').map((event) => event.payload.reason)).toEqual([
        'answered-in-app'
      ])
    }
    expect(KEYSTROKE_ATTRIBUTION_WINDOW_MS).toBe(10_000)
  })

  it('[S6.11] a resolution observed later closes it answered-elsewhere with no notice', async () => {
    const { h, ask } = await injectedThenReopened()
    h.clock.advance(KEYSTROKE_ATTRIBUTION_WINDOW_MS + 1)

    h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, 'elsewhere')

    expect(h.asks.byId(ask.id as never)?.state).toBe('answered-elsewhere')
    // No notice: the close and the refusal of the earlier injection, nothing else.
    expect(h.eventTypes()).toEqual([
      'MessageSent',
      'AskReopened',
      'MessageDeliveryFailed',
      'AskClosed'
    ])
    expect(h.bus.ofType('AskClosed')[0]?.payload).toEqual({
      askId: ask.id,
      dwarfId: ANSWER_DWARF,
      reason: 'answered-elsewhere'
    })

    // Never injected: answered elsewhere at once, and a second resolution changes nothing.
    const fresh = answerHarness()
    const untouched = fresh.permission(2, { channel: 'hook-keystroke' })
    fresh.paths.resolveExternally(ANSWER_DWARF, untouched.providerRequestId, 'elsewhere')
    fresh.paths.resolveExternally(ANSWER_DWARF, untouched.providerRequestId, 'elsewhere')
    expect(fresh.asks.byId(untouched.id as never)?.state).toBe('answered-elsewhere')
    expect(fresh.eventTypes()).toEqual(['AskClosed'])
  })

  it('[S6.11, ADR-010] the window applies to the keystroke channel only: a driver resolution is always answered-elsewhere', async () => {
    const h = answerHarness()
    const ask = h.permission(3)
    h.channel.script({ kind: 'refused', reason: 'channel-unavailable' })
    await h.paths.answerPermission(ask.id, 'allow', R1)

    h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, 'elsewhere')

    expect(h.asks.byId(ask.id as never)?.state).toBe('answered-elsewhere')
  })

  it('[ADR-012] the broker attaches the late-Deny status line only for this channel', async () => {
    const closeWith = async (channel: 'hook-keystroke' | 'driver', decision: 'allow' | 'deny') => {
      const h = answerHarness()
      const ask = h.permission(4, { channel })
      await h.paths.answerPermission(ask.id, decision, R1)
      return h.bus.ofType('AskClosed')[0]?.payload
    }

    expect(await closeWith('hook-keystroke', 'deny')).toMatchObject({
      reason: 'answered-in-app',
      statusLine: LATE_DENY_STATUS_LINE
    })
    expect(await closeWith('hook-keystroke', 'allow')).not.toHaveProperty('statusLine')
    expect(await closeWith('driver', 'deny')).not.toHaveProperty('statusLine')

    // A Deny attributed in-app by the window (S6.12) carries it too.
    const h = answerHarness()
    const ask = h.permission(5, { channel: 'hook-keystroke' })
    h.channel.script({ kind: 'refused', reason: 'channel-unavailable' })
    await h.paths.answerPermission(ask.id, 'deny', R1)
    h.clock.advance(1_000)
    h.paths.resolveExternally(ANSWER_DWARF, ask.providerRequestId, 'elsewhere')
    expect(h.bus.ofType('AskClosed')[0]?.payload).toMatchObject({
      reason: 'answered-in-app',
      statusLine: LATE_DENY_STATUS_LINE
    })
  })
})
