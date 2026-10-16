// layer: L7
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/*
 * The renderer's measured baseline (21 §6 rows "Renderer `lib/**`, `components/**`" and "Golden tooling"; ISSUE-250):
 * the transplanted renderer tests reach `window.api` only through the fake generated from the channel registry
 * (ADR-033 item 7), so a test can never fake a member the preload does not have, and every renderer `lib/**` file
 * keeps its pure tests, or the loss is justified in docs/test-removals.md (17 §2.6). Scanned as code: comments may
 * still say anything.
 */

const RENDERER = resolve(import.meta.dirname, '..')
const REPO = resolve(RENDERER, '..', '..', '..')
const SELF = resolve(import.meta.dirname, 'rendererBaseline.test.ts')
const FAKE = 'createFakeWindowApi('

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}

/** A file's code with its comments removed. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''))
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

const rel = (path: string): string => relative(REPO, path).split('\\').join('/')
const lineOf = (code: string, index: number): number => code.slice(0, index).split('\n').length

const rendererTests = walk(RENDERER).filter((path) => path.endsWith('.test.ts') && path !== SELF)

/** The text of the object literal opening at `open` (a `{`), braces balanced. */
function objectAt(code: string, open: number): string {
  let depth = 0
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1
    else if (code[i] === '}') {
      depth -= 1
      if (depth === 0) return code.slice(open, i + 1)
    }
  }
  return code.slice(open)
}

/**
 * Whether `expr` (the value a test installs as `window.api`) is the generated fake: a direct call, or an identifier
 * whose nearest earlier declaration is initialised by that call.
 */
function isFake(code: string, at: number, expr: string): boolean {
  const value = expr.trimStart()
  if (value.startsWith(FAKE)) return true
  const id = /^[A-Za-z_$][\w$]*/.exec(value)?.[0]
  if (id === undefined) return false
  const declaration = new RegExp(`\\b(?:const|let|var)\\s+${id}\\b(?:\\s*:[^=\\n]+)?\\s*=\\s*`, 'g')
  let initializer: string | undefined
  for (const match of code.slice(0, at).matchAll(declaration)) {
    initializer = code.slice(
      match.index + match[0].length,
      match.index + match[0].length + FAKE.length
    )
  }
  return initializer === FAKE
}

/** Every place a test file installs `window.api`, with whether the installed value is the generated fake. */
function installs(code: string): { line: number; fake: boolean }[] {
  const found: { line: number; fake: boolean }[] = []
  for (const match of code.matchAll(/Object\.defineProperty\(\s*window\s*,\s*'api'\s*,\s*/g)) {
    const at = match.index + match[0].length
    if (code[at] === '{') {
      const descriptor = objectAt(code, at)
      const value = /\bvalue\s*:\s*/.exec(descriptor)
      const expr = value === null ? '' : descriptor.slice(value.index + value[0].length)
      found.push({ line: lineOf(code, match.index), fake: isFake(code, at, expr) })
    } else {
      // Putting back a descriptor the test saved from `window` itself restores, it installs nothing new.
      const id = /^[A-Za-z_$][\w$]*/.exec(code.slice(at))?.[0] ?? ''
      const saved = new RegExp(
        `\\b${id}\\s*=\\s*Object\\.getOwnPropertyDescriptor\\(\\s*window\\s*,\\s*'api'`
      )
      found.push({ line: lineOf(code, match.index), fake: id !== '' && saved.test(code) })
    }
  }
  for (const match of code.matchAll(/(?:\bwindow\s+as\s+[^)]*\)|\bwindow)\.api\s*=(?!=)\s*/g)) {
    const at = match.index + match[0].length
    found.push({ line: lineOf(code, match.index), fake: isFake(code, at, code.slice(at)) })
  }
  for (const match of code.matchAll(/\.window\s*=(?!=)[^\n]*/g)) {
    const api = /\{\s*api(?:\s*:\s*([^,}]+))?\s*\}/.exec(match[0])
    if (api === null) continue
    const at = match.index + api.index
    found.push({ line: lineOf(code, match.index), fake: isFake(code, at, api[1] ?? 'api') })
  }
  for (const match of code.matchAll(/vi\.stubGlobal\(\s*'(?:window|api)'/g)) {
    found.push({ line: lineOf(code, match.index), fake: false })
  }
  return found
}

const APP_SHELL = resolve(RENDERER, 'App.vue')

/** The files `from` imports by relative specifier, as absolute paths (a `.js` specifier names its `.ts` source). */
function importsOf(from: string): string[] {
  return [...codeOf(from).matchAll(/(?:\bfrom|\bimport\()\s*'(\.[^']+)'/g)].map((match) =>
    resolve(dirname(from), match[1] ?? '').replace(/\.(?:js|mjs)$/, '.ts')
  )
}

describe('renderer baseline (21 §6)', () => {
  it('[ADR-033] renderer tests reach window.api only through the generated fake and never through vi.mock', () => {
    expect(rendererTests.length).toBeGreaterThan(100)
    const offenders = rendererTests.flatMap((path) => {
      const code = codeOf(path)
      const handMade = installs(code)
        .filter((site) => !site.fake)
        .map(
          (site) =>
            `${rel(path)}:${site.line}: window.api built by hand, not by ${FAKE.slice(0, -1)}`
        )
      const mocked = [...code.matchAll(/\bvi\.(?:mock|doMock)\(/g)].map(
        (match) => `${rel(path)}:${lineOf(code, match.index)}: vi.mock`
      )
      return [...handMade, ...mocked]
    })
    expect(offenders).toEqual([])
  })

  it('[ADR-033] every renderer lib file is covered by its transplanted test file or listed in docs/test-removals.md', () => {
    const libFiles = walk(resolve(RENDERER, 'lib')).filter(
      (path) => /\.(?:ts|vue)$/.test(path) && !/\.test\.ts$/.test(path) && !path.endsWith('.d.ts')
    )
    expect(libFiles.length).toBeGreaterThan(100)
    // A lib file is covered by a test that imports it, or by the test of a component that draws it: a `.vue` file a
    // test imports, one hop, never through the App.vue shell, which imports nearly everything.
    const fromTests = new Set(rendererTests.flatMap((path) => importsOf(path)))
    const components = [...fromTests].filter((path) => path.endsWith('.vue') && path !== APP_SHELL)
    const covered = new Set(
      [...fromTests, ...components.flatMap((path) => importsOf(path))].map((path) =>
        path.replace(/\.(?:ts|vue)$/, '')
      )
    )
    const removals = readFileSync(resolve(REPO, 'docs', 'test-removals.md'), 'utf8')
    const uncovered = libFiles
      .filter((path) => !covered.has(path.replace(/\.(?:ts|vue)$/, '')))
      .map(rel)
      .filter((path) => !removals.includes(path))
    expect(uncovered).toEqual([])
  })
})
