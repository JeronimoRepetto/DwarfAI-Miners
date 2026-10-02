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

// ADDED for the internal cut build (owner, 2026-10-02): `.github/workflows/internal-build.yml` packages the installers
// of an internal cut build for the owner's soak on his own machines (`21` §2, OQ-71). No public build exists before
// cut 5 (OQ-66, `20` §3.2), and the repository is public, so the workflow runs only on a manual dispatch, publishes
// no release, creates no tag and keeps its artifacts one day. The internal macOS build is unsigned (owner, 2026-10-02):
// the workflow reads no secret and no environment, and the macOS packaging step turns signing off explicitly.
// scripts/ci/fetch-internal-build.mjs downloads and deletes the artifacts.
const internalBuild = readFileSync(
  path.join(repoRoot, '.github', 'workflows', 'internal-build.yml'),
  'utf8'
).replace(/\r\n/g, '\n')

/** The workflow without its comment lines, so prose never satisfies or trips an assertion. */
const internalCode = internalBuild
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('#'))
  .join('\n')

/** One top-level block (`on:`, `permissions:`, `jobs:`…) of the internal-build workflow, without comments. */
function internalBlock(key) {
  const start = internalCode.indexOf(`\n${key}:\n`)
  expect(start, `internal-build.yml has a top-level ${key}:`).toBeGreaterThanOrEqual(0)
  const next = internalCode.slice(start + 1).search(/\n[a-z][\w-]*:/)
  return next === -1 ? internalCode.slice(start) : internalCode.slice(start, start + 1 + next)
}

/** The jobs of the internal-build workflow by id, each split into its header and its steps. */
function internalJobs() {
  const jobs = internalBlock('jobs')
  const ids = [...jobs.matchAll(/\n {2}([a-z][\w-]*):\n/g)]
  return ids.map((match, i) => {
    const text = jobs.slice(match.index, ids[i + 1]?.index ?? jobs.length)
    const stepsAt = text.indexOf('\n    steps:\n')
    const steps = text
      .slice(stepsAt)
      .split(/\n {6}- /)
      .slice(1)
    return { id: match[1], header: text.slice(0, stepsAt), steps }
  })
}

const SIGNING_SECRETS = [
  'APPLE_APP_SPECIFIC_PASSWORD',
  'APPLE_ID',
  'APPLE_TEAM_ID',
  'CSC_KEY_PASSWORD',
  'CSC_LINK'
]

describe('internal cut build workflow (20 §2.1, §3.2; OQ-66)', () => {
  it('[ADR-027] runs only on a manual dispatch that names its label, and never interpolates the label into a script', () => {
    const on = internalBlock('on')
    expect([...on.matchAll(/\n {2}([a-z_]+):/g)].map((m) => m[1])).toEqual(['workflow_dispatch'])
    expect(on).toMatch(/\n {6}label:\n(?: {8}.*\n)*? {8}required: true\n/)
    for (const { steps } of internalJobs()) {
      for (const step of steps) {
        const script = step.slice(step.indexOf('run:') === -1 ? step.length : step.indexOf('run:'))
        expect(script, 'the label reaches a script only through env').not.toMatch(
          /\$\{\{ *(github\.event\.)?inputs\./
        )
      }
    }
  })

  it('[ADR-027] publishes nothing: no release step, no tag, no write permission and no publish token', () => {
    expect(internalBlock('permissions')).toMatch(/^\npermissions:\n {2}contents: read\n?$/)
    expect(internalCode).not.toMatch(/: write\b/)
    expect(internalCode).not.toMatch(/softprops|action-gh-release|gh release|\/releases/i)
    expect(internalCode).not.toMatch(/git tag|git push|refs\/tags|create-tag|tag_name/)
    expect(internalCode).not.toMatch(/--publish (?!never\b)/)
    expect(internalCode, 'electron-builder publishes with a token in the environment').not.toMatch(
      /GH_TOKEN|GITHUB_TOKEN|secrets\.GITHUB/
    )
  })

  it('[ADR-027] packages each OS the way the release jobs do, with pinned actions and a frozen install', () => {
    const code = internalJobs()
      .map((job) => job.steps.join('\n'))
      .join('\n')
    expect(code).toMatch(/if: runner\.os == 'Windows'\n\s+run: pnpm build:native --arch x64\n/)
    expect(internalCode).toContain('package_script: package\n')
    expect(internalCode).toContain('package_script: package:linux\n')
    // AMENDED (owner, 2026-10-02): the internal macOS build is unsigned, so the script runs with signing off.
    expect(code).toContain('run: pnpm package:mac -c.mac.identity=null\n')
    expect(code).toContain('run: pnpm install --frozen-lockfile\n')
    const uses = [...internalCode.matchAll(/uses: (\S+)/g)].map((m) => m[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action, 'pinned by commit SHA').toMatch(/@[0-9a-f]{40}$/)
  })

  it('[ADR-027] uploads each OS installers with their SHA256SUMS as dwarfai-internal-<label>-<os>, kept one day', () => {
    const names = []
    for (const { id, steps } of internalJobs()) {
      const sums = steps.findIndex((step) => step.includes('run: node scripts/ci/sha256sums.mjs '))
      steps.forEach((step, i) => {
        if (!step.includes('uses: actions/upload-artifact@')) return
        expect(sums, `the ${id} job writes SHA256SUMS before it uploads`).toBeGreaterThanOrEqual(0)
        expect(sums).toBeLessThan(i)
        expect(step).toContain('retention-days: 1\n')
        expect(step).toContain('if-no-files-found: error\n')
        expect(step).toMatch(/\n {10}path: \|\n(?: {12}.*\n)* {12}release\/SHA256SUMS\n/)
        names.push(step.match(/\n {10}name: (.+)\n/)[1])
      })
    }
    expect(names.sort()).toEqual([
      'dwarfai-internal-${{ inputs.label }}-${{ matrix.artifact }}',
      'dwarfai-internal-${{ inputs.label }}-macos'
    ])
    expect(internalCode).toContain('artifact: windows\n')
    expect(internalCode).toContain('artifact: linux\n')
    expect([...internalCode.matchAll(/retention-days: (\S+)/g)].map((m) => m[1])).toEqual([
      '1',
      '1'
    ])
  })

  // AMENDED (owner, 2026-10-02): the internal macOS build is unsigned, so no step holds a signing secret any more.
  it('[ADR-027] references no secret and no environment at all', () => {
    expect(internalCode).not.toMatch(/\bsecrets\./)
    expect(internalCode).not.toMatch(/\n {4}environment:/)
    for (const name of SIGNING_SECRETS) expect(internalCode).not.toContain(name)
  })

  it('[ADR-027] packages the macOS dmg and zip unsigned, so nothing is signed or notarized', () => {
    const mac = internalJobs().find((job) => job.id === 'package-mac')
    expect(mac, 'the workflow has a package-mac job').toBeDefined()
    const step = mac.steps.find((s) => s.includes('run: pnpm package:mac'))
    expect(step, 'the package-mac job packages macOS').toBeDefined()
    // identity null skips code signing (electron-builder's own CLI switch), and notarization runs only after a signature.
    expect(step).toContain('run: pnpm package:mac -c.mac.identity=null\n')
    expect(step).toMatch(/\n {8}env:\n(?: {10}.*\n)* {10}CSC_IDENTITY_AUTO_DISCOVERY: 'false'\n/)
    const upload = mac.steps.find((s) => s.includes('uses: actions/upload-artifact@'))
    expect(upload).toMatch(/ {12}release\/\*\.dmg\n {12}release\/\*\.zip\n/)
  })
})
