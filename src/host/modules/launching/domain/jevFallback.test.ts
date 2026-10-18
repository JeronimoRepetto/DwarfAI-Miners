// layer: L1
// L1 (17 §1.1): the Jev fallback → launch cause mapping of ADR-020 item 2 and 16 §6.4, and the
// routing decision a normal Jev launch settles with (07 S5.12–S5.15; ADR-028 D2; OQ-38 B).
// TC-164-01 (every reason), TC-164-03 (`no-key`, the bridge's report of `not-configured`).
import { describe, expect, it } from 'vitest'
import type { JevFallbackReason, LaunchFailureCause } from '../../../kernel/domain/sharedContracts'
import type { ProviderId } from '../../../kernel/domain/values'
import { decideJevRouting, jevFallbackFailure, jevLaunchCause, type JevAnswer } from './jevFallback'
import {
  CAUSE_5_REASON_SENTENCE_PLACEHOLDER,
  NO_LAUNCHABLE_PROVIDER_SENTENCE
} from './launchFailure'
import { NO_SUPPLIER_LABEL } from './supplierLabel'

const FIVE_CAUSES: readonly LaunchFailureCause[] = [
  'not-installed',
  'exited-at-once',
  'could-not-start',
  'jev-unreachable',
  'jev-could-not-choose'
]

const RETRYABLE: readonly JevFallbackReason[] = [
  'unreachable',
  'timeout',
  'rate-limited',
  'invalid-response'
]

const NOT_RETRYABLE: readonly JevFallbackReason[] = [
  'no-key',
  'unauthorized',
  'budget-exceeded',
  'low-confidence'
]

const EVERY_REASON: readonly JevFallbackReason[] = [
  ...RETRYABLE,
  ...NOT_RETRYABLE,
  'no-launchable-provider',
  'effort-ceiling'
]

const LABEL = NO_SUPPLIER_LABEL
const DEFAULT = 'simulated' as ProviderId

describe('Jev fallback to launch cause (ADR-020 item 2)', () => {
  it('[US-LAUNCH-006.AC04, S5.14] unreachable, timeout, rate-limited and invalid-response are jev-unreachable with Retry and Pick manually', () => {
    for (const reason of RETRYABLE) {
      expect(jevLaunchCause(reason), reason).toBe('jev-unreachable')
      const failure = jevFallbackFailure(reason, LABEL)
      expect(failure, reason).toEqual({
        cause: 'jev-unreachable',
        supplierLabel: LABEL,
        jevReason: reason,
        actions: ['retry', 'pick-manually']
      })
    }
  })

  it('[US-LAUNCH-006.AC16, S5.15] no-key, unauthorized, budget-exceeded and low-confidence are jev-could-not-choose with Pick manually and no Retry', () => {
    for (const reason of NOT_RETRYABLE) {
      expect(jevLaunchCause(reason), reason).toBe('jev-could-not-choose')
      const failure = jevFallbackFailure(reason, LABEL)
      expect(failure.cause, reason).toBe('jev-could-not-choose')
      expect(failure.jevReason, reason).toBe(reason)
      expect(failure.actions, reason).toEqual(['pick-manually'])
      // The app's own reason sentence is design copy, still a marked placeholder (S-020-2).
      expect(failure.reasonSentence, reason).toBe(CAUSE_5_REASON_SENTENCE_PLACEHOLDER)
    }
  })

  it('[US-LAUNCH-006.AC17, S5.15] no-launchable-provider is jev-could-not-choose with no action and its fixed sentence', () => {
    expect(jevFallbackFailure('no-launchable-provider', LABEL)).toEqual({
      cause: 'jev-could-not-choose',
      supplierLabel: LABEL,
      jevReason: 'no-launchable-provider',
      reasonSentence: NO_LAUNCHABLE_PROVIDER_SENTENCE,
      actions: []
    })
    expect(NO_LAUNCHABLE_PROVIDER_SENTENCE).toBe('No launchable provider to choose from.')
  })

  it('[US-LAUNCH-006.AC18, INV-52] a fallback a retry cannot fix settles as jev-could-not-choose, one of the five causes, and never a new cause', () => {
    for (const reason of EVERY_REASON) {
      const cause = jevLaunchCause(reason)
      expect(FIVE_CAUSES, reason).toContain(cause)
      const failure = jevFallbackFailure(reason, LABEL)
      expect(failure.cause, reason).toBe(cause)
      expect(failure.actions.includes('retry'), reason).toBe(RETRYABLE.includes(reason))
    }
    // effort-ceiling is a reason, never a sixth cause: with nothing to hand back it cannot choose.
    expect(jevLaunchCause('effort-ceiling')).toBe('jev-could-not-choose')
    expect(
      decideJevRouting(
        { ok: true, value: { fallback: 'effort-ceiling' } },
        { supplierLabel: LABEL, pickers: false }
      )
    ).toEqual({ kind: 'failed', failure: jevFallbackFailure('effort-ceiling', LABEL) })
  })

  it('[US-LAUNCH-006.AC07, US-RES-006.AC03] both Jev causes with a provider to pick carry the pick-manually action', () => {
    for (const reason of EVERY_REASON.filter((r) => r !== 'no-launchable-provider')) {
      expect(jevFallbackFailure(reason, LABEL).actions, reason).toContain('pick-manually')
    }
  })

  // TC-164-03: the bridge reports JevAdvisor's `not-configured` as the `no-key` fallback.
  it('[ADR-020] a no-key fallback fails the launch jev-could-not-choose with jevReason no-key', () => {
    const routed = decideJevRouting(
      { ok: true, value: { fallback: 'no-key' } },
      { supplierLabel: LABEL, pickers: false }
    )
    expect(routed).toMatchObject({
      kind: 'failed',
      failure: { cause: 'jev-could-not-choose', jevReason: 'no-key', actions: ['pick-manually'] }
    })
  })
})

