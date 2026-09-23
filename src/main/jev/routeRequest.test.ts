import { describe, expect, it } from 'vitest'
import { PROVIDER_EFFORT_LEVELS } from '../domain/launchTuning'
import { DWARF_PROVIDERS } from '../domain/types'
import type { AgentProviderOption, DwarfProvider } from '../domain/types'
import type { ModelCapabilityEntry } from './capabilities/modelCapability'
import { MODEL_CAPABILITIES } from './capabilities/modelCapability'
import { PROVIDER_TOOLING_MARKERS } from './capabilities/providerTooling'
import type { JevCapabilityTable } from './routeDecision'
import {
  EFFORT_RUBRIC,
  IS_TRIVIAL_CRITERIA,
  MODEL_TIER_CRITERIA,
  NEEDS_LARGE_CONTEXT_CRITERIA,
  TIER_CHOICE_KEYS,
  buildJevModelRouteRequest,
  buildJevRouteRequest,
  candidateCapabilityFacts,
  distinctiveToolingNames,
  mapEffortScore,
  modelChoiceInstructions,
  modelFitInstructions,
  truncateAndCheckBudget
} from './routeRequest'

/*
 * AMENDED for #547 (was: buildJevRouteRequest reading MODEL_CAPABILITIES
 * itself, so no test call needed to pass one). `capabilities` is now an
 * injected, required input — see BuildJevRouteRequestInput's own comment —
 * so every call below gains `capabilities: MODEL_CAPABILITIES`, the same
 * real static table it used to read implicitly. Only the tests further down
 * that exercise the NEW omission/derived-tier behaviour build their own
 * small synthetic table instead.
 */

function provider(
  overrides: { provider: DwarfProvider } & Partial<AgentProviderOption>
): AgentProviderOption {
  return { installed: true, launchable: true, ...overrides }
}

function capabilityEntry(
  overrides: Partial<ModelCapabilityEntry> & Pick<ModelCapabilityEntry, 'tier'>
): ModelCapabilityEntry {
  return {
    what: 'test fixture',
    notFor: 'test fixture',
    examples: ['a', 'b'],
    launchTarget: true,
    effortLevels: 'all',
    relativeCost: 'medium',
    sources: ['test fixture'],
    verifiedOn: '2026-09-21',
    ...overrides
  }
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
      providers: [provider({ provider: 'claude', launchable: false })],
      capabilities: MODEL_CAPABILITIES
    })

    expect(result).toEqual({ kind: 'skip', reason: 'no-launchable-provider' })
  })

  it('skips with no-launchable-provider given an empty provider list', () => {
    const result = buildJevRouteRequest({
      prompt: 'do the thing',
      routingProfile: 'balanced',
      providers: [],
      capabilities: MODEL_CAPABILITIES
    })

    expect(result).toEqual({ kind: 'skip', reason: 'no-launchable-provider' })
  })

  it('carries the prompt and the routing profile unmodified when the prompt fits the budget', () => {
    const result = buildJevRouteRequest({
      prompt: 'a short prompt',
      routingProfile: 'premium',
      providers: [provider({ provider: 'claude' })],
      capabilities: MODEL_CAPABILITIES
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
      providers: [provider({ provider: 'claude' })],
      capabilities: MODEL_CAPABILITIES
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
      providers: [provider({ provider: 'claude' })],
      capabilities: MODEL_CAPABILITIES
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
      ],
      capabilities: MODEL_CAPABILITIES
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
      providers: [provider({ provider: 'claude' })],
      capabilities: MODEL_CAPABILITIES
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
      providers: [provider({ provider: 'claude' })],
      capabilities: MODEL_CAPABILITIES
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.providerCriteria.no_preference!.what).not.toContain('Claude')
    expect(result.request.providerCriteria.no_preference!.examples).toHaveLength(2)
  })

  /*
   * New for #547: `capabilities` is now what decides whether a LAUNCHABLE
   * provider gets a `provider` option at all — a provider can be started but
   * still have nothing this question could truthfully describe, which is
   * exactly OpenCode's own honest state when its live catalogue could not be
   * read (routeLaunch.ts derives an empty table for it in that case).
   */
  it('omits a launchable provider whose capability table has zero launch-target entries', () => {
    const emptyOpenCode: JevCapabilityTable = { ...MODEL_CAPABILITIES, opencode: {} }
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'claude' }), provider({ provider: 'opencode' })],
      capabilities: emptyOpenCode
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(Object.keys(result.request.providerCriteria).sort()).toEqual(
      ['claude', 'no_preference'].sort()
    )
  })

  it('skips with no-launchable-provider when the only launchable provider has an empty capability table', () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'opencode' })],
      capabilities: { ...MODEL_CAPABILITIES, opencode: {} }
    })

    expect(result).toEqual({ kind: 'skip', reason: 'no-launchable-provider' })
  })

  it("lists OpenCode's own real tiers from its injected (derived) capability table", () => {
    const opencodeCapabilities: JevCapabilityTable = {
      ...MODEL_CAPABILITIES,
      opencode: {
        'opencode/free-fast': capabilityEntry({ tier: 'fast-cheap' }),
        'opencode-go/kimi-k3': capabilityEntry({ tier: 'frontier' })
      }
    }
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'opencode' })],
      capabilities: opencodeCapabilities
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    const criteria = result.request.providerCriteria.opencode!
    expect(criteria.what).toContain('fast-cheap')
    expect(criteria.what).toContain('frontier')
    expect(criteria.examples).toHaveLength(2)
  })

  it("states OpenCode's own tooling note as a fact, not the old empty placeholder", () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'opencode' })],
      capabilities: {
        ...MODEL_CAPABILITIES,
        opencode: { 'opencode/free-fast': capabilityEntry({ tier: 'fast-cheap' }) }
      }
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    const criteria = result.request.providerCriteria.opencode!
    expect(criteria.what).not.toBe('')
    expect(criteria.what.length).toBeGreaterThan(0)
    expect(criteria.examples[0]).not.toBe('')
    expect(criteria.examples[1]).not.toBe('')
  })
})

