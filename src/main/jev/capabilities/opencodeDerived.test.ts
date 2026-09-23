import { describe, expect, it } from 'vitest'
import { parseOpenCodeModelsOutput } from '../../providers/opencode/models'
import {
  OPENCODE_COST_BAND_THRESHOLDS,
  deriveOpenCodeCapabilities,
  opencodeCostBand,
  opencodeTier
} from './opencodeDerived'

/**
 * Issue #547. OpenCode's own capability table is DERIVED at route time from
 * `opencode models --verbose`'s live catalogue, never hand-maintained — see
 * this module's own top comment. The fixture below is in the REAL
 * `--verbose` shape (one bare `provider/model` id line, then a `{ ... }`
 * JSON block), built from four blocks actually observed on this machine on
 * 2026-09-21 (`opencode models --verbose`, 35 models) plus one synthetic
 * `inactive` block — no live catalogue observed one, so this is the one
 * block in this fixture that is NOT a literal capture.
 */
const VERIFIED_ON = '2026-09-21'

const FIXTURE_VERBOSE = [
  // Free, reasoning, cheapest band — real block (opencode/big-pickle).
  'opencode/big-pickle',
  '{',
  '  "id": "big-pickle",',
  '  "providerID": "opencode",',
  '  "name": "Big Pickle",',
  '  "status": "active",',
  '  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },',
  '  "limit": { "context": 200000, "output": 32000 },',
  '  "capabilities": { "reasoning": true },',
  '  "release_date": "2025-10-17",',
  '  "variants": {}',
  '}',
  // Paid, reasoning, most expensive band, ≥1M context — real block (the
  // issue's own worked example, opencode-go/kimi-k3).
  'opencode-go/kimi-k3',
  '{',
  '  "id": "kimi-k3",',
  '  "providerID": "opencode-go",',
  '  "name": "Kimi K3",',
  '  "status": "active",',
  '  "cost": { "input": 3, "output": 15, "cache": { "read": 0.3 } },',
  '  "limit": { "context": 1048576, "output": 131072 },',
  '  "capabilities": { "reasoning": true },',
  '  "release_date": "2026-07-16",',
  '  "variants": { "max": { "reasoningEffort": "max" } }',
  '}',
  // Paid, reasoning, mid band, small context, variant-less — real block
  // (opencode-go/glm-5.1).
  'opencode-go/glm-5.1',
  '{',
  '  "id": "glm-5.1",',
  '  "providerID": "opencode-go",',
  '  "name": "GLM 5.1",',
  '  "status": "active",',
  '  "cost": { "input": 1.4, "output": 4.4, "cache": { "read": 0.26 } },',
  '  "limit": { "context": 202752, "output": 32768 },',
  '  "capabilities": { "reasoning": true },',
  '  "release_date": "2026-04-07",',
  '  "variants": {}',
  '}',
  // Inactive — synthetic, never observed live (no inactive model exists on
  // this machine's own catalogue today); proves an inactive id gets no entry.
  'opencode/retired-model',
  '{',
  '  "id": "retired-model",',
  '  "providerID": "opencode",',
  '  "name": "Retired Model",',
  '  "status": "inactive",',
  '  "cost": { "input": 1, "output": 2 },',
  '  "limit": { "context": 100000, "output": 8000 },',
  '  "capabilities": { "reasoning": false },',
  '  "release_date": "2025-01-01",',
  '  "variants": {}',
  '}',
  ''
].join('\n')

const FIXTURE_MODELS = parseOpenCodeModelsOutput(FIXTURE_VERBOSE)

describe('opencodeCostBand — boundaries pinned exactly and just past each threshold', () => {
  it('bands a free model as low', () => {
    expect(opencodeCostBand(0)).toBe('low')
  })

  it('bands exactly at the low threshold as low', () => {
    expect(opencodeCostBand(OPENCODE_COST_BAND_THRESHOLDS.low)).toBe('low')
  })

  it('bands just past the low threshold as medium', () => {
    expect(opencodeCostBand(OPENCODE_COST_BAND_THRESHOLDS.low + 0.01)).toBe('medium')
  })

  it('bands exactly at the medium threshold as medium', () => {
    expect(opencodeCostBand(OPENCODE_COST_BAND_THRESHOLDS.medium)).toBe('medium')
  })

  it('bands just past the medium threshold as high', () => {
    expect(opencodeCostBand(OPENCODE_COST_BAND_THRESHOLDS.medium + 0.01)).toBe('high')
  })

  it('bands exactly at the high threshold as high', () => {
    expect(opencodeCostBand(OPENCODE_COST_BAND_THRESHOLDS.high)).toBe('high')
  })

  it('bands just past the high threshold as very-high', () => {
    expect(opencodeCostBand(OPENCODE_COST_BAND_THRESHOLDS.high + 0.01)).toBe('very-high')
  })
})

