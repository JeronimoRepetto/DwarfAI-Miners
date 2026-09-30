import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * L7 exception ratchet (ADR-004 item 3, 17 §1.7, 25 §3.3).
 *
 * An exception to a boundary rule is an inline, reviewed `// arch-exception: <ADR id> <reason>`;
 * their count under `src/**` may only go down. The found tree's renderer and preload still break
 * some boundary rules until the strangler rebuilds them (21 §6 renderer rows); those violations are
 * frozen in ESLint's bulk-suppressions file, which ESLint itself keeps shrink-only (a suppression
 * that no longer occurs fails `eslint`), and whose total this ratchet caps as well.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const baseline = JSON.parse(readFileSync(path.join(here, 'arch-exception.baseline.json'), 'utf8'))

const SOURCE_FILE = /\.(ts|mts|cts|mjs|cjs|js|vue)$/
const EXCEPTION = /\/\/\s*arch-exception:/g

/** The boundary rules of 05 §5.3 a suppression may name. */
const BOUNDARY_RULES = [
  'no-restricted-imports',
  'no-restricted-syntax',
  'arch/legacy-only-through-bridge',
  'vue/no-v-html',
  '@typescript-eslint/consistent-type-imports'
]
/** The found-tree areas the strangler rebuilds in place (21 §6); new trees get no suppression. */
const FOUND_TREE_AREAS = /^src\/(renderer|preload)\//

function sourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...sourceFiles(full))
    else if (SOURCE_FILE.test(entry.name)) files.push(full)
  }
  return files
}

describe('exception ratchet (ADR-004 item 3)', () => {
  it('[ADR-004] the count of arch-exception comments never exceeds the baseline', () => {
    const found = sourceFiles(path.join(repoRoot, 'src')).flatMap((file) => {
      const count = (readFileSync(file, 'utf8').match(EXCEPTION) ?? []).length
      return count === 0 ? [] : [`${path.relative(repoRoot, file)} (${count})`]
    })
    const total = found.reduce((sum, entry) => sum + Number(/\((\d+)\)$/.exec(entry)[1]), 0)
    expect(total, `arch-exception comments: ${found.join(', ') || 'none'}`).toBeLessThanOrEqual(
      baseline.count
    )
  })

  it('[ADR-004] the ESLint bulk suppressions never exceed the baseline and cover only found-tree renderer and preload files', () => {
    const suppressionsPath = path.join(repoRoot, 'eslint-suppressions.json')
    const suppressions = existsSync(suppressionsPath)
      ? JSON.parse(readFileSync(suppressionsPath, 'utf8'))
      : {}
    let total = 0
    for (const [file, rules] of Object.entries(suppressions)) {
      expect(file, 'a suppressed file').toMatch(FOUND_TREE_AREAS)
      for (const [rule, { count }] of Object.entries(rules)) {
        expect(BOUNDARY_RULES, `suppressed rule in ${file}`).toContain(rule)
        total += count
      }
    }
    expect(total, 'suppressed violations').toBeLessThanOrEqual(baseline.eslintSuppressions)
  })
})
