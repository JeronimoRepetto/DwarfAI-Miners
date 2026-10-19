// layer: L7
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ADR-018 item 7 and 05 §5.1 R7, static (17 §1.7 "Misc static"; TC-113-04): the OS notification is drawn by the
 * Electron UI process only, so no file of the Host tree (`src/host`, tests included: the Host runs under
 * `ELECTRON_RUN_AS_NODE=1` and links no notification library of its own) names `electron` or a notification package
 * as a module. Lint enforces R7 for `electron` (05 §5.2); this check also covers any package whose name speaks of
 * notifications or toasts (node-notifier, toasted-notifier, …), which no lint rule lists. Read as text with comments
 * removed, so prose that names a package is not an import.
 */
const HOST_ROOT = join(import.meta.dirname, '..', '..', 'host')

/** Every module specifier of an `import … from`, `export … from`, `import(…)` or `require(…)`. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)(['"`])([^'"`]+)\1/gm

/** A bare specifier (a package, never a relative path) that is Electron or a notification library. */
const FORBIDDEN =
  /^(?:electron(?:\/.*)?|[^./][^/]*(?:notif|toast)[^/]*(?:\/.*)?|@[^/]+\/[^/]*(?:notif|toast)[^/]*(?:\/.*)?)$/i

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(?:ts|mts|cts|js|mjs|cjs)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
}

/** The source without `//` and `/* *\/` comments (string contents are kept). */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

function forbiddenSpecifiers(source: string): string[] {
  return [...withoutComments(source).matchAll(SPECIFIER)]
    .map((match) => match[2] ?? '')
    .filter((specifier) => FORBIDDEN.test(specifier))
}

describe('the Host links no notification library (ADR-018 item 7)', () => {
  it('[R7] no src/host file imports electron or a notification library', () => {
    const files = sourceFiles(HOST_ROOT)
    expect(files.length).toBeGreaterThan(100)
    const violations = files
      .map((file) => ({
        file: relative(HOST_ROOT, file),
        specifiers: forbiddenSpecifiers(readFileSync(file, 'utf8'))
      }))
      .filter((found) => found.specifiers.length > 0)
    expect(violations).toEqual([])
  })

  it('[R7] the check recognises electron and notification packages, and leaves relative paths and other packages alone', () => {
    expect(
      forbiddenSpecifiers(
        [
          "import { Notification } from 'electron'",
          "import type { App } from 'electron/main'",
          "const notifier = require('node-notifier')",
          "export { toast } from 'toasted-notifier'",
          "const m = await import('@scope/mac-notifications')",
          "import { notifierAttached } from '../modules/attention/application/notifier'",
          "import { z } from 'zod'",
          "// import { Notification } from 'electron'"
        ].join('\n')
      )
    ).toEqual([
      'electron',
      'electron/main',
      'node-notifier',
      'toasted-notifier',
      '@scope/mac-notifications'
    ])
  })
})
