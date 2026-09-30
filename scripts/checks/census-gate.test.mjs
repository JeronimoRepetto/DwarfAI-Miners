import { describe, expect, it } from 'vitest'
import { evaluateCensusGate, parseCensusOutput, runCensusGate } from './census-gate.mjs'

/**
 * L7 check of the test-loss census gate (testing strategy `17` §2.6).
 *
 * The census (`skills/test-safety/assets/test-census.mjs --base <merge-base>`) exits 1 when a
 * test file lost test statements. The gate accepts that loss only when the same change added a
 * row to `docs/test-removals.md` for each losing file: it reads that file, never PR text, and an
 * entry that was already there at the merge base does not justify a new loss.
 */

/** A census report in the census's own format, from `[path, before, after, note]` rows. */
function censusReport(rows) {
  const width = Math.max(...rows.map(([file]) => file.length), 4)
  const lines = [
    'Test statement census — working tree vs abc123',
    '',
    `${'file'.padEnd(width)}  ${'before'.padStart(6)}  ${'after'.padStart(6)}  delta`,
    '-'.repeat(width + 24)
  ]
  let lost = 0
  for (const [file, before, after, note = ''] of rows) {
    const delta = after - before
    if (delta < 0) lost += 1
    lines.push(
      `${file.padEnd(width)}  ${String(before).padStart(6)}  ${String(after).padStart(6)}  ${delta > 0 ? `+${delta}` : delta}${note}`
    )
  }
  lines.push('', `net 0 across ${rows.length} file(s).`)
  lines.push(
    lost > 0 ? `\n${lost} file(s) LOST test statements.` : '\nNo file lost test statements.'
  )
  return { exitCode: lost > 0 ? 1 : 0, output: lines.join('\n') }
}

const HEADER = [
  '# Test removals',
  '',
  '| File | Statements removed | Reason | Removed by issue | Coverage now lives in |',
  '| ---- | ------------------ | ------ | ---------------- | --------------------- |'
]

/** `docs/test-removals.md` with one row per file. */
const removals = (...files) =>
  [
    ...HEADER,
    ...files.map(
      (file) => `| \`${file}\` | 2: \`a\`, \`b\` | obsolete | ISSUE-015 | \`x.test.ts\` |`
    )
  ].join('\n')

describe('test-loss census gate (17 §2.6)', () => {
  it('[ADR-001] a file that lost test statements fails the gate unless docs/test-removals.md has an entry for it', () => {
    const noLoss = censusReport([
      ['src/a.test.ts', 3, 5],
      ['src/new.test.ts', 0, 2, '  (new file)']
    ])
    expect(
      evaluateCensusGate({ census: noLoss, removalsNow: removals(), removalsAtBase: removals() })
        .ok,
      'a change without a loss passes'
    ).toBe(true)

    const oneLoss = censusReport([
      ['src/a.test.ts', 5, 3],
      ['src/b.test.ts', 2, 2]
    ])
    const unjustified = evaluateCensusGate({
      census: oneLoss,
      removalsNow: removals(),
      removalsAtBase: removals()
    })
    expect(unjustified.ok, 'a loss without an entry fails').toBe(false)
    expect(unjustified.unjustified).toEqual(['src/a.test.ts'])

    expect(
      evaluateCensusGate({
        census: oneLoss,
        removalsNow: removals('src/a.test.ts'),
        removalsAtBase: removals()
      }).ok,
      'a loss with an entry added by the same change passes'
    ).toBe(true)

    expect(
      evaluateCensusGate({
        census: oneLoss,
        removalsNow: removals('src/a.test.ts'),
        removalsAtBase: removals('src/a.test.ts')
      }).ok,
      'an entry that was already there at the merge base does not justify a new loss'
    ).toBe(false)

    const twoLosses = censusReport([
      ['src/a.test.ts', 5, 3],
      ['scripts/gone.test.mjs', 4, 0, '  DELETED']
    ])
    const partly = evaluateCensusGate({
      census: twoLosses,
      removalsNow: removals('src/a.test.ts'),
      removalsAtBase: removals()
    })
    expect(partly.ok, 'every losing file needs its own entry').toBe(false)
    expect(partly.unjustified).toEqual(['scripts/gone.test.mjs'])
  })

  it('[ADR-001] a census failure the gate cannot read fails the gate', () => {
    expect(parseCensusOutput(censusReport([['src/a.test.ts', 5, 3]]).output)).toEqual([
      { path: 'src/a.test.ts', before: 5, after: 3 }
    ])
    const unreadable = { exitCode: 1, output: 'fatal: bad revision' }
    const result = evaluateCensusGate({
      census: unreadable,
      removalsNow: removals(),
      removalsAtBase: removals()
    })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no losing file/)
    const crashed = { exitCode: 2, output: '' }
    expect(
      evaluateCensusGate({ census: crashed, removalsNow: removals(), removalsAtBase: removals() })
        .ok
    ).toBe(false)
  })

  it('[ADR-001] the gate needs --base and runs the census against it', () => {
    const lines = { out: [], err: [] }
    const io = { out: (line) => lines.out.push(line), err: (line) => lines.err.push(line) }
    expect(runCensusGate([], io)).toBe(1)
    expect(lines.err.join('\n')).toMatch(/--base/)

    const calls = []
    const deps = {
      runCensus: (base) => {
        calls.push(base)
        return censusReport([['src/a.test.ts', 5, 3]])
      },
      readRemovalsNow: () => removals('src/a.test.ts'),
      readRemovalsAtBase: () => removals()
    }
    expect(runCensusGate(['--base', 'abc123'], io, deps)).toBe(0)
    expect(calls).toEqual(['abc123'])
  })
})
