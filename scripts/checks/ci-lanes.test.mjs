// layer: L7
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * L7 check of the release lanes in CI (testing strategy `17` §1.9, §1.11, §1.13, §5.2; `20` §2.1).
 *
 * The workflow cannot run here, so its text is read. E2E (`pnpm test:e2e`, L9) runs on Windows,
 * macOS and Linux (under Xvfb) on every push to `main`, nightly, on release tags and on a pull
 * request labelled `e2e`; perf (`pnpm test:perf`, L11) runs nightly and on release tags and uploads
 * `perf-results/**`. Both are required for a release, never for a merge (HO-38): the "Protect main"
 * ruleset requires only the `checks` job's display name, so neither lane may carry that name, be
 * needed by `checks`, or run on an ordinary pull request.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const workflow = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'ci.yml'),
  'utf8'
).replace(/\r\n/g, '\n')

/** The text of one top-level job of the workflow, from its key to the next job's key. */
function jobText(id) {
  const start = workflow.indexOf(`\n  ${id}:\n`)
  expect(start, `ci.yml has a "${id}" job`).toBeGreaterThanOrEqual(0)
  const next = workflow.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/)
  return next === -1 ? workflow.slice(start) : workflow.slice(start, start + 1 + next)
}

/** The workflow's `on:` block. */
const triggers = workflow.slice(workflow.indexOf('\non:\n'), workflow.indexOf('\npermissions:\n'))

/** The job-level `if:` expression of a job (possibly folded over several lines). */
function jobCondition(job) {
  const match = job.match(/\n {4}if: (?:>-?\n((?: {6}.*\n)+)|(.*)\n)/)
  expect(match, 'the job has a job-level if:').not.toBeNull()
  return (match[1] ?? match[2]).replace(/\s+/g, ' ').trim()
}

/** The display name the "Protect main" ruleset requires (the `checks` job). */
const REQUIRED_CHECK =
  'name: Privacy guard, typecheck, lint, format, skills-sync, test, build (${{ matrix.os }})'

const THREE_OSES = 'os: [windows-latest, macos-latest, ubuntu-latest]'
const PUSH_TO_MAIN = "github.event_name == 'push' && github.ref == 'refs/heads/main'"
const NIGHTLY = "github.event_name == 'schedule'"
const RELEASE_TAG = "startsWith(github.ref, 'refs/tags/v')"
const E2E_LABEL = "contains(github.event.pull_request.labels.*.name, 'e2e')"

describe('release lanes in CI (17 §1.13, §5.2; 20 §2.1)', () => {
  it('[ADR-001] the e2e job runs on the three OSes on push to main, nightly, release tags and the e2e label, and is not a required merge check', () => {
    expect(triggers).toMatch(/\n {2}push:\n {4}branches: \[main\]\n {4}tags: \['v\*'\]\n/)
    expect(triggers).toMatch(/\n {2}schedule:\n {4}- cron: '[\d*/ ,-]+'\n/)
    expect(triggers, 'adding the e2e label starts the lane').toMatch(
      /\n {2}pull_request:\n {4}types: \[[^\]]*\blabeled\b[^\]]*\]\n/
    )

    const job = jobText('e2e')
    expect(job).toContain(THREE_OSES)
    expect(job).toContain('fail-fast: false')
    const condition = jobCondition(job)
    for (const trigger of [PUSH_TO_MAIN, NIGHTLY, RELEASE_TAG, E2E_LABEL]) {
      expect(condition, `the e2e job runs on ${trigger}`).toContain(trigger)
    }
    expect(job).toContain('run: pnpm build\n')
    expect(job, 'Linux runs the app under Xvfb').toMatch(
      /if: runner\.os == 'Linux'\n\s+run: xvfb-run --auto-servernum pnpm test:e2e\n/
    )
    expect(job).toMatch(/if: runner\.os != 'Linux'\n\s+run: pnpm test:e2e\n/)

    // Not a required merge check: the ruleset names only the checks job, which needs neither lane.
    expect(workflow.split(REQUIRED_CHECK).length - 1, 'one job carries the required name').toBe(1)
    expect(jobText('checks')).toContain(REQUIRED_CHECK)
    expect(jobText('checks')).not.toMatch(/\n {4}needs:/)
    expect(job).not.toContain(REQUIRED_CHECK)
  })

  it('[ADR-001] the perf job runs nightly and on release tags and uploads perf-results', () => {
    const job = jobText('perf')
    expect(job).toContain(THREE_OSES)
    expect(job).toContain('fail-fast: false')
    const condition = jobCondition(job)
    expect(condition).toContain(NIGHTLY)
    expect(condition).toContain(RELEASE_TAG)
    expect(condition, 'perf never runs on a push to main').not.toContain('refs/heads/main')
    expect(condition, 'perf never runs on a pull request').not.toContain('pull_request')
    expect(job).toContain('run: pnpm test:perf\n')
    expect(job).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} # v\d+\.\d+\.\d+\n/)
    expect(job).toMatch(/\n\s+path: perf-results\/\*\*\n/)
    expect(jobText('checks')).not.toContain('pnpm test:perf')
    expect(job).not.toContain(REQUIRED_CHECK)
  })
})
