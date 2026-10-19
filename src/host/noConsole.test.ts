import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ADR-026 Verification and 17 §1.7 "Misc static": `console.*` only in the logger. In the Host the
 * logger is the diagnostics adapters; every other file logs through the kernel `DiagnosticsLog`.
 * Read as text; comments are removed first, so prose that names `console.log` is not a call.
 */
const HOST_ROOT = import.meta.dirname
const LOGGER = join(HOST_ROOT, 'modules', 'diagnostics', 'adapters') + sep

const CONSOLE_USE = /\bconsole\s*(?:\.\s*[A-Za-z_$][\w$]*|\[)/

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|mts|cts|js|mjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

/** The source without `//` and `/* *\/` comments (string contents are kept). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

describe('console only in the logger (ADR-026)', () => {
  it('[ADR-026] no console.* call in src/host outside the diagnostics adapters', () => {
    const files = sourceFiles(HOST_ROOT)
    expect(files.length).toBeGreaterThan(0)
    const violations = files
      .filter((file) => !file.startsWith(LOGGER))
      .filter((file) => CONSOLE_USE.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(HOST_ROOT, file))
    expect(violations).toEqual([])
  })
})