/*
 * #625: the `provider` criteria used to describe held-vs-detached session
 * style and nothing else — a prompt naming Codex's own `request_user_input`
 * tool had nothing here to connect it to Codex, and Jev routed it to Claude
 * at 0.68 confidence instead (issue #625's own reported root cause). These
 * pin that a launchable provider's own SOURCED tooling markers
 * (`PROVIDER_TOOLING_MARKERS`, capabilities/providerTooling.ts) actually
 * reach the wire, driven from that one constant rather than restated here —
 * and that a marker distinctive to one provider never leaks into another's
 * criteria, the same shared-marker honesty the issue's own scope demands for
 * `AGENTS.md`.
 */
describe('provider tooling markers (#625)', () => {
  it("renders Codex's own sourced distinctive tool names into its provider criteria — issue #625's own reported case", () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'codex' })],
      capabilities: MODEL_CAPABILITIES
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    const what = result.request.providerCriteria.codex!.what
    for (const name of distinctiveToolingNames('codex', 'toolNames')) {
      expect(what).toContain(name)
    }
    expect(what).toContain('request_user_input')
  })

  it("renders Claude Code's own sourced distinctive AskUserQuestion tool into its provider criteria", () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'claude' })],
      capabilities: MODEL_CAPABILITIES
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.providerCriteria.claude!.what).toContain('AskUserQuestion')
  })

  it("renders OpenCode's own sourced distinctive question tool into its provider criteria", () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'opencode' })],
      capabilities: {
        ...MODEL_CAPABILITIES,
        opencode: { 'opencode/free-fast': capabilityEntry({ tier: 'fast-cheap' }) }
      }
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.providerCriteria.opencode!.what).toContain('question')
  })

  it('never lets a marker distinctive to one provider leak into another launchable provider’s criteria', () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [
        provider({ provider: 'claude' }),
        provider({ provider: 'codex' }),
        provider({ provider: 'antigravity' }),
        provider({ provider: 'opencode' })
      ],
      capabilities: {
        ...MODEL_CAPABILITIES,
        opencode: { 'opencode/free-fast': capabilityEntry({ tier: 'fast-cheap' }) }
      }
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    for (const owner of DWARF_PROVIDERS) {
      const distinctive = distinctiveToolingNames(owner, 'toolNames')
      for (const otherProvider of DWARF_PROVIDERS) {
        if (otherProvider === owner) continue
        const otherWhat = result.request.providerCriteria[otherProvider]?.what
        if (!otherWhat) continue
        for (const name of distinctive) {
          expect(
            otherWhat,
            `${owner}'s own distinctive tool "${name}" leaked into ${otherProvider}'s criteria`
          ).not.toContain(name)
        }
      }
    }
  })

  it('marks apply_patch as shared rather than exclusive — it is sourced for both Codex and OpenCode', () => {
    expect(distinctiveToolingNames('codex', 'toolNames')).not.toContain('apply_patch')
    expect(distinctiveToolingNames('opencode', 'toolNames')).not.toContain('apply_patch')
    expect(PROVIDER_TOOLING_MARKERS.codex?.toolNames).toContain('apply_patch')
    expect(PROVIDER_TOOLING_MARKERS.opencode?.toolNames).toContain('apply_patch')
  })

  it('leaves Antigravity’s criteria unchanged — no verified tooling markers yet', () => {
    const result = buildJevRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      providers: [provider({ provider: 'antigravity' })],
      capabilities: MODEL_CAPABILITIES
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    const what = result.request.providerCriteria.antigravity!.what
    expect(what).toContain('Antigravity CLI')
    expect(what).not.toContain('`')
  })

  it('still fits the request token budget with every launchable provider offered at once', () => {
    const result = buildJevRouteRequest({
      prompt: 'a short prompt',
      routingProfile: 'balanced',
      providers: DWARF_PROVIDERS.map((p) => provider({ provider: p })),
      capabilities: {
        ...MODEL_CAPABILITIES,
        opencode: { 'opencode/free-fast': capabilityEntry({ tier: 'fast-cheap' }) }
      }
    })

    expect(result.kind).toBe('request')
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

  /*
   * AMENDED for #534 (was: passing `PROVIDER_EFFORT_LEVELS` unmodified,
   * relying on OpenCode's own entry being `[]` — #534 gave it a real,
   * non-empty boundary list). A synthetic table with one provider forced
   * empty, since every real DWARF_PROVIDERS member now has a ladder.
   */
  it('returns undefined for a provider with an empty effort ladder, at every score', () => {
    const noEffort = { ...PROVIDER_EFFORT_LEVELS, opencode: [] }
    expect(mapEffortScore('opencode', 0, noEffort)).toBeUndefined()
    expect(mapEffortScore('opencode', 1.5, noEffort)).toBeUndefined()
    expect(mapEffortScore('opencode', 3, noEffort)).toBeUndefined()
  })
})

