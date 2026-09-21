import { describe, expect, it } from 'vitest'
import { PROVIDER_EFFORT_LEVELS } from '../domain/launchTuning'
import type { AgentProviderOption, DwarfProvider } from '../domain/types'
import {
  EFFORT_RUBRIC,
  IS_TRIVIAL_CRITERIA,
  MODEL_TIER_CRITERIA,
  NEEDS_LARGE_CONTEXT_CRITERIA,
  TIER_CHOICE_KEYS,
  buildJevRouteRequest,
  mapEffortScore
} from './routeRequest'

function provider(
  overrides: { provider: DwarfProvider } & Partial<AgentProviderOption>
): AgentProviderOption {
  return { installed: true, launchable: true, ...overrides }
}

/*
 * request v2 (jev-routing-profiles T3) replaces buildJevRouteRequest's whole
 * shape: input drops `catalogs`/`effortLevels` (no longer needed — the
 * request no longer asks one Choice per model), and gains `routingProfile`;
 * the result carries `prompt`/`routingProfile`/`providerCriteria` instead of
 * `state`/`modelChoices`. Every test below that exercised the old
 * per-model-choice shape is REWRITTEN rather than amended, and two are
 * REMOVED outright because the scenario they pinned no longer exists:
 * - the 255-option choice-cap test: `provider` now offers at most one option
 *   per LAUNCHABLE provider plus `no_preference` (a handful, never near 255).
 * - the "no effort level" per-choice caveat test: that caveat lived in the
 *   old per-model criteria string; providers are now the whole Choice
 *   option, and every LAUNCHABLE_PROVIDERS member has a non-empty effort
 *   ladder today (PROVIDER_EFFORT_LEVELS in launchTuning.ts), so the
 *   scenario it pinned (opencode, never launchable) can no longer reach a
 *   provider Choice option at all.
 */
describe('buildJevRouteRequest', () => {
  it('skips with no-launchable-provider when nothing is launchable', () => {
    const result = buildJevRouteRequest({
      prompt: 'do the thing',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'claude', launchable: false })]
    })

    expect(result).toEqual({ kind: 'skip', reason: 'no-launchable-provider' })
  })

  it('skips with no-launchable-provider given an empty provider list', () => {
    const result = buildJevRouteRequest({
      prompt: 'do the thing',
      routingProfile: 'balanced',
      providers: []
    })

    expect(result).toEqual({ kind: 'skip', reason: 'no-launchable-provider' })
  })

  it('carries the prompt and the routing profile unmodified when the prompt fits the budget', () => {
    const result = buildJevRouteRequest({
      prompt: 'a short prompt',
      routingProfile: 'premium',
      providers: [provider({ provider: 'claude' })]
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.prompt).toBe('a short prompt')
    expect(result.request.routingProfile).toBe('premium')
    expect(result.request.truncated).toBe(false)
  })

  it('keeps the head and the tail of a prompt that exceeds the budget, marked and flagged', () => {
    const long = 'x'.repeat(200_000)
    const result = buildJevRouteRequest({
      prompt: long,
      routingProfile: 'balanced',
      providers: [provider({ provider: 'claude' })]
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.truncated).toBe(true)
    expect(result.request.prompt.length).toBeLessThan(long.length)
    expect(result.request.prompt).toContain('\n…\n')
    const [head, tail] = result.request.prompt.split('\n…\n')
    expect(long.startsWith(head!)).toBe(true)
    expect(long.endsWith(tail!)).toBe(true)
  })

  it('carries nothing about this machine but the prompt itself', () => {
    // 'j' is this project's own placeholder for a real account name in a path
    // (see skills/privacy-guard/SKILL.md) — a fixture, never a real value.
    const fakePath = String.raw`C:\Users\j\work\secret-project\config.ts`
    const result = buildJevRouteRequest({
      prompt: `open ${fakePath} and fix the import`,
      routingProfile: 'balanced',
      providers: [provider({ provider: 'claude' })]
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.prompt).toContain(fakePath)
    const everythingElse = JSON.stringify({ ...result.request, prompt: undefined })
    expect(everythingElse).not.toContain(fakePath)
  })

  it('builds one provider choice per launchable provider, plus no_preference, excluding a non-launchable one', () => {
    const result = buildJevRouteRequest({
      prompt: 'fix the bug',
      routingProfile: 'balanced',
      providers: [
        provider({ provider: 'claude' }),
        provider({ provider: 'codex', launchable: false }),
        provider({ provider: 'antigravity' })
      ]
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(Object.keys(result.request.providerCriteria).sort()).toEqual(
      ['antigravity', 'claude', 'no_preference'].sort()
    )
  })

  it("names each launchable provider's own product name and the tiers its capability table actually offers", () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'claude' })]
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    const criteria = result.request.providerCriteria.claude!
    expect(criteria.what).toContain('Claude Code')
    expect(criteria.what).toContain('fast-cheap')
    expect(criteria.what).toContain('balanced')
    expect(criteria.what).toContain('frontier')
    expect(criteria.examples).toHaveLength(2)
  })

  it('offers no_preference as a real option that names no specific provider', () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'claude' })]
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.providerCriteria.no_preference!.what).not.toContain('Claude')
    expect(result.request.providerCriteria.no_preference!.examples).toHaveLength(2)
  })
})

