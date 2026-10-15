import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FORBIDDEN_FLAGS } from './modules/suppliers/adapters/drivers/shared/forbiddenFlags'

/**
 * ADR-008 Verification and 17 §1.7 "Forbidden flags / paths / credential reads": no flag or option
 * of ADR-008 item 3 appears in src/host outside the guard's own list, its own test and the driver
 * conformance harness that asserts their absence. Read as text, comments included, in any case.
 * The exemptions are exact paths, never a folder.
 */
const HOST_ROOT = import.meta.dirname

const EXEMPT: readonly string[] = [
  'modules/suppliers/adapters/drivers/shared/forbiddenFlags.ts',
  'modules/suppliers/adapters/drivers/shared/forbiddenFlags.test.ts',
  'modules/suppliers/testing/driverConformance.ts',
  'modules/suppliers/testing/driverConformance.lineDriver.ts'
]

interface SourceFile {
  readonly path: string // relative to src/host, '/'-separated
  readonly text: string
}

function sourceFiles(folder: string): SourceFile[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|mts|cts|js|mjs|cjs|vue|json)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => ({
      path: relative(folder, file).split(sep).join('/'),
      text: readFileSync(file, 'utf8')
    }))
}

/** Each `<path>: <flag>` where a non-exempt file holds a forbidden literal, in any case. */
function forbiddenLiterals(files: readonly SourceFile[]): string[] {
  const found: string[] = []
  for (const file of files) {
    if (EXEMPT.includes(file.path)) continue
    const lower = file.text.toLowerCase()
    for (const flag of FORBIDDEN_FLAGS) {
      if (lower.includes(flag.toLowerCase())) found.push(`${file.path}: ${flag}`)
    }
  }
  return found
}

describe('forbidden flags absent from src/host (ADR-008 item 3)', () => {
  it('[C-24] no forbidden flag or option literal appears in src/host outside the forbidden-flags list itself', () => {
    const files = sourceFiles(HOST_ROOT)
    expect(files.length).toBeGreaterThan(0)
    expect(files.map((file) => file.path)).toContain(EXEMPT[0])
    expect(forbiddenLiterals(files)).toEqual([])
  })

  it('[C-24] the scan finds every forbidden literal in any case outside the exact exempt paths', () => {
    expect(FORBIDDEN_FLAGS.length).toBeGreaterThan(0)
    const planted = FORBIDDEN_FLAGS.map((flag, index) => ({
      path: `modules/planted/driver${index}.ts`,
      text: `const argv = ['exec', '${index % 2 === 0 ? flag : flag.toUpperCase()}']`
    }))
    expect(forbiddenLiterals(planted)).toEqual(
      FORBIDDEN_FLAGS.map((flag, index) => `modules/planted/driver${index}.ts: ${flag}`)
    )
    const exemptNeighbour = {
      path: 'modules/suppliers/testing/driverConformance.other.ts',
      text: FORBIDDEN_FLAGS.join(' ')
    }
    expect(forbiddenLiterals([exemptNeighbour])).toHaveLength(FORBIDDEN_FLAGS.length)
    expect(
      forbiddenLiterals(EXEMPT.map((path) => ({ path, text: FORBIDDEN_FLAGS.join(' ') })))
    ).toEqual([])
  })
})
