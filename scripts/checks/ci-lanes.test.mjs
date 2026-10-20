// layer: L7
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ordinaryConfig, { windowsCiTestTimeout } from '../../vitest.config.ts'
import osLaneConfig from '../../vitest.os.config.ts'

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
    // AMENDED for ISSUE-278/280: the perf case starts the built app through the E2E launch harness, so the job
    // builds it as the e2e job does (Electron binary, Windows native modules, E2E build profile) before it runs,
    // and starts it under Xvfb on Linux and as the non-elevated test user on Windows.
    const at = (text) => job.indexOf(text)
    for (const step of [
      'run: pnpm exec install-electron\n',
      'run: pnpm build:native --arch x64\n',
      'DWARFAI_BUILD_PROFILE: e2e\n'
    ]) {
      expect(at(step), `the perf job runs ${step.trim()}`).toBeGreaterThanOrEqual(0)
    }
    expect(at('run: pnpm build\n'), 'the perf job builds the app').toBeGreaterThanOrEqual(0)
    expect(at('run: pnpm build\n'), 'it builds before it measures').toBeLessThan(
      at('pnpm test:perf\n')
    )
    expect(job).toMatch(
      /if: runner\.os == 'Linux'\n\s+run: xvfb-run --auto-servernum pnpm test:perf\n/
    )
    expect(job).toContain('run: node scripts/ci/run-unelevated.mjs -- pnpm test:perf\n')
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
    // AMENDED for ISSUE-268: one `pnpm package` builds the 20 §3.2 targets of the runner's OS from package.json
    // `build`, after its own `pnpm build`, and the packaged-artifact checks run on what it wrote, as in ci.yml
    // `package`; the per-OS scripts `package:linux` and `package:mac` are gone.
    for (const { id, steps } of internalJobs()) {
      const step = (command) => steps.findIndex((s) => s.includes(`run: ${command}`))
      expect(step('pnpm build\n'), `the ${id} job builds`).toBeGreaterThanOrEqual(0)
      expect(step('pnpm build\n'), `the ${id} job builds before it packages`).toBeLessThan(
        step('pnpm package')
      )
      expect(
        step('pnpm test:packaged release\n'),
        `the ${id} job runs the P checks`
      ).toBeGreaterThan(step('pnpm package'))
    }
    expect(internalCode).not.toContain('package_script:')
    expect(code).toMatch(/\n {8}run: pnpm package\n/)
    // AMENDED (owner, 2026-10-02): the internal macOS build is unsigned, so the script runs with signing off.
    expect(code).toContain('run: pnpm package -c.mac.identity=null\n')
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
    // AMENDED for ISSUE-268: Windows builds the zip and the nsis installer of 20 §3.2 (no portable any more), so the
    // Windows leg checksums and uploads both.
    expect(internalCode).toContain('installer_suffixes: .exe .zip\n')
    expect(internalCode).toMatch(/ {12}release\/\*\.exe\n {12}release\/\*\.zip\n/)
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
    // AMENDED for ISSUE-268: the one `pnpm package` script replaced `package:mac`.
    const step = mac.steps.find((s) => s.includes('run: pnpm package'))
    expect(step, 'the package-mac job packages macOS').toBeDefined()
    // identity null skips code signing (electron-builder's own CLI switch), and notarization runs only after a signature.
    expect(step).toContain('run: pnpm package -c.mac.identity=null\n')
    expect(step).toMatch(/\n {8}env:\n(?: {10}.*\n)* {10}CSC_IDENTITY_AUTO_DISCOVERY: 'false'\n/)
    const upload = mac.steps.find((s) => s.includes('uses: actions/upload-artifact@'))
    expect(upload).toMatch(/ {12}release\/\*\.dmg\n {12}release\/\*\.zip\n/)
  })
})

