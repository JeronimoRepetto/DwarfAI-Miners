import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ADR-026 Verification and 17 §1.7 "Misc static": `console.*` only in the logger. In Electron main the logger is
 * `src/ui-main/diagnostics`; every other file logs through the UI logger. Production files only: a test may embed a
 * program that prints to its own stdout (the OS lane's child Electron app does), and tests are never shipped. Read
 * as text; comments are removed first, so prose that names `console.log` is not a call.
 */
const UI_MAIN_ROOT = import.meta.dirname
const LOGGER = join(UI_MAIN_ROOT, 'diagnostics') + sep

const CONSOLE_USE = /\bconsole\s*(?:\.\s*[A-Za-z_$][\w$]*|\[)/

function productionFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|mts|cts|js|mjs)$/.test(entry.name))
    .filter((entry) => !/\.test\.[cm]?[jt]s$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

/** The source without `//` and `/* *\/` comments (string contents are kept). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

describe('console only in the logger (ADR-026)', () => {
  it('[ADR-026] no console.* call in src/ui-main outside the logger', () => {
    const files = productionFiles(UI_MAIN_ROOT)
    expect(files.length).toBeGreaterThan(0)
    expect(files).toContain(join(UI_MAIN_ROOT, 'index.ts'))
    const violations = files
      .filter((file) => !file.startsWith(LOGGER))
      .filter((file) => CONSOLE_USE.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(UI_MAIN_ROOT, file))
    expect(violations).toEqual([])
  })
})
