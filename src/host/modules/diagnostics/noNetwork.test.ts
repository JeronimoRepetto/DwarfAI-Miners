import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ADR-026 item 7 (18 C-28): the observability module MUST NOT import `net`, `http`, `https`,
 * `fetch` or any telemetry SDK. Read as text, so the check holds without a bundler. Only production
 * files are scanned: tests may read the disk (this one does).
 */
const FOLDER = import.meta.dirname

/** Every module specifier a file names: static imports, re-exports, bare imports, `import()` and `require()`. */
const SPECIFIER_PATTERNS = [
  /\b(?:import|export)\s[^'"]*?\sfrom\s*['"]([^'"]+)['"]/g,
  /\bimport\s*['"]([^'"]+)['"]/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g
]

/** Node's network modules and the usual telemetry and HTTP client packages. */
const NETWORK_MODULE =
  /^(?:node:)?(?:net|http|https|http2|dgram|tls|dns)(?:\/|$)|^(?:undici|ws|axios|node-fetch|got|@sentry\/|applicationinsights|@opentelemetry\/|posthog|mixpanel|@segment\/)/

/** Network globals reached without an import. */
const NETWORK_GLOBAL =
  /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\s*\(|\bnew\s+(?:XMLHttpRequest|WebSocket|EventSource)\b|\bnavigator\s*\.\s*sendBeacon\b/

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

describe('diagnostics has no network (ADR-026 item 7)', () => {
  it('[ADR-026] the diagnostics module imports no network API', () => {
    const files = productionFiles(FOLDER)
    expect(files.length).toBeGreaterThan(0)
    const violations = files.flatMap((file) => {
      const source = readFileSync(file, 'utf8')
      const imports = specifiersOf(source)
        .filter((specifier) => NETWORK_MODULE.test(specifier))
        .map((specifier) => `${relative(FOLDER, file)} imports ${specifier}`)
      const globals = NETWORK_GLOBAL.test(source)
        ? [`${relative(FOLDER, file)} calls a network global`]
        : []
      return [...imports, ...globals]
    })
    expect(violations).toEqual([])
  })
})