// ADDED for ISSUE-268: the `package` job of `20` §2.1 replaces the `release` and `release-mac` jobs. It runs on `v*`
// tags and on a manual dispatch, one runner per OS (no cross-building), builds, packages the `20` §3.2 targets, runs
// the packaged-artifact checks and uploads the artifacts with their SHA256SUMS as workflow artifacts. It publishes
// nothing: the release job with its GitHub Release is ISSUE-278's, and macOS signing is ISSUE-280's, so until then a
// `v*` tag publishes nothing and no step reads a signing secret.
describe('package job in CI (20 §2.1, §3.2; 18 C-33, C-34)', () => {
  /** The job's text without comment lines, so prose never satisfies or trips an assertion. */
  const packageCode = () =>
    jobText('package')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')

  it('[ADR-027] runs on v* tags and a manual dispatch, one runner per OS, and never on a pull request', () => {
    expect(triggers).toMatch(/\n {2}workflow_dispatch:\n/)
    const job = packageCode()
    const condition = jobCondition(job)
    expect(condition).toContain(RELEASE_TAG)
    expect(condition).toContain("github.event_name == 'workflow_dispatch'")
    expect(condition, 'never on a pull request').not.toContain('pull_request')
    expect(job).toContain('fail-fast: false')
    expect([...job.matchAll(/\n {10}- os: (\S+)\n/g)].map((m) => m[1])).toEqual([
      'windows-latest',
      'macos-15',
      'ubuntu-latest'
    ])
    expect(job).toContain('runs-on: ${{ matrix.os }}')
    expect(job).not.toContain(REQUIRED_CHECK)
  })

  it('[ADR-027] builds, packages, checks the packed Host manifest, runs the P checks, then writes SHA256SUMS', () => {
    const job = packageCode()
    const order = [
      'run: pnpm install --frozen-lockfile\n',
      'run: pnpm build\n',
      'run: pnpm package ${{ matrix.package_args }}\n',
      'run: node scripts/build/verify-packaged-host-manifest.mjs release\n',
      'run: pnpm test:packaged release\n',
      'run: node scripts/ci/sha256sums.mjs release ${{ matrix.installer_suffixes }}\n',
      'uses: actions/upload-artifact@'
    ].map((step) => job.indexOf(step))
    for (const at of order) expect(at).toBeGreaterThanOrEqual(0)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(job).toMatch(/if: runner\.os == 'Windows'\n\s+run: pnpm build:native --arch x64\n/)
    // macOS packages unsigned until ISSUE-280: signing off, and no identity picked out of the keychain.
    expect(job).toContain("package_args: '-c.mac.identity=null'\n")
    expect(job).toMatch(/\n {10}CSC_IDENTITY_AUTO_DISCOVERY: 'false'\n/)
  })

  it('[ADR-027] has contents: read, pins every action by commit SHA, installs frozen and reads no secret', () => {
    const job = packageCode()
    expect(job).toMatch(/\n {4}permissions:\n {6}contents: read\n/)
    expect(job).not.toMatch(/: write\b/)
    const uses = [...job.matchAll(/uses: (\S+)/g)].map((m) => m[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action, 'pinned by commit SHA').toMatch(/@[0-9a-f]{40}$/)
    expect(job).toContain('run: pnpm install --frozen-lockfile\n')
    expect(job).not.toMatch(/\bsecrets\./)
    expect(job).not.toMatch(/\n {4}environment:/)
    for (const name of SIGNING_SECRETS) expect(job).not.toContain(name)
  })

  // AMENDED for ISSUE-278/280: the `release` job publishes the GitHub Release from these artifacts
  // (scripts/release/release.test.mjs). The package job itself still publishes nothing, and no `release-mac` job
  // returns: the signed macOS build (ISSUE-280) is deferred.
  it('[ADR-027] publishes nothing itself: no release step in the package job, no release-mac job and workflow artifacts kept one day', () => {
    expect(workflow, 'ci.yml has no "release-mac" job').not.toContain('\n  release-mac:\n')
    expect(workflow, 'no third-party release action').not.toMatch(/softprops|action-gh-release/i)
    expect(packageCode()).not.toMatch(/gh release/i)
    const job = packageCode()
    expect(job).not.toMatch(/GH_TOKEN|GITHUB_TOKEN/)
    expect(job).toMatch(
      / {12}release\/\*\.exe\n {12}release\/\*\.zip\n {12}release\/\*\.dmg\n {12}release\/\*\.AppImage\n {12}release\/\*\.deb\n {12}release\/SHA256SUMS\n/
    )
    expect(job).toContain('retention-days: 1\n')
    expect(job).toContain('if-no-files-found: error\n')
  })
})

// ADDED for ISSUE-272: the license-sbom job (20 §2.1 `license-sbom`, §2.4, §3.2; 18 C-35, C-36).
describe('license-sbom job in CI (20 §2.1, §2.4; 18 C-35, C-36)', () => {
  /** The job's text without comment lines, so prose never satisfies or trips an assertion. */
  const licenceCode = () =>
    jobText('license-sbom')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')

  it('[ADR-008] runs on Linux on every push to main and wherever package runs, never on a pull request, and is not a required merge check', () => {
    const job = licenceCode()
    const condition = jobCondition(job)
    expect(condition).toContain(PUSH_TO_MAIN)
    expect(condition).toContain(RELEASE_TAG)
    expect(condition).toContain("github.event_name == 'workflow_dispatch'")
    expect(condition, 'never on a pull request').not.toContain('pull_request')
    expect(job).toContain('runs-on: ubuntu-latest\n')
    expect(job).not.toContain(REQUIRED_CHECK)
  })

  it('[ADR-008, S-008-1] writes the licence report, checks the S-008-1 records, writes one SBOM per OS and the notices, then uploads them', () => {
    const job = licenceCode()
    const order = [
      'run: pnpm install --frozen-lockfile\n',
      'run: node scripts/release/licenses.mjs\n',
      'run: node scripts/release/s008-records.mjs\n',
      'pnpm sbom --sbom-format cyclonedx --prod --sbom-type application > "$RUNNER_TEMP/pnpm-sbom.json"\n',
      'node scripts/release/sbom.mjs --input "$RUNNER_TEMP/pnpm-sbom.json"\n',
      'run: node scripts/release/third-party-notices.mjs\n',
      'uses: actions/upload-artifact@'
    ].map((step) => job.indexOf(step))
    for (const at of order) expect(at).toBeGreaterThanOrEqual(0)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(job).toMatch(
      / {12}release\/licenses\/licenses\.json\n {12}release\/licenses\/sbom-\*\.json\n {12}release\/licenses\/THIRD-PARTY-NOTICES\.md\n/
    )
    expect(job).toContain('if-no-files-found: error\n')
  })

  it('[ADR-008] has contents: read, pins every action by commit SHA, reads no secret and publishes nothing', () => {
    const job = licenceCode()
    expect(job).toMatch(/\n {4}permissions:\n {6}contents: read\n/)
    expect(job).not.toMatch(/: write\b/)
    const uses = [...job.matchAll(/uses: (\S+)/g)].map((m) => m[1])
    expect(uses.length).toBeGreaterThan(0)
    for (const action of uses) expect(action, 'pinned by commit SHA').toMatch(/@[0-9a-f]{40}$/)
    expect(job).not.toMatch(/\bsecrets\.|GH_TOKEN|GITHUB_TOKEN/)
    expect(job).not.toMatch(/\n {4}environment:/)
    expect(job).not.toMatch(/softprops|action-gh-release|gh release|npm publish|pnpm publish/i)
    expect(job).toContain('retention-days: 1\n')
  })
})

// ADDED for ISSUE-272 (TC-272-03): every packaging job writes THIRD-PARTY-NOTICES.md before `pnpm package`, so
// package.json `build.extraResources` ships it beside LICENSE in every archive.
describe('third-party notices before packaging (20 §2.4; R-06; ISSUE-272)', () => {
  const NOTICES = 'run: node scripts/release/third-party-notices.mjs\n'

  it('[NFR-COMP-07] the package job writes the notices after the build and before it packages', () => {
    const job = jobText('package')
    const at = job.indexOf(NOTICES)
    expect(at, 'the package job writes the notices').toBeGreaterThanOrEqual(0)
    expect(at).toBeGreaterThan(job.indexOf('run: pnpm install --frozen-lockfile\n'))
    expect(at).toBeLessThan(job.indexOf('run: pnpm package ${{ matrix.package_args }}\n'))
  })

  it('[NFR-COMP-07] each internal build job writes the notices before it packages', () => {
    for (const { id, steps } of internalJobs()) {
      const step = (command) => steps.findIndex((s) => s.includes(command))
      expect(step(NOTICES), `the ${id} job writes the notices`).toBeGreaterThanOrEqual(0)
      expect(step(NOTICES), `the ${id} job writes them before it packages`).toBeLessThan(
        step('run: pnpm package')
      )
    }
  })

  it('[NFR-COMP-07] package.json build ships LICENSE and THIRD-PARTY-NOTICES.md as app resources', () => {
    const { build } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))
    expect(build.extraResources).toEqual(
      expect.arrayContaining([
        { from: 'LICENSE', to: 'LICENSE' },
        { from: 'release/licenses/THIRD-PARTY-NOTICES.md', to: 'THIRD-PARTY-NOTICES.md' }
      ])
    )
  })
})

