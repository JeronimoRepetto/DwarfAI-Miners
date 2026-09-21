import { describe, expect, it } from 'vitest'
import { PROVIDER_EFFORT_LEVELS } from '../domain/launchTuning'
import type { AgentModelCatalog, AgentProviderOption, DwarfProvider } from '../domain/types'
import { EFFORT_RUBRIC, buildJevRouteRequest, mapEffortScore } from './routeRequest'

function provider(
  overrides: { provider: DwarfProvider } & Partial<AgentProviderOption>
): AgentProviderOption {
  return { installed: true, launchable: true, ...overrides }
}

function catalog(
  overrides: { provider: DwarfProvider } & Partial<AgentModelCatalog>
): AgentModelCatalog {
  return { models: [], efforts: [], source: 'none', ...overrides }
}

describe('buildJevRouteRequest', () => {
  it('skips with no-launchable-provider when nothing is launchable', () => {
    const result = buildJevRouteRequest({
      prompt: 'do the thing',
      providers: [provider({ provider: 'claude', launchable: false })],
      catalogs: [],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    expect(result).toEqual({ kind: 'skip', reason: 'no-launchable-provider' })
  })

  it('skips with no-launchable-provider given an empty provider list', () => {
    const result = buildJevRouteRequest({
      prompt: 'do the thing',
      providers: [],
      catalogs: [],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    expect(result).toEqual({ kind: 'skip', reason: 'no-launchable-provider' })
  })

  it('derives one choice per model, only from launchable providers', () => {
    const result = buildJevRouteRequest({
      prompt: 'fix the bug',
      providers: [
        provider({ provider: 'claude' }),
        provider({ provider: 'codex', launchable: false })
      ],
      catalogs: [
        catalog({
          provider: 'claude',
          source: 'provider',
          models: [{ value: 'sonnet-4.5' }, { value: 'opus-4.5', label: 'Opus 4.5' }]
        }),
        catalog({ provider: 'codex', source: 'history', models: [{ value: 'gpt-5.6-sol' }] })
      ],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.modelChoices).toEqual([
      {
        key: 'claude:sonnet-4.5',
        provider: 'claude',
        model: 'sonnet-4.5',
        criteria: expect.any(String)
      },
      {
        key: 'claude:opus-4.5',
        provider: 'claude',
        model: 'opus-4.5',
        criteria: expect.any(String)
      }
    ])
  })

  it('offers a provider with no models as a single unspecified-model choice', () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      providers: [provider({ provider: 'antigravity' })],
      catalogs: [catalog({ provider: 'antigravity' })],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.modelChoices).toEqual([
      { key: 'antigravity:', provider: 'antigravity', criteria: expect.any(String) }
    ])
  })

  it('treats a launchable provider missing from the catalogue list the same as one with no models', () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      providers: [provider({ provider: 'claude' })],
      catalogs: [],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.modelChoices).toEqual([
      { key: 'claude:', provider: 'claude', criteria: expect.any(String) }
    ])
  })

  it('carries the prompt as state unmodified when it fits the budget', () => {
    const result = buildJevRouteRequest({
      prompt: 'a short prompt',
      providers: [provider({ provider: 'claude' })],
      catalogs: [catalog({ provider: 'claude', models: [{ value: 'sonnet-4.5' }] })],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.state).toBe('a short prompt')
    expect(result.request.truncated).toBe(false)
  })

  it('keeps the head and the tail of a prompt that exceeds the budget, marked and flagged', () => {
    const long = 'x'.repeat(200_000)
    const result = buildJevRouteRequest({
      prompt: long,
      providers: [provider({ provider: 'claude' })],
      catalogs: [catalog({ provider: 'claude', models: [{ value: 'sonnet-4.5' }] })],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.truncated).toBe(true)
    expect(result.request.state.length).toBeLessThan(long.length)
    expect(result.request.state).toContain('\n…\n')
    const [head, tail] = result.request.state.split('\n…\n')
    expect(long.startsWith(head!)).toBe(true)
    expect(long.endsWith(tail!)).toBe(true)
  })

  it('carries nothing about this machine but the prompt itself', () => {
    // 'j' is this project's own placeholder for a real account name in a path
    // (see skills/privacy-guard/SKILL.md) — a fixture, never a real value.
    const fakePath = String.raw`C:\Users\j\work\secret-project\config.ts`
    const result = buildJevRouteRequest({
      prompt: `open ${fakePath} and fix the import`,
      providers: [provider({ provider: 'claude' })],
      catalogs: [catalog({ provider: 'claude', models: [{ value: 'sonnet-4.5' }] })],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.state).toContain(fakePath)
    const everythingElse = JSON.stringify({ ...result.request, state: undefined })
    expect(everythingElse).not.toContain(fakePath)
  })

  it('skips with budget-exceeded past TypeSafe’s 255-option choice cap', () => {
    const manyModels = Array.from({ length: 300 }, (_, i) => ({ value: `model-${i}` }))
    const result = buildJevRouteRequest({
      prompt: 'anything',
      providers: [provider({ provider: 'codex' })],
      catalogs: [catalog({ provider: 'codex', source: 'history', models: manyModels })],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    expect(result).toEqual({ kind: 'skip', reason: 'budget-exceeded' })
  })

  it('skips with budget-exceeded when the questions alone are too large to fit', () => {
    const hugeLabel = 'x'.repeat(200_000)
    const result = buildJevRouteRequest({
      prompt: 'anything',
      providers: [provider({ provider: 'codex' })],
      catalogs: [
        catalog({
          provider: 'codex',
          source: 'history',
          models: [{ value: 'm', label: hugeLabel }]
        })
      ],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    expect(result).toEqual({ kind: 'skip', reason: 'budget-exceeded' })
  })

  it('says in its own criteria when a provider cannot act on the effort score', () => {
    // A synthetic scenario: no real LAUNCHABLE_PROVIDERS member has an empty
    // effort ladder today (see launchTuning.ts), so this pins the wording for
    // the day one does, using opencode's already-empty table entry.
    const result = buildJevRouteRequest({
      prompt: 'anything',
      providers: [provider({ provider: 'opencode' })],
      catalogs: [catalog({ provider: 'opencode' })],
      effortLevels: PROVIDER_EFFORT_LEVELS
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.modelChoices[0]!.criteria).toContain('no effort level')
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
