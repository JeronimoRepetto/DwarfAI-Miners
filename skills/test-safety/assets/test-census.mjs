#!/usr/bin/env node
/**
 * Before/after census of test statements per test file, working tree vs git.
 *
 * This exists because of one specific failure: an agent used Write on two
 * existing test files, silently destroyed 40 committed tests belonging to three
 * different issues, and the suite still went green — it had added more tests
 * than it deleted, so the total rose and nothing looked wrong. A rising total
 * hides a loss. Only a per-file comparison against the committed version finds
 * it, which is what this does.
 *
 * It counts `it(`, `it.each(`, `test(` and friends as they are WRITTEN. That is
 * deliberately not the number vitest reports: one `it.each` block expands into
 * many runtime cases (across src today, ~1731 written statements become ~1892
 * runtime tests). A structural census is the right instrument here anyway,
 * because the question is "did a block of tests stop existing", not "how many
 * assertions ran".
 *
 * For the same reason the regex does not try to exclude `it(` inside a string
 * or a comment: a stable over-count costs nothing when only the DELTA is read.
 *
 * Usage:
 *   node skills/test-safety/assets/test-census.mjs         # changed vs HEAD
 *   node skills/test-safety/assets/test-census.mjs --all   # every tracked test file
 *   node skills/test-safety/assets/test-census.mjs --base <ref>
 *
 * Exit code 1 means at least one file lost test statements. That is not proof
 * of a mistake — deleting a genuinely obsolete test is legitimate — it means
 * the loss has to be stated and justified out loud rather than passing unseen.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'

/**
 * A test statement as authored. The lookbehind keeps `submit(` and `.it(` out;
 * the optional modifier chain catches `it.each`, `it.skip.each`, `test.only`.
 */
const TEST_CALL =
  /(?<![\w$.])(?:it|test)(?:\.(?:each|skip|only|todo|concurrent|fails|runIf|skipIf|sequential|extend))*\s*(?:\(|`|\[)/g

function git(args, quiet = false) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // A file that is new in the working tree makes `git show HEAD:path` fail by
    // design; that is an answer, not an error, so its noise stays off the report.
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'pipe']
  })
}

function count(source) {
  return source.match(TEST_CALL)?.length ?? 0
}

/** The committed text of `path`, or null when the file is new in this tree. */
function atRef(ref, path) {
  try {
    return git(['show', `${ref}:${path}`])
  } catch {
    return null
  }
}

function main() {
  const argv = process.argv.slice(2)
  const all = argv.includes('--all')
  const baseIndex = argv.indexOf('--base')
  const base = baseIndex === -1 ? 'HEAD' : argv[baseIndex + 1]

  const isTest = (p) => /\.test\.[cm]?tsx?$/.test(p)

  // Changed-only is the default because the question is almost always "what did
  // I just touch". --all is for auditing a branch someone else wrote.
  const paths = all
    ? git(['ls-files', '--', '*.test.ts', '*.test.tsx']).split('\n').filter(Boolean)
    : [
        ...new Set(
          [
            ...git(['diff', '--name-only', base]).split('\n'),
            ...git(['diff', '--name-only', '--cached', base]).split('\n'),
            ...git(['ls-files', '--others', '--exclude-standard']).split('\n')
          ]
            .map((p) => p.trim())
            .filter((p) => p && isTest(p))
        )
      ]

  if (paths.length === 0) {
    console.log(`No test files differ from ${base}.`)
    return 0
  }

  const rows = []
  for (const path of paths.sort()) {
    const before = atRef(base, path)
    const after = existsSync(path) ? readFileSync(path, 'utf8') : null
    rows.push({
      path,
      before: before === null ? 0 : count(before),
      after: after === null ? 0 : count(after),
      isNew: before === null,
      gone: after === null
    })
  }

  const width = Math.max(...rows.map((r) => r.path.length), 4)
  console.log(`Test statement census — working tree vs ${base}\n`)
  console.log(`${'file'.padEnd(width)}  ${'before'.padStart(6)}  ${'after'.padStart(6)}  delta`)
  console.log('-'.repeat(width + 24))

  let lost = 0
  for (const r of rows) {
    const delta = r.after - r.before
    const note = r.gone ? '  DELETED' : r.isNew ? '  (new file)' : ''
    const sign = delta > 0 ? `+${delta}` : `${delta}`
    if (delta < 0) lost += 1
    console.log(
      `${r.path.padEnd(width)}  ${String(r.before).padStart(6)}  ${String(r.after).padStart(6)}  ${sign}${note}`
    )
  }

  const total = rows.reduce((sum, r) => sum + (r.after - r.before), 0)
  console.log(`\nnet ${total > 0 ? `+${total}` : total} across ${rows.length} file(s).`)

  if (lost > 0) {
    console.log(
      `\n${lost} file(s) LOST test statements. Say which tests went and why, or restore them:\n  git diff ${base} -- <file>`
    )
    return 1
  }
  console.log('\nNo file lost test statements.')
  return 0
}

process.exit(main())