// ADDED for ISSUE-273: P-03's lockfile half (`20` §2.3; TC-273-02). Every job that packages scans the lockfile's
// production dependencies and the production sources for provider binaries, the Agent SDK and credential stores in
// the step right before it packages, so a listed package stops the job before electron-builder starts.
describe('provider scan before packaging (20 P-03; ISSUE-273)', () => {
  const SCAN_STEP =
    'name: Scan the lockfile and sources for provider binaries and the Agent SDK\n' +
    '        run: node scripts/release/lockfile-provider-scan.mjs\n'

  /** The steps of a job's text, comment lines dropped, each from its `- ` to the next step. */
  const stepsOf = (text) => {
    const code = text
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('#'))
      .join('\n')
    return code
      .slice(code.indexOf('\n    steps:\n'))
      .split(/\n {6}- /)
      .slice(1)
      .map((step) => `${step}\n`)
  }

  it('[ADR-008] every packaging job runs the lockfile provider scan in the step right before it packages', () => {
    const jobs = [
      { id: 'ci.yml package', steps: stepsOf(jobText('package')) },
      ...internalJobs()
        .filter(({ steps }) => steps.some((step) => step.includes('run: pnpm package')))
        .map(({ id, steps }) => ({
          id: `internal-build.yml ${id}`,
          steps: steps.map((s) => `${s}\n`)
        }))
    ]
    expect(jobs.map(({ id }) => id)).toEqual([
      'ci.yml package',
      'internal-build.yml package',
      'internal-build.yml package-mac'
    ])
    for (const { id, steps } of jobs) {
      const packageAt = steps.findIndex((step) => step.includes('run: pnpm package'))
      expect(packageAt, `${id} packages`).toBeGreaterThan(0)
      expect(steps[packageAt - 1], `${id} scans right before it packages`).toContain(SCAN_STEP)
    }
  })
})