describe('EFFORT_RUBRIC', () => {
  it('has exactly the four task-difficulty levels, trivial to architectural', () => {
    expect(EFFORT_RUBRIC).toHaveLength(4)
  })
})

/*
 * #608's second request: one Noul per candidate model plus one Choice over
 * the same candidates, keyed by INDEX — never a model's own id, name or
 * family. `buildJevModelRouteRequest` is only ever called by `routeLaunch.ts`
 * with two or more candidates (0 or 1 skip the second request entirely
 * before this function is reached — see routeLaunch.test.ts); the token
 * budget below is still real, since unlike the five fixed questions in
 * `buildJevRouteRequest`, this one scales with the candidate count.
 */
describe('candidateCapabilityFacts', () => {
  const entry = capabilityEntry({
    tier: 'frontier',
    what: 'A reasoning model for hard, multi-file work.',
    notFor: 'A trivial prompt.',
    examples: ['Design the data model.', 'Untangle the deadlock.'],
    relativeCost: 'high',
    contextWindowTokens: 200_000
  })

  it('carries what/notFor/examples plus tier, relativeCost and contextWindowTokens — never the model id', () => {
    const facts = candidateCapabilityFacts(entry)

    expect(facts).toEqual({
      what: entry.what,
      not_for: entry.notFor,
      examples: entry.examples,
      tier: 'frontier',
      relativeCost: 'high',
      contextWindowTokens: 200_000
    })
  })

  it('omits contextWindowTokens when the entry never verified one', () => {
    const noContext = capabilityEntry({ tier: 'balanced' })
    expect(candidateCapabilityFacts(noContext)).not.toHaveProperty('contextWindowTokens')
  })
})

describe('modelChoiceInstructions / modelFitInstructions', () => {
  it('name the tier the task needs, and never a model id', () => {
    const choice = modelChoiceInstructions('frontier')
    expect(choice.question).toContain('frontier')

    const facts = candidateCapabilityFacts(capabilityEntry({ tier: 'frontier' }))
    const fit = modelFitInstructions('frontier', facts)
    expect(fit.question).toContain('frontier')
    expect(fit.candidate).toBe(facts)
    expect(JSON.stringify(fit)).not.toContain('sonnet')
    expect(JSON.stringify(fit)).not.toContain('gpt-5')
  })
})

