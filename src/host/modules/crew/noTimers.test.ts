import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ADR-032 item 3 (17 §1.7 "Misc static"): the status is re-derived through the kernel `Scheduler`
 * on the injected `Clock`, never through a runtime timer. Read as text, so the check holds without
 * a bundler. Every file of the crew module is scanned, tests included (L1–L3 use fake clocks);
 * comments are stripped first so prose may still name the forbidden calls.
 */
const FOLDER = import.meta.dirname
const SELF = 'noTimers.test.ts'

/** A runtime timer, called or passed as a value, or the module that provides them. */
const RUNTIME_TIMER =
  /\bset(?:Timeout|Interval|Immediate)\b|['"](?:node:)?timers(?:\/promises)?['"]/

function sourceFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && entry.name !== SELF)
    .map((entry) => join(entry.parentPath, entry.name))
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('the crew module has no runtime timers (ADR-032 item 3)', () => {
  it('[ADR-032] no setTimeout or setInterval in the crew module', () => {
    const files = sourceFiles(FOLDER)
    expect(files.length).toBeGreaterThan(0)
    const violations = files
      .filter((file) => RUNTIME_TIMER.test(withoutComments(readFileSync(file, 'utf8'))))
      .map((file) => relative(FOLDER, file))
    expect(violations).toEqual([])
  })
})
