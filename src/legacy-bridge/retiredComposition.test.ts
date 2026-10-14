// layer: L7
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Today's observer composition that the cut-1 retirement removed from the bridges (ISSUE-124; 21 §2 cut 1 "Retired at
 * the end"): the poller and its publish gate, the durable ledger crediting (the vault store, its migration and the coal
 * backfill) and the projects-store board path (the projects observer). The files stay in the legacy tree until cut 5;
 * only their composition is gone. `MaterialLedger` over `nullLedgerStore()` and the projects store's reads stay: today's
 * runtime needs both to serve the rows still `legacy`, and neither writes anything.
 */
const RETIRED_MODULES: readonly string[] = [
  'main/runtime/poller',
  'main/runtime/publishGate',
  'main/ledger/openLedgerStore',
  'main/ledger/sqliteLedgerStore',
  'main/ledger/ledgerMigration',
  'main/ledger/coalBackfill',
  'main/ledger/coalScan',
  'main/projects/projectObserver'
]

const BRIDGES = resolve(import.meta.dirname)

/** Every production file under src/legacy-bridge (tests may still import a legacy module to prove a behaviour). */
function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) return productionFiles(path)
    return /\.ts$/.test(entry.name) && !/\.(test|contract)\.ts$/.test(entry.name) ? [path] : []
  })
}

describe('cut-1 retirement (21 §2 cut 1)', () => {
  it('[ADR-001] no file under src/legacy-bridge imports the retired legacy observer, ledger crediting or projects-store modules', () => {
    const files = productionFiles(BRIDGES)
    expect(files.length).toBeGreaterThan(0)
    const importers = files.flatMap((path) => {
      const source = readFileSync(path, 'utf8')
      return RETIRED_MODULES.filter((module) =>
        new RegExp(String.raw`from '(\.\./)+${module}'`).test(source)
      ).map(
        (module) =>
          `${path
            .slice(BRIDGES.length + 1)
            .split('\\')
            .join('/')} → ${module}`
      )
    })
    expect(importers).toEqual([])
  })
})