describe('pnpm version in CI (AGENTS §0.2; 20 §1)', () => {
  /** Every `pnpm/setup` step of every workflow, as `{ file, version }`. */
  const pnpmSetups = () =>
    ['ci.yml', 'internal-build.yml'].flatMap((file) => {
      const text = readFileSync(path.join(repoRoot, '.github', 'workflows', file), 'utf8').replace(
        /\r\n/g,
        '\n'
      )
      return text
        .split(/\n {6}- /)
        .filter((step) => /\n\s+uses: pnpm\/(?:setup|action-setup)@/.test(step))
        .map((step) => ({ file, version: step.match(/\n\s+version: (\S+)\n/)?.[1] }))
    })

  it('[ADR-001] every workflow job installs one exact pnpm version, never a floating major', () => {
    const setups = pnpmSetups()
    expect(setups.length, 'both workflows set up pnpm').toBeGreaterThanOrEqual(2)
    expect(new Set(setups.map(({ file }) => file))).toEqual(
      new Set(['ci.yml', 'internal-build.yml'])
    )
    for (const { file, version } of setups) {
      expect(version, `a pnpm/setup step in ${file} pins an exact version`).toMatch(
        /^\d+\.\d+\.\d+$/
      )
    }
    expect(new Set(setups.map(({ version }) => version)).size, 'every job runs the same pnpm').toBe(
      1
    )
  })
})

describe('OS lane per-test timeout on the Windows CI runner (17 §1.8, §1.13)', () => {
  it('[ADR-001] the OS lane applies the ordinary lane timeout policy of this run', () => {
    const policy = windowsCiTestTimeout().testTimeout
    expect(ordinaryConfig.test.testTimeout, 'the ordinary lane follows the policy').toBe(policy)
    expect(osLaneConfig.test.testTimeout, 'the OS lane follows the same policy').toBe(policy)
  })

  it('[ADR-001] the policy raises the timeout on the Windows CI runner only', () => {
    expect(windowsCiTestTimeout('win32', { CI: 'true' })).toEqual({ testTimeout: 30_000 })
    for (const [platform, env] of [
      ['win32', {}],
      ['win32', { CI: 'false' }],
      ['linux', { CI: 'true' }],
      ['darwin', { CI: 'true' }]
    ]) {
      expect(windowsCiTestTimeout(platform, env), `${platform} ${JSON.stringify(env)}`).toEqual({})
    }
  })
})
