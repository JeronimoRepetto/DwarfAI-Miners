// The `InstalledToolsReader` bridge (16 §4.12; AMENDMENT-10, OQ-78; 05 §4, the EPIC-09 → EPIC-13
// edge of 22-roadmap.md): preferences reads which of Claude Code and OpenCode are installed through
// it, so preferences never imports suppliers (R4). Each integration belongs to the catalog entry of
// its tool (`claude-hooks` → Claude Code, `opencode-permissions` → OpenCode, 16 §4.12 row
// `InstalledToolsReader`); the entry's `installed` is the suppliers detection's last answer
// (`SupplierCatalogueQueries.entry`, synchronous), so the bridge reads the cache and never scans
// (ADR-009 D5). The boot waits for the start-up detection before the first-run evaluation reads
// it (suppliersWiring.ts `bootDetection`; 07 S41.09).
//
// Suppliers are wired by boot step 4, after preferences (step 3): until then the catalogue is null
// and nothing counts as installed, which is the fail-closed answer (no option is offered).
import type { IntegrationId, ProviderId } from '../../kernel/domain/values'
import type { InstalledToolsReader } from '../../modules/preferences'
import type { SupplierCatalogueQueries } from '../../modules/suppliers'

/** The catalog entry whose installed state stands for each integration's tool, in the step order. */
const TOOL_OF: ReadonlyArray<readonly [IntegrationId, ProviderId]> = [
  ['claude-hooks', 'claude'],
  ['opencode-permissions', 'opencode']
]

export function suppliersInstalledTools(
  catalogue: () => Pick<SupplierCatalogueQueries, 'entry'> | null
): InstalledToolsReader {
  return {
    installed: () => {
      const queries = catalogue()
      if (queries === null) return []
      return TOOL_OF.filter(([, tool]) => queries.entry(tool)?.installed === true).map(
        ([integration]) => integration
      )
    }
  }
}
