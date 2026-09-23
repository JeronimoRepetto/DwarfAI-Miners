import { describe, expect, it } from 'vitest'
import { NATIVE_SUBAGENT_FALLBACK_SENTENCE } from './delegationProtocol'
import { resolveDelegationRouting } from './delegationRouting'
import type { JevRouteLaunchResult } from '../domain/types'

/**
 * Turns one Jev routing call's own verdict (jev/routeLaunch.ts) into either a
 * DelegationRouting to launch the delegated child with, or a typed
 * DelegationFailure (#511). Pure: no router, no launcher, plain objects only.
 */

// #608: `parts` gained a `model` field — mechanical fixture update, this
// suite reads none of `parts` at all (resolveDelegationRouting is pure over
// `provider`/`model`/`effort`/`reason`/`fallbackTo` only), so a placeholder
// 'safe-default' default keeps every existing case unaffected.
function decision(overrides: Partial<Extract<JevRouteLaunchResult, { kind: 'decision' }>> = {}) {
  return {
    kind: 'decision' as const,
    provider: 'claude' as const,
    confidence: 0.9,
    truncated: false,
    tier: 'balanced' as const,
    parts: {
      provider: { value: 'claude' as const, confidence: 0.9, applied: 'answered' as const },
      tier: { value: 'balanced' as const, confidence: 0.9, applied: 'answered' as const },
      trivial: { value: false, probability: 0.1 },
      largeContext: { value: false, probability: 0.1 },
      model: { applied: 'safe-default' as const, reason: 'no-live-model' as const }
    },
    ...overrides
  }
}

function fallback(overrides: Partial<Extract<JevRouteLaunchResult, { kind: 'fallback' }>> = {}) {
  return { kind: 'fallback' as const, reason: 'unreachable' as const, ...overrides }
}

describe('resolveDelegationRouting', () => {
  it('turns a decision into a routing, passing model and effort through', () => {
    const result = resolveDelegationRouting(decision({ model: 'sonnet', effort: 'high' }))
    expect(result).toEqual({ routing: { provider: 'claude', model: 'sonnet', effort: 'high' } })
  })

  it('turns a decision with no model or effort into a routing naming only the provider', () => {
    const result = resolveDelegationRouting(decision())
    expect(result).toEqual({ routing: { provider: 'claude' } })
  })

  /*
   * #608: a delegated subtask routes through the SAME `JevLaunchRouter.route`
   * an ordinary launch uses (this file's own module comment), so whatever
   * model #608's second request chose reaches here exactly like any other —
   * `resolveDelegationRouting` reads `result.model` alone, with no special
   * case for HOW it was chosen. Proven with a `parts.model` shaped like a
   * genuine request-2 winner (`applied: 'answered'`, a Noul probability) to
   * show the seam carries it through untouched.
   */
  it('picks up whatever model #608’s second Jev request chose, exactly like any other', () => {
    const result = resolveDelegationRouting(
      decision({
        model: 'gpt-5.6-sol',
        effort: 'high',
        parts: {
          provider: { value: 'claude', confidence: 0.9, applied: 'answered' },
          tier: { value: 'balanced', confidence: 0.9, applied: 'answered' },
          trivial: { value: false, probability: 0.1 },
          largeContext: { value: false, probability: 0.1 },
          model: { value: 'gpt-5.6-sol', applied: 'answered', probability: 0.82 }
        }
      })
    )
    expect(result).toEqual({
      routing: { provider: 'claude', model: 'gpt-5.6-sol', effort: 'high' }
    })
  })

  it('uses the user’s own configured default when a fallback still carries one, even for low-confidence', () => {
    const result = resolveDelegationRouting(
      fallback({
        reason: 'low-confidence',
        confidence: 0.2,
        fallbackTo: { provider: 'opencode', model: 'gpt-5', effort: 'medium' }
      })
    )
    expect(result).toEqual({ routing: { provider: 'opencode', model: 'gpt-5', effort: 'medium' } })
  })

  it('uses a configured default that names only a provider', () => {
    const result = resolveDelegationRouting(fallback({ fallbackTo: { provider: 'codex' } }))
    expect(result).toEqual({ routing: { provider: 'codex' } })
  })

  it('maps a low-confidence fallback with no configured default to jev-unsure', () => {
    const result = resolveDelegationRouting(fallback({ reason: 'low-confidence' }))
    expect('failure' in result && result.failure.kind).toBe('jev-unsure')
  })

  it.each([
    'no-key',
    'no-launchable-provider',
    'unreachable',
    'timeout',
    'rate-limited',
    'unauthorized',
    'invalid-response',
    'budget-exceeded'
  ] as const)('maps a %s fallback with no configured default to jev-unreachable', (reason) => {
    const result = resolveDelegationRouting(fallback({ reason }))
    expect('failure' in result && result.failure.kind).toBe('jev-unreachable')
  })

  it('every failure carries the native-subagent fallback sentence', () => {
    const result = resolveDelegationRouting(fallback({ reason: 'unreachable' }))
    expect('failure' in result && result.failure.detail).toContain(
      NATIVE_SUBAGENT_FALLBACK_SENTENCE
    )
  })
})
