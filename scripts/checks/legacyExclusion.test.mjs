// layer: L7
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * L7 check of the legacy exclusion after the cut-0 retirement (ISSUE-058; 21 §1 item 7, 17 §1.7 "Legacy window").
 *
 * The exclusion is the one pattern `^src/(main|shared)/`, so it shrinks by the files it covers rather than by an
 * entry: the retired window and tray modules leave the tree it names, and no entry of the list is new.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const RETIRED = ['src/main/shell/window.ts', 'src/main/shell/tray.ts']

function excludeList() {
  const config = createRequire(import.meta.url)(path.join(repoRoot, '.dependency-cruiser.cjs'))
  const exclude = config.options.exclude
  return (Array.isArray(exclude) ? exclude : [exclude]).map((entry) => entry.path)
}

describe('legacy exclusion after the cut-0 retirement', () => {
  it('[ADR-001] the depcruise legacy exclude list no longer names src/main/shell/window.ts or tray.ts and is no longer than at the cut-0 base', () => {
    const baseline = JSON.parse(
      readFileSync(path.join(here, 'legacy-exclude.baseline.json'), 'utf8')
    )
    const list = excludeList()
    expect(list.length).toBeLessThanOrEqual(baseline.length)
    for (const pattern of list) {
      expect(baseline, `exclude path ${pattern} is not in the baseline`).toContain(pattern)
      for (const retired of RETIRED) {
        expect(pattern, `the exclusion names ${retired}`).not.toContain(retired)
      }
    }
  })

  it('[ADR-001] the retired window and tray modules are gone from the tree the exclusion covers', () => {
    for (const retired of RETIRED) {
      expect(existsSync(path.join(repoRoot, retired)), retired).toBe(false)
    }
  })
})
