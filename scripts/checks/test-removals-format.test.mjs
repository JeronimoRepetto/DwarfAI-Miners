import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * L7 check of the census record `docs/test-removals.md` (17 §2.6).
 *
 * The census gate reads this file, never PR text, so its one table must keep the five columns
 * each removal entry fills in.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const removalsPath = path.join(repoRoot, 'docs', 'test-removals.md')

const CENSUS_COLUMNS = [
  'File',
  'Statements removed',
  'Reason',
  'Removed by issue',
  'Coverage now lives in'
]

const SEPARATOR_ROW = /^\|(?:\s*:?-+:?\s*\|)+$/

/** The cells of a Markdown table row, trimmed. */
const cells = (row) =>
  row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim())

describe('docs/test-removals.md (17 §2.6)', () => {
  it('[ADR-001] docs/test-removals.md has the five census columns of 17 §2.6', () => {
    expect(existsSync(removalsPath), 'docs/test-removals.md exists').toBe(true)

    const lines = readFileSync(removalsPath, 'utf8').split(/\r?\n/)
    // A table header is a pipe row directly followed by its separator row.
    const headers = lines.filter(
      (line, index) =>
        line.trim().startsWith('|') &&
        !SEPARATOR_ROW.test(line.trim()) &&
        SEPARATOR_ROW.test((lines[index + 1] ?? '').trim())
    )

    expect(headers.length, 'number of tables in docs/test-removals.md').toBe(1)
    expect(cells(headers[0])).toEqual(CENSUS_COLUMNS)
  })
})