describe('the fixed is_trivial and needs_large_context questions', () => {
  it('is contrastive on both sides, with two examples each', () => {
    for (const criteria of [IS_TRIVIAL_CRITERIA, NEEDS_LARGE_CONTEXT_CRITERIA]) {
      expect(criteria.true.examples).toHaveLength(2)
      expect(criteria.false.examples).toHaveLength(2)
      expect(criteria.true.what).not.toBe(criteria.false.what)
    }
  })
})

describe('the fixed model_tier question', () => {
  it('has exactly the five documented keys', () => {
    expect(Object.keys(MODEL_TIER_CRITERIA).sort()).toEqual([...TIER_CHOICE_KEYS].sort())
  })

  it('says frontier is not for a trivial prompt, whatever the profile', () => {
    expect(MODEL_TIER_CRITERIA.frontier.not_for).toContain('Trivial')
    expect(MODEL_TIER_CRITERIA.frontier.not_for).toContain('whatever the routing profile')
  })

  it('gives every option exactly two examples', () => {
    for (const criteria of Object.values(MODEL_TIER_CRITERIA)) {
      expect(criteria.examples).toHaveLength(2)
    }
  })
})

describe('mapEffortScore', () => {
  it.each([
    ['claude', 0, 'low'],
    ['claude', 1.5, 'high'],
    ['claude', 3, 'max'],
    ['codex', 0, 'low'],
    ['codex', 1.5, 'xhigh'],
    ['codex', 3, 'ultra'],
    ['antigravity', 0, 'low'],
    ['antigravity', 1.5, 'medium'],
    ['antigravity', 3, 'high']
  ] as const)('maps a score of %s for %s onto %s', (provider, score, expected) => {
    expect(mapEffortScore(provider, score, PROVIDER_EFFORT_LEVELS)).toBe(expected)
  })

  it('returns undefined for a provider with an empty effort ladder, at every score', () => {
    expect(mapEffortScore('opencode', 0, PROVIDER_EFFORT_LEVELS)).toBeUndefined()
    expect(mapEffortScore('opencode', 1.5, PROVIDER_EFFORT_LEVELS)).toBeUndefined()
    expect(mapEffortScore('opencode', 3, PROVIDER_EFFORT_LEVELS)).toBeUndefined()
  })
})

describe('EFFORT_RUBRIC', () => {
  it('has exactly the four task-difficulty levels, trivial to architectural', () => {
    expect(EFFORT_RUBRIC).toHaveLength(4)
  })
})
