import { describe, expect, it } from 'vitest'
import {
  antigravityModelCatalog,
  claudeModelCatalog,
  codexModelCatalog
} from '../../domain/agentModelCatalog'
import type { AgentModelCatalog, DwarfProvider } from '../../domain/types'
import { lookupModelCapability, MODEL_CAPABILITIES } from './modelCapability'

/**
 * The exhaustiveness suite (#509 follow-up, jev-routing-profiles T1): every id
 * a real catalogue builder can hand back must resolve to a capability entry,
 * or T3's model_tier mapping would be asked to route an option this table
 * knows nothing about — silently as dangerous as the id typo this test is
 * built to catch.
 *
 * Fixtures run the same PURE builders `runtime.ts`'s `listAgentModels` calls
 * (`claudeModelCatalog`, `codexModelCatalog`, `antigravityModelCatalog` in
 * `agentModelCatalog.ts`), fed the ids this table claims to cover — never the
 * live IO ports (`ClaudeModelCatalogPort`, a real `agy models` spawn), which
 * no unit test may reach. A missing id therefore fails HERE, at the seam that
 * shapes the wire answer, rather than downstream where the failure would be a
 * silently unrouted model.
 */

const CLAUDE_FIXTURE_IDS = ['default', 'opus[1m]', 'claude-fable-5-1[1m]', 'sonnet', 'haiku']
const CODEX_FIXTURE_IDS = [
  'gpt-5.6-sol',
  'gpt-5.6-luna',
  'gpt-5.6-terra',
  'gpt-6-astra',
  'codex-auto-review',
  'gpt-5.5'
]
const ANTIGRAVITY_FIXTURE_IDS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.1-pro',
  'claude-sonnet-4.6-thinking',
  'claude-opus-4.6-thinking',
  'gpt-oss-120b',
  'nano-banana-2'
]

interface FixtureCatalog {
  provider: DwarfProvider
  file: string
  catalog: AgentModelCatalog
}

const FIXTURE_CATALOGS: readonly FixtureCatalog[] = [
  {
    provider: 'claude',
    file: 'src/main/jev/capabilities/claude.ts',
    catalog: claudeModelCatalog(
      CLAUDE_FIXTURE_IDS.map((value) => ({ value, displayName: value, supportsEffort: false }))
    )
  },
  {
    provider: 'codex',
    file: 'src/main/jev/capabilities/codex.ts',
    catalog: codexModelCatalog(CODEX_FIXTURE_IDS.map((model) => ({ model })))
  },
  {
    provider: 'antigravity',
    file: 'src/main/jev/capabilities/antigravity.ts',
    catalog: antigravityModelCatalog(
      ANTIGRAVITY_FIXTURE_IDS.map((value) => ({ value, displayName: value }))
    )
  }
]

describe('lookupModelCapability exhaustiveness', () => {
  for (const { provider, catalog, file } of FIXTURE_CATALOGS) {
    it(`covers every id ${provider}'s own catalogue builder can hand back`, () => {
      expect(catalog.models.length).toBeGreaterThan(0)
      for (const model of catalog.models) {
        const entry = lookupModelCapability(provider, model.value)
        expect(
          entry,
          `${provider}:${model.value} has no capability entry — add one to ${file}`
        ).not.toEqual({ kind: 'unknown' })
      }
    })
  }

  it('answers unknown for an id no provider ever named, without throwing', () => {
    expect(() => lookupModelCapability('claude', 'not-a-real-model')).not.toThrow()
    expect(lookupModelCapability('claude', 'not-a-real-model')).toEqual({ kind: 'unknown' })
  })

  it('marks the internal reviewer model as never a launch target', () => {
    const entry = lookupModelCapability('codex', 'codex-auto-review')
    if ('kind' in entry) throw new Error('codex-auto-review has no capability entry')
    expect(entry.launchTarget).toBe(false)
  })

  it('offers Haiku no effort levels at all, matching the boundary it takes none from', () => {
    const entry = lookupModelCapability('claude', 'haiku')
    if ('kind' in entry) throw new Error('haiku has no capability entry')
    expect(entry.effortLevels).toEqual([])
  })

  it('gives every entry at least one source and both criteria examples', () => {
    for (const [provider, providerEntries] of Object.entries(MODEL_CAPABILITIES)) {
      for (const [modelId, entry] of Object.entries(providerEntries)) {
        expect(entry.sources.length, `${provider}:${modelId} has no source`).toBeGreaterThan(0)
        expect(entry.examples, `${provider}:${modelId} needs two examples`).toHaveLength(2)
        expect(entry.examples[0]).not.toBe('')
        expect(entry.examples[1]).not.toBe('')
      }
    }
  })
})
