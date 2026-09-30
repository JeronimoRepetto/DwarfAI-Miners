import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * R9 (05 §5.1): `src/contracts/**` imports nothing outside itself except `zod`.
 *
 * Read as text rather than through the module graph, so the check needs no
 * bundler and holds before the dependency-cruiser rule exists. Only production
 * files are scanned: a test beside its subject may import `vitest` and Node
 * (this file does), which R9 leaves to the test side.
 */
const FOLDER = import.meta.dirname
const CONTRACTS_ROOT = resolve(FOLDER, '..')

/** Every module specifier a file names: static imports, re-exports, bare imports, `import()` and `require()`. */
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
]

function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .filter((entry) => !entry.name.endsWith('.test.ts'))
    .map((entry) => join(entry.parentPath, entry.name))
}

function specifiersOf(source: string): string[] {
  return SPECIFIER_PATTERNS.flatMap((pattern) =>
    [...source.matchAll(pattern)].map((match) => match[1] ?? '')
  )
}

function isAllowed(file: string, specifier: string): boolean {
  if (specifier === 'zod') return true
  if (!specifier.startsWith('.')) return false
  const target = resolve(dirname(file), specifier)
  return target === CONTRACTS_ROOT || target.startsWith(`${CONTRACTS_ROOT}${sep}`)
}

describe('contracts/config purity (R9)', () => {
  it('[R9] contracts/config imports nothing but zod and its own files', () => {
    const violations = productionFiles(FOLDER).flatMap((file) =>
      specifiersOf(readFileSync(file, 'utf8'))
        .filter((specifier) => !isAllowed(file, specifier))
        .map((specifier) => `${relative(FOLDER, file)} -> ${specifier}`)
    )
    expect(violations).toEqual([])
  })

  /*
   * The legacy parser defaulted its readers to `process.env`. That is the I/O
   * half ISSUE-010 leaves with the callers (the Host's FeatureFlagReader wiring,
   * ISSUE-211): the renderer may import contracts (R8) and has no `process`.
   */
  it('[R8] contracts/config reads no process global: every reader takes its environment as an argument', () => {
    const readers = productionFiles(FOLDER).filter((file) =>
      /\bprocess\s*[.[]/.test(
        readFileSync(file, 'utf8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
      )
    )
    expect(readers.map((file) => relative(FOLDER, file))).toEqual([])
  })
})