describe('opencodeTier — the written-once rule', () => {
  it('gives a free reasoning model fast-cheap, even with a large context window', () => {
    expect(
      opencodeTier({
        cost: { input: 0, output: 0 },
        limit: { context: 1_048_576, output: 1000 },
        capabilities: { reasoning: true }
      })
    ).toBe('fast-cheap')
  })

  it('gives a medium-cost NON-reasoning model with an ordinary window balanced', () => {
    // Pin (AMENDED for #547 review): the combination the verifier found
    // untested — neither cheap enough for fast-cheap nor reasoning at the top
    // band nor large enough for long-context, so the rule's last branch.
    expect(
      opencodeTier({
        cost: { input: 0.5, output: 1 },
        limit: { context: 200_000, output: 1000 },
        capabilities: { reasoning: false }
      })
    ).toBe('balanced')
  })

  it('gives a high-cost NON-reasoning model with a 1M window long-context, not frontier', () => {
    // Pin (AMENDED for #547 review): frontier needs reasoning at the TOP band;
    // a high-band non-reasoning model with a large window falls through to the
    // context branch instead.
    expect(
      opencodeTier({
        cost: { input: 1, output: 3 },
        limit: { context: 1_048_576, output: 1000 },
        capabilities: { reasoning: false }
      })
    ).toBe('long-context')
  })

  it('gives a very-high-cost reasoning model frontier', () => {
    expect(
      opencodeTier({
        cost: { input: 3, output: 15 },
        limit: { context: 1_048_576, output: 1000 },
        capabilities: { reasoning: true }
      })
    ).toBe('frontier')
  })

  it('does NOT give a very-high-cost NON-reasoning model frontier', () => {
    expect(
      opencodeTier({
        cost: { input: 3, output: 15 },
        limit: { context: 500_000, output: 1000 },
        capabilities: { reasoning: false }
      })
    ).toBe('balanced')
  })

  it('gives a mid-band model with a ≥1,000,000-token context long-context', () => {
    expect(
      opencodeTier({
        cost: { input: 0.66, output: 1.98 },
        limit: { context: 1_000_000, output: 1000 },
        capabilities: { reasoning: true }
      })
    ).toBe('long-context')
  })

  it('gives a mid-band model under 1,000,000 tokens balanced', () => {
    expect(
      opencodeTier({
        cost: { input: 1.4, output: 4.4 },
        limit: { context: 202_752, output: 1000 },
        capabilities: { reasoning: true }
      })
    ).toBe('balanced')
  })
})

describe('deriveOpenCodeCapabilities', () => {
  const derived = deriveOpenCodeCapabilities(FIXTURE_MODELS, VERIFIED_ON)

  it('produces one entry per ACTIVE model, keyed by the exact provider/model id', () => {
    expect(Object.keys(derived).sort()).toEqual(
      ['opencode-go/glm-5.1', 'opencode-go/kimi-k3', 'opencode/big-pickle'].sort()
    )
  })

  it('gives an inactive id no entry at all', () => {
    expect(derived['opencode/retired-model']).toBeUndefined()
  })

  it('marks every derived entry a launch target', () => {
    for (const entry of Object.values(derived)) {
      expect(entry.launchTarget).toBe(true)
    }
  })

  it('carries contextWindowTokens straight from limit.context', () => {
    expect(derived['opencode-go/kimi-k3']!.contextWindowTokens).toBe(1_048_576)
  })

  it('carries effortLevels from the variant keys, or [] when none', () => {
    expect(derived['opencode-go/kimi-k3']!.effortLevels).toEqual(['max'])
    expect(derived['opencode-go/glm-5.1']!.effortLevels).toEqual([])
  })

  it('bands relativeCost from cost.output', () => {
    expect(derived['opencode/big-pickle']!.relativeCost).toBe('low')
    expect(derived['opencode-go/glm-5.1']!.relativeCost).toBe('high')
    expect(derived['opencode-go/kimi-k3']!.relativeCost).toBe('very-high')
  })

  it('assigns tier from the written-once rule', () => {
    expect(derived['opencode/big-pickle']!.tier).toBe('fast-cheap')
    expect(derived['opencode-go/kimi-k3']!.tier).toBe('frontier')
    expect(derived['opencode-go/glm-5.1']!.tier).toBe('balanced')
  })

  it('cites the catalogue command and models.dev as sources, dated at the read', () => {
    for (const entry of Object.values(derived)) {
      expect(entry.sources).toContain('installed CLI: opencode models --verbose')
      expect(entry.sources).toContain('https://models.dev')
      expect(entry.verifiedOn).toBe(VERIFIED_ON)
    }
  })

  it('templates what/notFor/examples from the facts alone, never the model id or display name', () => {
    for (const [id, entry] of Object.entries(derived)) {
      expect(entry.what).not.toContain(id)
      expect(entry.examples).toHaveLength(2)
      expect(entry.examples[0]).not.toBe('')
      expect(entry.examples[1]).not.toBe('')
      expect(entry.notFor).not.toBe('')
    }
  })

  it('states the reasoning fact and the context window in what', () => {
    expect(derived['opencode-go/kimi-k3']!.what).toContain('reasoning')
    expect(derived['opencode-go/kimi-k3']!.what).toContain('1,048,576')
  })

  it('returns an empty table for an empty catalogue, never throwing', () => {
    expect(deriveOpenCodeCapabilities([], VERIFIED_ON)).toEqual({})
  })

  it('states cached-input pricing in `what` when the catalogue provides one, and omits it when free', () => {
    // kimi-k3's own block above carries "cache": { "read": 0.3 } — glm-5.1
    // carries "cache": { "read": 0.26 }; big-pickle is free, so its "no
    // per-token cost" branch never reaches the cache clause at all.
    expect(derived['opencode-go/kimi-k3']!.what).toContain('cached input')
    expect(derived['opencode-go/glm-5.1']!.what).toContain('cached input')
    expect(derived['opencode/big-pickle']!.what).not.toContain('cached input')
  })
})