describe('buildJevModelRouteRequest', () => {
  function candidate(
    id: string,
    overrides: Partial<ModelCapabilityEntry> = {}
  ): {
    id: string
    entry: ModelCapabilityEntry
  } {
    return { id, entry: capabilityEntry({ tier: 'balanced', ...overrides }) }
  }

  it('keys every candidate by index — never by its own model id — in both the fits and the choice questions', () => {
    const result = buildJevModelRouteRequest({
      prompt: 'add a field to this form',
      routingProfile: 'balanced',
      tier: 'balanced',
      candidates: [candidate('sonnet'), candidate('gpt-5.6-sol')]
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(Object.keys(result.request.candidates)).toEqual(['0', '1'])
    expect(JSON.stringify(result.request)).not.toContain('sonnet')
    expect(JSON.stringify(result.request)).not.toContain('gpt-5.6-sol')
  })

  it('carries the tier the task needs, for the fit question to read from', () => {
    const result = buildJevModelRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      tier: 'frontier',
      candidates: [candidate('a'), candidate('b')]
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.tier).toBe('frontier')
  })

  it('truncates the prompt head+tail the same way request 1 does, when it does not fit the budget', () => {
    const long = 'x'.repeat(200_000)
    const result = buildJevModelRouteRequest({
      prompt: long,
      routingProfile: 'balanced',
      tier: 'balanced',
      candidates: [candidate('a'), candidate('b')]
    })

    if (result.kind !== 'request') throw new Error('expected a request')
    expect(result.request.truncated).toBe(true)
    expect(result.request.prompt.length).toBeLessThan(long.length)
    expect(result.request.prompt).toContain('\n…\n')
  })

  it('skips with budget-exceeded when even a trimmed prompt cannot fit alongside every candidate', () => {
    // Each candidate's own capability text counts toward the same 32k
    // state-plus-longest-question ceiling `buildJevRouteRequest` reads —
    // enough candidates with a long `what`/`notFor` makes the longest
    // single question (the Choice, holding every candidate's own criteria)
    // alone exceed it.
    const hugeWhat = 'w'.repeat(40_000)
    const manyCandidates = Array.from({ length: 20 }, (_, i) =>
      candidate(`id-${i}`, { what: hugeWhat })
    )
    const result = buildJevModelRouteRequest({
      prompt: 'anything',
      routingProfile: 'balanced',
      tier: 'balanced',
      candidates: manyCandidates
    })

    expect(result).toEqual({ kind: 'skip', reason: 'budget-exceeded' })
  })

  /*
   * Verifier fix (#608): the 64k combined ceiling covers `state` PLUS every
   * question (models.md: "The 64k budget covers the state plus all
   * questions combined") — the check used to sum only question tokens,
   * never the prompt. Many small candidates keep every single question,
   * and their SUM, comfortably under both the 32k-per-question and the old
   * 64k-questions-only ceilings — proven by the SAME candidate set fitting
   * with a short prompt — but a long prompt (truncated to the still-large
   * remaining state budget) tips the COMBINED total over 64k.
   */
  it('adds the (truncated) state tokens to the 64k combined ceiling — questions alone fit, combined with a large prompt they do not', () => {
    const smallCandidates = Array.from({ length: 800 }, (_, i) =>
      candidate(`id-${i}`, { what: 'w', notFor: 'n', examples: ['a', 'b'] })
    )

    const withShortPrompt = buildJevModelRouteRequest({
      prompt: 'a short prompt',
      routingProfile: 'balanced',
      tier: 'balanced',
      candidates: smallCandidates
    })
    // Proves the questions alone (state ~= 0) fit under every ceiling —
    // the failure below is not just "too many candidates" on its own.
    expect(withShortPrompt.kind).toBe('request')

    const withLongPrompt = buildJevModelRouteRequest({
      prompt: 'x'.repeat(200_000),
      routingProfile: 'balanced',
      tier: 'balanced',
      candidates: smallCandidates
    })

    expect(withLongPrompt).toEqual({ kind: 'skip', reason: 'budget-exceeded' })
  })
})

/*
 * Verifier fix (#608), direct against the shared helper — see
 * `truncateAndCheckBudget`'s own comment in routeRequest.ts for why
 * `buildJevRouteRequest` gets its coverage here rather than end to end: its
 * five questions are bounded by fixed constants and the closed
 * `DwarfProvider` union, so no realistic input can push `allQuestionsTokens`
 * anywhere near 64k — `buildJevModelRouteRequest`'s own many-candidate test
 * above already proves the SAME fix end to end where it IS reachable.
 */
describe('truncateAndCheckBudget', () => {
  it('adds the post-truncation state tokens into the combined 64k check — questions alone fit, combined with a large prompt they do not', () => {
    // allQuestionsTokens (50,000) is comfortably under 64,000 alone;
    // longestQuestionTokens (100) leaves a ~31,900-token state budget, and a
    // prompt long enough to fill it tips the combined total to ~81,900.
    const result = truncateAndCheckBudget('x'.repeat(500_000), 100, 50_000)
    expect(result).toEqual({ kind: 'over-budget' })
  })

  it('fits when state plus every question stays under the combined 64k ceiling', () => {
    const result = truncateAndCheckBudget('a short prompt', 100, 50_000)
    expect(result.kind).toBe('fits')
  })

  it('still truncates the prompt to the 32k state-plus-longest-question ceiling first, unchanged', () => {
    const result = truncateAndCheckBudget('x'.repeat(500_000), 100, 100)
    if (result.kind !== 'fits') throw new Error('expected it to fit the 64k combined ceiling')
    expect(result.truncated).toBe(true)
    expect(result.prompt.length).toBeLessThan(500_000)
  })
})
