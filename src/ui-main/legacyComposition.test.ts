// layer: L7
import { readdirSync, readFileSync } from 'node:fs'
import { posix, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The legacy runtime is composed nowhere (21 §2 cut 5; 21 §3 row `LegacyRuntimeRoute`, cuts 0–5; ADR-001 item 4 step
 * 5; ISSUE-243). Read as text, since the tree under test must not import legacy code to prove it (05 R16): the UI-main
 * composition root composes no `LegacyRuntimeRoute`, the router it builds is handed no `legacy` target, and no file
 * of `src` imports today's runtime (`src/main/runtime/runtime.ts`) or today's Electron entry (`src/main/index.ts`).
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

/** Today's runtime and today's Electron entry, as paths relative to src without their extension. */
const TODAYS_RUNTIME: readonly string[] = ['main/runtime/runtime', 'main/index']

/** Every module `path` imports by a relative specifier (static, dynamic or re-export), resolved against src. */
function relativeImportsOf(path: string): string[] {
  const specifiers = [
    ...read(path).matchAll(/(?:\bfrom|\bimport\(?)\s*['"](\.{1,2}\/[^'"]*)['"]/g)
  ].map((match) => match[1] as string)
  return specifiers.map((specifier) =>
    posix.join(posix.dirname(path), specifier).replace(/\.(ts|mjs|js)$/, '')
  )
}

/** A static or dynamic import of a module by any relative path, `.ts` or not. */
const importOf = (module: string): RegExp =>
  new RegExp(String.raw`(\bfrom|\bimport\(?)\s*['"][^'"]*\/${module}(\.ts)?['"]`)

/** The router the root builds: the object handed to `createRouter`, up to its `.register(` call. */
function routerComposition(root: string): string {
  const start = root.indexOf('createRouter({')
  expect(start, 'the root builds the router').toBeGreaterThan(-1)
  const end = root.indexOf('}).register(', start)
  expect(end, 'the root registers the router').toBeGreaterThan(start)
  // Its code only: a comment may name what the router was handed before.
  return root
    .slice(start, end)
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n')
}

describe('legacy runtime composition (21 §2 cut 5)', () => {
  it('[ADR-001] the ui-main composition root composes no LegacyRuntimeRoute and the router has no legacy dispatch', () => {
    const root = read('ui-main/index.ts')
    expect(root).not.toMatch(importOf('LegacyRuntimeRoute'))
    expect(root).not.toMatch(/\b(createLegacyRuntimeRoute|composeLegacyRuntime)\b/)
    // The router is handed the window module and the HostClient only: a `legacy` route has no target to reach.
    expect(routerComposition(root)).not.toMatch(/\blegacy\s*[:,]/)
    // The router itself imports no door to today's runtime.
    expect(read('ui-main/ipc/router.ts')).not.toMatch(
      /(\bfrom|\bimport\(?)\s*['"][^'"]*legacy-bridge\//
    )
  })

  it('[ADR-001] no file in src imports src/main/runtime/runtime.ts or src/main/index.ts', () => {
    const importers = filesUnder(SRC)
      .filter(isSource)
      .flatMap((path) =>
        relativeImportsOf(path)
          .filter((target) => TODAYS_RUNTIME.includes(target))
          .map((target) => `${path} → ${target}`)
      )
    expect(importers).toEqual([])
  })
})
