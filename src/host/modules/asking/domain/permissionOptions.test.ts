import { describe, expect, it } from 'vitest'
import { openAsk, type AskOpening } from './askMachine'
import { hasAllowOnce, isPermissionDecision, permissionDecisions } from './permissionOptions'

const T0 = 1_790_000_000_000

/** A permission request as a driver or the hook ingress reports it (15 §1.2 `AskInput`). */
const permission = (
  channel: AskOpening['channel'],
  options: { hasAllowOnce: boolean; hasRejectOnce: boolean }
): AskOpening => ({
  id: 'ask-1',
  dwarfId: 'dwarf-1',
  kind: 'permission',
  channel,
  providerRequestId: 'request-1',
  payload: { toolName: 'Bash', requestText: 'rm -rf build' },
  options,
  reannounce: true
})

describe('permission options (ADR-010 item 3, INV-73)', () => {
  it('[US-ASK-003.AC08, INV-73] a permission offers exactly Allow and Deny, never an always or session-scope decision', () => {
    expect(permissionDecisions()).toEqual(['allow', 'deny'])
    // The Host never accepts a third decision, whatever a provider's option set holds.
    for (const broader of [
      'always',
      'allow_always',
      'allow-session',
      'reject_always',
      'Allow',
      ''
    ]) {
      expect(isPermissionDecision(broader)).toBe(false)
    }
    expect(isPermissionDecision('allow')).toBe(true)
    expect(isPermissionDecision('deny')).toBe(true)
  })

  it('[INV-73] a permission whose options lack allow_once is not a card ask', () => {
    const noAllowOnce = { hasAllowOnce: false, hasRejectOnce: true }
    expect(hasAllowOnce(noAllowOnce)).toBe(false)
    const withAllowOnce = { hasAllowOnce: true, hasRejectOnce: true }
    expect(hasAllowOnce(withAllowOnce)).toBe(true)

    // On an answer channel it never opens: the no-channel handling takes it (later: ISSUE-132).
    expect(openAsk(permission('driver', noAllowOnce), T0)).toEqual({ kind: 'not-a-card-ask' })
    // An observed one opens with channel none: no card, only "Jump to terminal" (S6.02).
    const observed = openAsk(permission('none', noAllowOnce), T0)
    expect(observed.kind === 'opened' && observed.transition).toBe('S6.02')
    expect(observed.kind === 'opened' && observed.ask.channel).toBe('none')
  })
})
