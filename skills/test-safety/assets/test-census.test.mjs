#!/usr/bin/env node
/**
 * Tests for test-census.mjs, run directly:
 *
 *   node skills/test-safety/assets/test-census.test.mjs
 *
 * Deliberately standalone rather than a vitest suite, for the same reason
 * sync.test.mjs is: `vitest.config.ts` includes `src/**` and `scripts/**`
 * only, so a test here would not be picked up, and widening that config to
 * reach the harness would put the app's suite and its own tooling in the
 * same run for no benefit.
 *
 * Each case builds a throwaway git repo (a real `git init`, not a fake) and
 * invokes the census as a child process with that repo as its cwd, because
 * the census shells out to `git` in its own working directory rather than
 * accepting a `--repo-root` flag.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CENSUS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-census.mjs')

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

/** A throwaway repo with one committed baseline file, so HEAD exists. */
function makeRepo() {
  const root = mkdtempSync(path.join(tmpdir(), 'test-census-test-'))
  git(root, ['init', '-q'])
  git(root, ['config', 'user.email', 'test@example.com'])
  git(root, ['config', 'user.name', 'Test'])
  writeFileSync(path.join(root, '.gitkeep'), '')
  git(root, ['add', '.gitkeep'])
  git(root, ['commit', '-q', '-m', 'init'])
  return root
}

/** Writes and commits a file, so later edits to it show as a diff against HEAD. */
function commitFile(root, relPath, content) {
  const full = path.join(root, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
  git(root, ['add', relPath])
  git(root, ['commit', '-q', '-m', `add ${relPath}`])
}

/** Writes a file without staging or committing it — the "new file" path. */
function writeUntracked(root, relPath, content) {
  const full = path.join(root, relPath)
  mkdirSync(path.dirname(full), { recursive: true })
  writeFileSync(full, content)
}

function run(root, args = []) {
  try {
    const stdout = execFileSync(process.execPath, [CENSUS, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    return { code: 0, out: stdout }
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` }
  }
}

// ── harness ────────────────────────────────────────────────────────────────

let passed = 0
const failures = []
const cleanup = []

function test(name, fn) {
  try {
    fn()
    passed += 1
  } catch (error) {
    failures.push(`${name}\n    ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function withRepo(fn) {
  const root = makeRepo()
  cleanup.push(root)
  return fn(root)
}

// ── the cases ──────────────────────────────────────────────────────────────

test('a .test.ts file counts — existing behaviour, pinned', () => {
  withRepo((root) => {
    writeUntracked(root, 'a.test.ts', "it('one', () => {})\n")
    const result = run(root)
    assert(result.code === 0, `expected exit 0, got ${result.code}:\n${result.out}`)
    assert(result.out.includes('a.test.ts'), `expected a.test.ts in the report:\n${result.out}`)
    assert(
      /a\.test\.ts\s+0\s+1\s+\+1/.test(result.out),
      `expected a before/after of 0/1:\n${result.out}`
    )
  })
})

test('a .test.mjs file now counts — the blind spot from #120', () => {
  withRepo((root) => {
    writeUntracked(root, 'b.test.mjs', "test('one', () => {})\n")
    const result = run(root)
    assert(result.code === 0, `expected exit 0, got ${result.code}:\n${result.out}`)
    assert(
      result.out.includes('b.test.mjs'),
      `the widened matcher should see a .test.mjs suite:\n${result.out}`
    )
    assert(
      /b\.test\.mjs\s+0\s+1\s+\+1/.test(result.out),
      `expected a before/after of 0/1:\n${result.out}`
    )
  })
})

test('a non-test .mjs file is invisible to the census', () => {
  withRepo((root) => {
    writeUntracked(root, 'util.mjs', 'export function test() {}\n')
    const result = run(root)
    assert(result.code === 0, `expected exit 0, got ${result.code}:\n${result.out}`)
    assert(
      result.out.includes('No test files differ from HEAD.'),
      `a plain .mjs file must not be treated as a suite:\n${result.out}`
    )
  })
})

test('a harness "function test(" declaration is not counted as a test statement', () => {
  // Regression for the counting nuance #120 names: sync.test.mjs's own
  // hand-rolled runner defines `function test(name, fn) {`, which the old
  // regex counted as a test statement because only the character
  // immediately before "test" was checked, and a space passes that check.
  withRepo((root) => {
    writeUntracked(
      root,
      'c.test.mjs',
      "function test(name, fn) {\n  fn()\n}\n\ntest('one', () => {})\n"
    )
    const result = run(root)
    assert(result.code === 0, `expected exit 0, got ${result.code}:\n${result.out}`)
    assert(
      /c\.test\.mjs\s+0\s+1\s+\+1/.test(result.out),
      `the declaration must not inflate the count — expected exactly 1:\n${result.out}`
    )
  })
})

test('removed test statements are still detected as a loss', () => {
  withRepo((root) => {
    commitFile(root, 'd.test.ts', "it('one', () => {})\nit('two', () => {})\n")
    writeFileSync(path.join(root, 'd.test.ts'), "it('one', () => {})\n")
    const result = run(root)
    assert(
      result.code === 1,
      `losing a test statement should exit 1, got ${result.code}:\n${result.out}`
    )
    assert(result.out.includes('LOST'), `expected the loss to be called out:\n${result.out}`)
    assert(
      /d\.test\.ts\s+2\s+1\s+-1/.test(result.out),
      `expected a before/after of 2/1:\n${result.out}`
    )
  })
})

// ── report ─────────────────────────────────────────────────────────────────

for (const root of cleanup) rmSync(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} failing:\n`)
  for (const f of failures) console.error(`  ✗ ${f}\n`)
  process.exit(1)
}
console.log(`${passed} passing.`)
