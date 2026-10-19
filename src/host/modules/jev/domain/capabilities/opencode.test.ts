import { describe, expect, it } from 'vitest'
import type { ModelCapabilityEntry } from './modelCapability'
import { OPENCODE_CAPABILITY_OVERLAY, mergeOpenCodeCapabilityTable } from './opencode'

/**
 * Issue #547. `opencode.ts` is the curated EXCEPTION list, in the same shape
 * `claude.ts`/`codex.ts`/`antigravity.ts` already use — most of OpenCode's
 * table is DERIVED at route time (`opencodeDerived.ts`); this file only
 * overrides a derived entry for an id a maintainer has hand-verified well
 * enough to replace the template with real prose. Empty today: see this
 * file's own top comment for why an empty table is the honest starting
 * point, not a gap.
 */

function entry(
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

describe('OPENCODE_CAPABILITY_OVERLAY', () => {
  it('starts empty — no id has been hand-verified yet', () => {
    expect(OPENCODE_CAPABILITY_OVERLAY).toEqual({})
  })
})

describe('mergeOpenCodeCapabilityTable', () => {
  it('keeps a derived-only id unchanged', () => {
    const derived = { 'opencode/only-derived': entry({ tier: 'balanced' }) }
    const merged = mergeOpenCodeCapabilityTable(derived, {})
    expect(merged['opencode/only-derived']).toBe(derived['opencode/only-derived'])
  })

  it('lets the curated overlay win over a derived entry for the same id', () => {
    const derived = { 'opencode/shared-id': entry({ tier: 'balanced', what: 'derived template' }) }
    const overlay = {
      'opencode/shared-id': entry({ tier: 'frontier', what: 'hand-verified prose' })
    }
    const merged = mergeOpenCodeCapabilityTable(derived, overlay)
    expect(merged['opencode/shared-id']).toBe(overlay['opencode/shared-id'])
    expect(merged['opencode/shared-id']!.tier).toBe('frontier')
  })

  it('adds an overlay-only id even when nothing derived named it', () => {
    const overlay = { 'opencode/overlay-only': entry({ tier: 'fast-cheap' }) }
    const merged = mergeOpenCodeCapabilityTable({}, overlay)
    expect(merged['opencode/overlay-only']).toBe(overlay['opencode/overlay-only'])
  })

  it('defaults the overlay argument to OPENCODE_CAPABILITY_OVERLAY when omitted', () => {
    const derived = { 'opencode/x': entry({ tier: 'balanced' }) }
    expect(mergeOpenCodeCapabilityTable(derived)).toEqual(derived)
  })
})