/*
 * #608 T1. Precondition (issue's own words): "Two models in the same tier
 * are near-identical text... and differ only in cost and context numbers."
 * TWIN_VERBOSE below is built to PROVE that precondition first — twin-a and
 * twin-b share reasoning, cost.input, cost.output and limit.context exactly,
 * so the OLD `templatedWhat` (reasoning + context + cost only) and the
 * tier-keyed `notFor`/`examples` would have produced byte-identical text for
 * both. Only `limit.output` and `variants` (→ effortLevels) differ — the two
 * facts this task adds to the template specifically so a pair like this
 * stops being indistinguishable to Jev's second request (the Noul-per-
 * candidate ask #608 adds elsewhere).
 */
const TWIN_VERBOSE = [
  'opencode/twin-a',
  '{',
  '  "id": "twin-a",',
  '  "providerID": "opencode",',
  '  "name": "Twin A",',
  '  "status": "active",',
  '  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },',
  '  "limit": { "context": 200000, "output": 8192 },',
  '  "capabilities": { "reasoning": true },',
  '  "release_date": "2026-01-01",',
  '  "variants": {}',
  '}',
  'opencode/twin-b',
  '{',
  '  "id": "twin-b",',
  '  "providerID": "opencode",',
  '  "name": "Twin B",',
  '  "status": "active",',
  '  "cost": { "input": 0, "output": 0, "cache": { "read": 0, "write": 0 } },',
  '  "limit": { "context": 200000, "output": 32000 },',
  '  "capabilities": { "reasoning": true },',
  '  "release_date": "2026-02-01",',
  '  "variants": { "low": {}, "high": {}, "max": {} }',
  '}',
  ''
].join('\n')

const TWIN_MODELS = parseOpenCodeModelsOutput(TWIN_VERBOSE)

describe('deriveOpenCodeCapabilities — per-model differentiation within one tier (#608 T1)', () => {
  const twinDerived = deriveOpenCodeCapabilities(TWIN_MODELS, VERIFIED_ON)

  it('lands both twins in the same tier — the precondition the differentiation has to survive', () => {
    expect(twinDerived['opencode/twin-a']!.tier).toBe('fast-cheap')
    expect(twinDerived['opencode/twin-b']!.tier).toBe('fast-cheap')
  })

  it('gives same-tier twins that differ only in output cap and effort ladder different `what` text', () => {
    expect(twinDerived['opencode/twin-a']!.what).not.toBe(twinDerived['opencode/twin-b']!.what)
  })

  it("states each twin's own output ceiling in `what`, traceable to limit.output", () => {
    expect(twinDerived['opencode/twin-a']!.what).toContain('8,192')
    expect(twinDerived['opencode/twin-b']!.what).toContain('32,000')
  })

  it("states each twin's own effort ladder in `what`, traceable to its variants keys", () => {
    expect(twinDerived['opencode/twin-a']!.what).toMatch(/no ladder|single fixed effort level/)
    expect(twinDerived['opencode/twin-b']!.what).toContain('low/high/max')
  })

  it('carries the output ceiling into `notFor` too, so same-tier twins differ there as well', () => {
    expect(twinDerived['opencode/twin-a']!.notFor).not.toBe(twinDerived['opencode/twin-b']!.notFor)
    expect(twinDerived['opencode/twin-a']!.notFor).toContain('8,192')
    expect(twinDerived['opencode/twin-b']!.notFor).toContain('32,000')
  })

  it('still shares the tier-keyed base sentence in `notFor` — the tier rule itself is unchanged', () => {
    const sharedSentence = 'sustained reasoning across several files'
    expect(twinDerived['opencode/twin-a']!.notFor).toContain(sharedSentence)
    expect(twinDerived['opencode/twin-b']!.notFor).toContain(sharedSentence)
  })

  it('keeps `examples` tier-generic and therefore identical for the twins — no invented per-model prompts', () => {
    expect(twinDerived['opencode/twin-a']!.examples).toEqual(
      twinDerived['opencode/twin-b']!.examples
    )
  })

  it("never puts a twin's own id, name or family fragment in its `what` text", () => {
    for (const [id, entry] of Object.entries(twinDerived)) {
      expect(entry.what).not.toContain(id)
      expect(entry.what.toLowerCase()).not.toContain('twin')
    }
  })
})
