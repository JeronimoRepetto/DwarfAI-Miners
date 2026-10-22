import { describe, expect, it } from 'vitest'
import { isChatReadOnly, stepPinnedChat, type PinnedChatInput } from './pinnedChat'

/*
 * 07 machine 18 `PinnedChat` (ISSUE-302): one pin's own life in Valle, `live` ⇄ `gone`, closed by an unpin, its mine's
 * removal or Reset metrics, and restored across a restart. Each listed transition is taken; anything else is refused.
 */
describe('machine 18 diagram conformance', () => {
  it('[US-VALLE-007.AC07, S18.02] a pin whose dwarf’s session ended reads gone and its chat is read-only', () => {
    expect(isChatReadOnly('live')).toBe(false)
    const step = stepPinnedChat('live', { kind: 'departed', mineRemoved: false })
    expect(step).toEqual({ ok: true, id: 'S18.02', state: 'gone' })
    expect(isChatReadOnly('gone')).toBe(true)
    // A pin already gone does not depart again.
    expect(stepPinnedChat('gone', { kind: 'departed', mineRemoved: false })).toEqual({
      ok: false,
      reason: 'not-listed'
    })
  })

  it('[S18.03] a pin whose mine is removed closes outright', () => {
    expect(stepPinnedChat('live', { kind: 'departed', mineRemoved: true })).toEqual({
      ok: true,
      id: 'S18.03',
      state: 'closed'
    })
  })

  it('[S18.01, S18.04, S18.05, S18.06] pin, close, restore and reset follow 07 machine 18', () => {
    const rows: [Parameters<typeof stepPinnedChat>[0], PinnedChatInput, unknown][] = [
      ['none', { kind: 'pin' }, { ok: true, id: 'S18.01', state: 'live' }],
      ['live', { kind: 'unpin' }, { ok: true, id: 'S18.04', state: 'closed' }],
      ['gone', { kind: 'unpin' }, { ok: true, id: 'S18.04', state: 'closed' }],
      ['none', { kind: 'restore', dwarf: 'alive' }, { ok: true, id: 'S18.05', state: 'live' }],
      ['none', { kind: 'restore', dwarf: 'ended' }, { ok: true, id: 'S18.05', state: 'gone' }],
      // A dwarf whose row Reset metrics deleted is dropped, never restored.
      ['none', { kind: 'restore', dwarf: 'deleted' }, { ok: true, id: 'S18.05', state: 'closed' }],
      ['live', { kind: 'reset' }, { ok: true, id: 'S18.06', state: 'closed' }],
      ['gone', { kind: 'reset' }, { ok: true, id: 'S18.06', state: 'closed' }],
      // Not in 07 machine 18: refused, nothing changes (ADR-024).
      ['live', { kind: 'pin' }, { ok: false, reason: 'not-listed' }],
      ['none', { kind: 'unpin' }, { ok: false, reason: 'not-listed' }],
      ['live', { kind: 'restore', dwarf: 'alive' }, { ok: false, reason: 'not-listed' }],
      ['gone', { kind: 'departed', mineRemoved: true }, { ok: false, reason: 'not-listed' }]
    ]
    for (const [state, input, expected] of rows) {
      expect(stepPinnedChat(state, input), `${state} ${JSON.stringify(input)}`).toEqual(expected)
    }
  })
})
