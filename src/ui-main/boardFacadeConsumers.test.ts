// layer: L2
import { readdirSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The cut-5 entry criterion "`BoardFacadeAdapter` has no consumer, proven by a test" (21 §2 cut 5; 21 §3 row
 * `BoardFacadeAdapter`; ISSUE-242). Read as text over the whole of `src`: an import or a call is a consumer whether or
 * not the composition root still wires it, and the renderer never imports UI main (R10), so only its text can say
 * whether it still reads A-12 `getMines` or A-P2 `onMinesUpdated` (14 §2.1, RETIRE; successors A-N01/A-N02).
 */
const SRC = resolve(import.meta.dirname, '..')

/** Every file under a folder of src, as a path relative to src with forward slashes. */
function filesUnder(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(folder, entry.name)
    if (entry.isDirectory()) return filesUnder(path)
    return [
      path
        .slice(SRC.length + 1)
        .split('\\')
        .join('/')
    ]
  })
}

const isSource = (path: string): boolean => /\.(ts|vue|mjs)$/.test(path)
const read = (path: string): string => readFileSync(resolve(SRC, path), 'utf8')

/** A static or dynamic import of the adapter's module, by any relative path. */
const IMPORTS_THE_FACADE = /(\bfrom|\bimport\(?)\s*['"][^'"]*\/BoardFacadeAdapter(\.ts)?['"]/

/** A read of either member (`window.api.getMines()`, a destructured call) or a stand-in for it (`getMines: …`). */
const CALLS_A12_OR_AP2 = /(\.|\b)(getMines|onMinesUpdated)\s*[(:]|\.(getMines|onMinesUpdated)\b/

describe('BoardFacadeAdapter consumers (21 §2 cut 5 entry)', () => {
  it("[ADR-001, ADR-033] no file under src outside the adapter's own folder imports BoardFacadeAdapter", () => {
    const importers = filesUnder(SRC)
      .filter(isSource)
      .filter((path) => path !== 'ui-main/boardFacadeConsumers.test.ts')
      .filter((path) => IMPORTS_THE_FACADE.test(read(path)))
    expect(importers).toEqual([])
  })

  it('[ADR-033] no renderer file calls getMines or onMinesUpdated', () => {
    const callers = filesUnder(resolve(SRC, 'renderer'))
      .filter(isSource)
      .filter((path) => CALLS_A12_OR_AP2.test(read(path)))
    expect(callers).toEqual([])
  })
})
