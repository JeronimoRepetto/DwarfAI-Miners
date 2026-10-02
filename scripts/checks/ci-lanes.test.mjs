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
// ADDED for ISSUE-051: the Windows legs' non-elevated wrapper (scripts/ci/run-unelevated.mjs).
const UNELEVATED_PROBE = 'run: node scripts/ci/run-unelevated.mjs --probe\n'
const UNELEVATED_OS_LANE = 'run: node scripts/ci/run-unelevated.mjs -- pnpm test:os\n'
const UNELEVATED_E2E = 'run: node scripts/ci/run-unelevated.mjs -- pnpm test:e2e\n'

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
    // AMENDED for ISSUE-051: the Windows leg runs the E2E cases as a non-elevated user (a test below), so the plain
    // command is the macOS leg's.
    expect(job).toMatch(/if: runner\.os == 'macOS'\n\s+run: pnpm test:e2e\n/)

    // Not a required merge check: the ruleset names only the checks job, which needs neither lane.
    expect(workflow.split(REQUIRED_CHECK).length - 1, 'one job carries the required name').toBe(1)
    expect(jobText('checks')).toContain(REQUIRED_CHECK)
    expect(jobText('checks')).not.toMatch(/\n {4}needs:/)
    expect(job).not.toContain(REQUIRED_CHECK)
  })

  // ADDED for ISSUE-051: the built app's Host binds its pipe through the owner-only pipe helper and the UI starts it
  // through the launch helper (prebuilds/, git-ignored), so the Windows E2E leg builds them before the E2E run.
  it('[ADR-002] the e2e job builds the Windows native modules before it runs the E2E cases', () => {
    const job = jobText('e2e')
    const native = job.search(/if: runner\.os == 'Windows'\n\s+run: pnpm build:native --arch x64\n/)
    expect(native, 'the Windows leg builds the native modules').toBeGreaterThanOrEqual(0)
    expect(native).toBeLessThan(job.indexOf(UNELEVATED_E2E))
  })

  // ADDED for ISSUE-051: the hosted Windows runner runs every step elevated, the package assumes a test user who is
  // not (ISSUE-021 L8), and the real Host refuses to start elevated (ADR-002 D6). The Windows steps that run the real
  // Host run as a standard local user, after a probe that prints that user's integrity level and fails unless it is
  // medium or below; the job names stay as the "Protect main" ruleset knows them.
  it('[ADR-002] the Windows OS-lane and E2E steps run as a non-elevated user, after a probe of its integrity level', () => {
    for (const [id, command] of [
      ['checks', UNELEVATED_OS_LANE],
      ['e2e', UNELEVATED_E2E]
    ]) {
      const job = jobText(id)
      const run = job.indexOf(command)
      expect(run, `the ${id} job's Windows leg runs ${command.trim()}`).toBeGreaterThanOrEqual(0)
      expect(
        job.slice(job.lastIndexOf('- name:', run), run),
        "that step is the Windows leg's"
      ).toContain("if: runner.os == 'Windows'")
      const probe = job.indexOf(UNELEVATED_PROBE)
      expect(probe, `the ${id} job probes the non-elevated user`).toBeGreaterThanOrEqual(0)
      expect(probe, 'the probe runs before the command').toBeLessThan(run)
    }
    expect(jobText('checks')).toContain(REQUIRED_CHECK)
  })

  // ADDED for the cut-0 conformance fixes: the high-integrity branch of ELEVATED_REFUSED, which the non-elevated OS
  // lane cannot reach. The checks job's Windows leg runs elevated, so one step there, outside the non-elevated
  // wrapper, starts the built Host and expects exit 65 with nothing bound (scripts/ci/check-elevated-refusal.mjs). It
  // reads no secret and never runs for a pull request from a fork; the OS lane still runs as the non-elevated user.
  it('[ADR-002, S12.03] the Windows checks leg starts the built Host elevated, after the build, and expects ELEVATED_REFUSED', () => {
    const job = jobText('checks')
    const command = 'run: node scripts/ci/check-elevated-refusal.mjs --entry out/host/main.js\n'
    const run = job.indexOf(command)
    expect(run, 'the checks job runs the elevated refusal check').toBeGreaterThanOrEqual(0)
    const step = job.slice(job.lastIndexOf('- name:', run), run + command.length)
    expect(step, 'it is the Windows leg').toContain("runner.os == 'Windows'")
    expect(step, 'it never runs for a pull request from a fork').toContain(
      "!(github.event_name == 'pull_request' && github.event.pull_request.head.repo.fork)"
    )
    expect(step, 'it reads no secret').not.toContain('secrets.')
    expect(step, 'it runs elevated, outside the non-elevated wrapper').not.toContain(
      'run-unelevated.mjs'
    )
    expect(run, 'the Host it starts is built first').toBeGreaterThan(
      job.indexOf('run: pnpm build\n')
    )
    expect(job, 'the OS lane still runs as the non-elevated user').toContain(UNELEVATED_OS_LANE)
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