describe('Jev routing decision (07 S5.12–S5.15)', () => {
  const ctx = { supplierLabel: LABEL, pickers: false }

  it('[S5.12] a pick continues with the provider, model and effort Jev chose', () => {
    const answer: JevAnswer = { providerId: DEFAULT, model: 'sim-small', effort: 'low' }
    expect(decideJevRouting({ ok: true, value: answer }, ctx)).toEqual({
      kind: 'picked',
      pick: { providerId: DEFAULT, model: 'sim-small', effort: 'low' }
    })
  })

  it('[S5.13, ADR-028] a fallback carrying the configured default hands it back, with no failure', () => {
    const answer: JevAnswer = {
      providerId: DEFAULT,
      model: 'sim-small',
      fallback: 'effort-ceiling'
    }
    expect(decideJevRouting({ ok: true, value: answer }, ctx)).toEqual({
      kind: 'handed-back',
      picks: { providerId: DEFAULT, model: 'sim-small' }
    })
  })

  it('[ADR-020] a fallback with the pickers set launches on them, so no Jev cause is set', () => {
    for (const reason of EVERY_REASON) {
      const routed = decideJevRouting(
        { ok: true, value: { fallback: reason } },
        { supplierLabel: 'Simulated', pickers: true }
      )
      expect(routed, reason).toEqual({ kind: 'pickers' })
    }
  })

  it('[S5.14, S5.15] an advisor error is its own Jev cause, with no reason it did not name', () => {
    expect(decideJevRouting({ ok: false, error: 'jev-unreachable' }, ctx)).toEqual({
      kind: 'failed',
      failure: {
        cause: 'jev-unreachable',
        supplierLabel: LABEL,
        actions: ['retry', 'pick-manually']
      }
    })
    expect(decideJevRouting({ ok: false, error: 'jev-could-not-choose' }, ctx)).toEqual({
      kind: 'failed',
      failure: {
        cause: 'jev-could-not-choose',
        supplierLabel: LABEL,
        reasonSentence: CAUSE_5_REASON_SENTENCE_PLACEHOLDER,
        actions: ['pick-manually']
      }
    })
  })

  it('[S5.14] an answer with neither a provider nor a fallback is an invalid response', () => {
    expect(decideJevRouting({ ok: true, value: {} }, ctx)).toEqual({
      kind: 'failed',
      failure: jevFallbackFailure('invalid-response', LABEL)
    })
  })
})
