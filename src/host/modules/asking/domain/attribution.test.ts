// layer: L1
// L1 (17 §1.1): ADR-010 item 10's attribution window and ADR-012 item 3's late-Deny status line
// over plain values, and machine 6's S6.12 (07 §6). Time is passed in (05 §2.2, R1).
import { describe, expect, it } from 'vitest'
import {
  KEYSTROKE_ATTRIBUTION_WINDOW_MS,
  LATE_DENY_STATUS_LINE,
  answeredInAppBy,
  attributesByInjection,
  lateDenyStatusLine
} from './attribution'
import { openAsk, resolveExternally } from './askMachine'

const T0 = 1_790_000_000_000

describe('keystroke attribution (ADR-010 item 10)', () => {
  it('[S6.12, ADR-010] a resolution within 10 s of the injection, the mark included, is the injection', () => {
    const injection = { injectedAt: T0, decision: 'allow' } as const
    expect(answeredInAppBy(injection, T0)).toBe(true)
    expect(answeredInAppBy(injection, T0 + KEYSTROKE_ATTRIBUTION_WINDOW_MS)).toBe(true)
    expect(answeredInAppBy(injection, T0 + KEYSTROKE_ATTRIBUTION_WINDOW_MS + 1)).toBe(false)
    // Before the injection, and with none recorded, it is never DwarfAI's.
    expect(answeredInAppBy(injection, T0 - 1)).toBe(false)
    expect(answeredInAppBy(undefined, T0)).toBe(false)
  })

  it('[ADR-010] only the keystroke channel is attributed by the window', () => {
    expect(attributesByInjection('hook-keystroke')).toBe(true)
    for (const channel of ['driver', 'hook-decision', 'http', 'none'] as const) {
      expect(attributesByInjection(channel)).toBe(false)
    }
  })

  it('[ADR-012] the late-Deny status line belongs to a Deny on a channel that is not stale-answer safe', () => {
    expect(lateDenyStatusLine('deny', false)).toBe(LATE_DENY_STATUS_LINE)
    expect(lateDenyStatusLine('allow', false)).toBeNull()
    expect(lateDenyStatusLine('deny', true)).toBeNull()
  })

  it('[S6.12, S6.11] an open ask resolved elsewhere closes answered-in-app only when attributed to the injection', () => {
    const opened = openAsk(
      {
        id: 'ask-1',
        dwarfId: 'dwarf-1',
        kind: 'permission',
        channel: 'hook-keystroke',
        providerRequestId: 'toolu_01',
        payload: { toolName: 'Bash', requestText: 'pnpm test' },
        options: { hasAllowOnce: true },
        reannounce: true
      },
      T0
    )
    if (opened.kind !== 'opened') throw new Error('a card ask opens')
    expect(resolveExternally(opened.ask, 'elsewhere', T0 + 5, true)).toMatchObject({
      ask: { state: 'answered-in-app', closedAt: T0 + 5 },
      transition: 'S6.12',
      held: null
    })
    expect(resolveExternally(opened.ask, 'elsewhere', T0 + 5, false).transition).toBe('S6.11')
    // A cancellation is never an answer, attributed or not (S6.13).
    expect(resolveExternally(opened.ask, 'cancelled', T0 + 5, true).transition).toBe('S6.13')
  })
})
