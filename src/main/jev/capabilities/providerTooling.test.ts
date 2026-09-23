import { describe, expect, it } from 'vitest'
import { DWARF_PROVIDERS, type DwarfProvider } from '../../domain/types'
import { PROVIDER_TOOLING_MARKERS } from './providerTooling'

/**
 * The exhaustiveness/evidence suite for #625's own tooling-marker table —
 * the provider-level sibling of `capabilities.test.ts`'s model-level one.
 * Every entry this table DOES carry must be sourced and dated, the same
 * evidence rule `ModelCapabilityEntry` already holds every model id to
 * (jev-capabilities skill). A provider this table has NO evidence for yet
 * (Antigravity, `providerTooling.ts`'s own top comment says why) is honestly
 * absent rather than filled with an invented entry — this suite pins that
 * absence too, so a future entry added without evidence is at least a
 * deliberate edit to this test, not a silent gap-filler.
 */

describe('PROVIDER_TOOLING_MARKERS — the evidence rule', () => {
  const entries = Object.entries(PROVIDER_TOOLING_MARKERS) as ReadonlyArray<
    [DwarfProvider, (typeof PROVIDER_TOOLING_MARKERS)[DwarfProvider]]
  >

  it('has at least one entry, and never for every provider this app knows about (Antigravity has none yet)', () => {
    expect(entries.length).toBeGreaterThan(0)
    expect(PROVIDER_TOOLING_MARKERS.antigravity).toBeUndefined()
  })

  it('gives every entry at least one tool name, at least one source and a verifiedOn date', () => {
    for (const [provider, markers] of entries) {
      if (!markers) continue
      expect(markers.toolNames.length, `${provider} has no tool names`).toBeGreaterThan(0)
      expect(markers.sources.length, `${provider} has no sources`).toBeGreaterThan(0)
      expect(markers.verifiedOn, `${provider} has no verifiedOn`).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('never leaves an instruction file or tool name as an empty string', () => {
    for (const [provider, markers] of entries) {
      if (!markers) continue
      for (const name of [...markers.toolNames, ...markers.instructionFiles]) {
        expect(name, `${provider} has a blank marker name`).not.toBe('')
      }
    }
  })

  it('only ever keys a provider DWARF_PROVIDERS actually lists', () => {
    for (const provider of Object.keys(PROVIDER_TOOLING_MARKERS)) {
      expect(DWARF_PROVIDERS as readonly string[]).toContain(provider)
    }
  })

  it("names Claude Code's own distinctive AskUserQuestion tool, sourced to its own docs", () => {
    const claude = PROVIDER_TOOLING_MARKERS.claude
    if (!claude) throw new Error('expected a claude entry')
    expect(claude.toolNames).toContain('AskUserQuestion')
    expect(claude.instructionFiles).toContain('CLAUDE.md')
  })

  it("names Codex's own distinctive request_user_input tool — issue #625's own reported case", () => {
    const codex = PROVIDER_TOOLING_MARKERS.codex
    if (!codex) throw new Error('expected a codex entry')
    expect(codex.toolNames).toContain('request_user_input')
  })

  it("names OpenCode's own distinctive question tool, sourced to its own open-source registry", () => {
    const opencode = PROVIDER_TOOLING_MARKERS.opencode
    if (!opencode) throw new Error('expected an opencode entry')
    expect(opencode.toolNames).toContain('question')
  })
})
