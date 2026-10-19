// layer: L7
// L7 (17 §1.7): R6 (05 §5.1; ADR-004 P4) for the mines module wired by ISSUE-093. The adapters of
// mines are built only by the composition root (`host/main.ts`) and `host/wiring/**`; the module
// itself reaches its own adapters (its index.ts and its tests). Every TypeScript file of `src/` is
// read and each import specifier resolved against it, so a file anywhere else that names a mines
// adapter fails here, besides the depcruise rule `R6-adapters-only-from-roots` and its canary.
//
// TC-093-03.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const MINES_ADAPTERS = 'host/modules/mines/adapters/'
const ALLOWED = [/^host\/main\.ts$/, /^host\/wiring\//, /^host\/modules\/mines\//]

/** Every `.ts` file under `dir`, as a `src/`-relative path with forward slashes. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(path)
    return entry.name.endsWith('.ts') ? [relative(SRC, path).split(sep).join('/')] : []
  })
}

/** The relative import specifiers of `file`, resolved to `src/`-relative paths. */
function importsOf(file: string): string[] {
  const text = readFileSync(join(SRC, file), 'utf8')
  const specifiers = [
    ...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g)
  ]
    .map((match) => match[1] ?? match[2] ?? '')
    .filter((specifier) => specifier.startsWith('.'))
  return specifiers.map((specifier) =>
    relative(SRC, resolve(SRC, dirname(file), specifier))
      .split(sep)
      .join('/')
  )
}

describe('mines adapter imports (05 R6)', () => {
  it('[R6] no module outside main.ts and wiring imports a mines adapter', () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !ALLOWED.some((allowed) => allowed.test(file)))
      .flatMap((file) =>
        importsOf(file)
          .filter((target) => target.startsWith(MINES_ADAPTERS))
          .map((target) => `${file} -> ${target}`)
      )

    expect(offenders).toEqual([])
    // The scan is not vacuous: the composition root's import is found by the same reading.
    expect(importsOf('host/main.ts').some((target) => target.startsWith(MINES_ADAPTERS))).toBe(true)
  })
})
