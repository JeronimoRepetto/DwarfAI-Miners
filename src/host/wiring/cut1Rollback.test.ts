// layer: L7
// L7 static (17 §1.7): the cut-1 rollback setting is read in the Host by host/wiring/cut1Rollback.ts alone (ISSUE-122;
// 05 §1.3, R9: inside the Host only `transport` and `wiring` import contracts, and of those only this file reads the
// setting), so the composition root and every route take the build's choice from one place.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const HOST = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Every production `.ts` file under `src/host`, tests and test-only folders excluded. */
function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = join(folder, entry.name)
    if (entry.isDirectory()) {
      return ['fakes', 'testing'].includes(entry.name) ? [] : productionFiles(path)
    }
    return entry.name.endsWith('.ts') && !/\.(test|contract|os\.test)\.ts$/.test(entry.name)
      ? [path]
      : []
  })
}

describe('the cut-1 rollback setting in the Host (ISSUE-122)', () => {
  it('[ADR-001] only host/wiring/cut1Rollback.ts reads the cut-1 rollback setting inside the Host', () => {
    const readers = productionFiles(HOST)
      .filter((path) => /CUT_1_ROLLBACK\b|contracts\/strangler/.test(readFileSync(path, 'utf8')))
      .map((path) => relative(HOST, path).split('\\').join('/'))
    expect(readers).toEqual(['wiring/cut1Rollback.ts'])
  })
})
