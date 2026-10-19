// layer: L2
// The `InstalledToolsReader` bridge (16 §4.12; AMENDMENT-10; 05 §4, the EPIC-09 → EPIC-13 edge): the
// first-run step's `offered` comes from the suppliers installed detection of the Claude Code and
// OpenCode catalog entries (ADR-009 D5; 07 machine 41 "Only installed tools are offered"), read from
// the detection's cache through `SupplierCatalogueQueries.entry`, never by a new scan.
import { describe, expect, it } from 'vitest'
import type { SupplierCatalogueQueries, SupplierEntry } from '../../modules/suppliers'
import { suppliersInstalledTools } from './installedTools'

/** A catalogue whose `entry` answers `installed` for the listed providers; nothing else is read. */
function catalogue(installed: readonly string[]): Pick<SupplierCatalogueQueries, 'entry'> & {
  asked: string[]
} {
  const asked: string[] = []
  return {
    asked,
    entry: (id) => {
      asked.push(id)
      return { providerId: id, installed: installed.includes(id) } as SupplierEntry
    }
  }
}

describe('InstalledToolsReader bridge (suppliers → preferences)', () => {
  it('[US-SET-012.AC07, ADR-016] installed lists the integration of each installed tool: Claude Code for claude-hooks, OpenCode for opencode-permissions', () => {
    expect(suppliersInstalledTools(() => catalogue([])).installed()).toStrictEqual([])
    expect(suppliersInstalledTools(() => catalogue(['claude'])).installed()).toStrictEqual([
      'claude-hooks'
    ])
    expect(suppliersInstalledTools(() => catalogue(['opencode'])).installed()).toStrictEqual([
      'opencode-permissions'
    ])
    expect(
      suppliersInstalledTools(() => catalogue(['codex', 'opencode', 'claude'])).installed()
    ).toStrictEqual(['claude-hooks', 'opencode-permissions'])
  })

  it('[US-SET-012.AC08, S41.09] before suppliers are wired, or with no catalog entry, nothing counts as installed; once wired the same reader sees them', () => {
    let wired: Pick<SupplierCatalogueQueries, 'entry'> | null = null
    const reader = suppliersInstalledTools(() => wired)
    expect(reader.installed()).toStrictEqual([])
    wired = catalogue(['claude'])
    expect(reader.installed()).toStrictEqual(['claude-hooks'])
    const none: Pick<SupplierCatalogueQueries, 'entry'> = { entry: () => null }
    expect(suppliersInstalledTools(() => none).installed()).toStrictEqual([])
  })
})
