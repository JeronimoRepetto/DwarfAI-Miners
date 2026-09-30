import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import defaultConfig from '../../vitest.config.ts'
import osConfig from '../../vitest.os.config.ts'
import { OS_LANE_REPORT } from './os-lane-guard.mjs'

/**
 * L7 check of the lane split (testing strategy `17` §1.8, §5.4; ADR-004).
 *
 * `*.os.test.{ts,mjs}` files under `src/`, `spikes/` and `scripts/` run only in the OS lane
 * (`pnpm test:os`, `vitest.os.config.ts`), never in the default `pnpm test`, which must also run
 * on a machine that cannot run them. The kept spike harnesses under `spikes/` type-check with the
 * rest (`tsconfig.node.json`).
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const OS_TEST_SAMPLES = [
  'src/contracts/__os_smoke__.os.test.ts',
  'src/host/platform/process/tree-kill.os.test.ts',
  'spikes/sp-05/pipe-acl.os.test.ts',
  'spikes/sp-02/host-survival.os.test.mjs',
  'scripts/packaged/fuses.os.test.mjs'
]
const DEFAULT_TEST_SAMPLES = [
  'src/contracts/ipc/registry.test.ts',
  'scripts/checks/quarantine.test.mjs',
  'perf/_harness/runPerf.test.mjs'
]
/** Test-shaped data of another test (17 §2.2 `__fixtures__/`), never a test of either lane. */
const FIXTURE_SAMPLES = [
  'scripts/traceability/__fixtures__/repo/spikes/SP-02/hostSurvivesJob.os.test.ts',
  'scripts/traceability/__fixtures__/repo/src/host/platform/process/processControl.os.test.ts'
]

/** Whether a Vitest `include`/`exclude` pair selects `file` (a repository-relative posix path). */
function selects(testConfig, file) {
  const included = (testConfig.include ?? []).some((glob) => path.matchesGlob(file, glob))
  const excluded = (testConfig.exclude ?? []).some((glob) => path.matchesGlob(file, glob))
  return included && !excluded
}

describe('test lane configs (17 §1.8)', () => {
  it('[ADR-004] the OS-lane config includes the os.test files under src, spikes and scripts, the default config excludes every os.test file, and tsconfig.node.json includes spikes', () => {
    for (const file of OS_TEST_SAMPLES) {
      expect(selects(osConfig.test, file), `the OS lane runs ${file}`).toBe(true)
      expect(selects(defaultConfig.test, file), `pnpm test never runs ${file}`).toBe(false)
    }
    for (const file of DEFAULT_TEST_SAMPLES) {
      expect(selects(defaultConfig.test, file), `pnpm test runs ${file}`).toBe(true)
      expect(selects(osConfig.test, file), `the OS lane does not run ${file}`).toBe(false)
    }
    for (const file of FIXTURE_SAMPLES) {
      expect(selects(osConfig.test, file), `the OS lane does not run the fixture ${file}`).toBe(
        false
      )
      expect(selects(defaultConfig.test, file), `pnpm test does not run the fixture ${file}`).toBe(
        false
      )
    }

    const tsconfig = JSON.parse(readFileSync(path.join(repoRoot, 'tsconfig.node.json'), 'utf8'))
    const typeChecked = (file) => tsconfig.include.some((glob) => path.matchesGlob(file, glob))
    expect(
      typeChecked('spikes/sp-05/pipe-acl.os.test.ts'),
      'tsconfig.node.json includes spikes'
    ).toBe(true)
  })

  it('[ADR-004] the OS-lane config writes the JSON report that the empty-lane guard reads', () => {
    expect(osConfig.test.reporters ?? []).toContain('json')
    expect(osConfig.test.outputFile?.json).toBe(OS_LANE_REPORT)
  })

  it('[ADR-004] tsconfig.node.json type-checks the E2E harness and the Playwright config', () => {
    const tsconfig = JSON.parse(readFileSync(path.join(repoRoot, 'tsconfig.node.json'), 'utf8'))
    const typeChecked = (file) => tsconfig.include.some((glob) => path.matchesGlob(file, glob))
    for (const file of ['e2e/_harness/launchApp.ts', 'e2e/_harness/harness.e2e.ts']) {
      expect(typeChecked(file), `tsconfig.node.json includes ${file}`).toBe(true)
    }
    expect(typeChecked('playwright.config.ts'), 'tsconfig.node.json includes the config').toBe(true)
  })

  it('[ADR-004] neither config configures a retry, so L1-L7 run with zero retries', () => {
    expect(defaultConfig.test.retry ?? 0).toBe(0)
    expect(osConfig.test.retry ?? 0).toBe(0)
  })
})

/**
 * L7 check of the CI workflow (testing strategy `17` §5.1-§5.4; `20` §2.1, §2.5).
 *
 * The workflow cannot run here, so its text is read: the `checks` job runs every required check
 * of `17` §5.2 in the stage order of §5.1, the Linux-only gates carry the Linux condition, the
 * determinism settings of §5.3 are set, nothing may continue on error or retry (§5.4), and every
 * action is pinned by a full commit SHA with its tag in a comment (`20` §2.5).
 */

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

/** The steps of a job's text, each from its `- name:` line to the next step. */
const stepsOf = (job) => job.split(/\n {6}- name: /).slice(1)

/** The required checks in stage order: [check, a command snippet unique to its step, legs]. */
const REQUIRED_CHECKS = [
  ['privacy guard', 'git grep -n -I -E "$PATTERN"', 'all'],
  ['typecheck', 'run: pnpm typecheck\n', 'all'],
  ['lint (ESLint + depcruise)', 'run: pnpm lint\n', 'all'],
  ['format', 'run: pnpm format:check\n', 'all'],
  ['skills in sync', 'node skills/skill-sync/assets/sync.mjs --check', 'all'],
  ['canaries', 'run: pnpm test:canaries\n', 'all'],
  ['print-config test and exception ratchet', 'scripts/checks/eslint-print-config.test.mjs', 'all'],
  ['contract sync', 'node scripts/checks/contract-sync.mjs', 'linux'],
  ['test', 'pnpm test --sequence.shuffle', 'all'],
  ['census', 'node scripts/checks/census-gate.mjs --base', 'linux'],
  ['trace', 'run: pnpm trace:check\n', 'linux'],
  ['quarantine', 'node scripts/checks/quarantine.mjs', 'linux'],
  ['cross-OS parity', 'node scripts/checks/cross-os-parity.mjs', 'linux'],
  ['OS lane', 'run: pnpm test:os\n', 'all'],
  ['empty-lane guard', 'node scripts/checks/os-lane-guard.mjs', 'all'],
  ['build', 'run: pnpm build\n', 'all']
]

const LINUX_ONLY = "if: runner.os == 'Linux'"

describe('CI workflow (17 §5.1, §5.2; 20 §2.5)', () => {
  it('[ADR-004] the checks job runs every required check of 17 §5.2 in stage order, on three OSes or on the Linux leg as listed', () => {
    const job = jobText('checks')
    expect(job).toContain('os: [windows-latest, macos-latest, ubuntu-latest]')
    expect(job).toContain('fail-fast: false')
    const steps = stepsOf(job)
    let previous = -1
    for (const [check, snippet, legs] of REQUIRED_CHECKS) {
      const index = steps.findIndex((step) => step.includes(snippet))
      expect(index, `ci.yml runs the ${check} step`).toBeGreaterThanOrEqual(0)
      expect(index, `the ${check} step comes after the previous check`).toBeGreaterThan(previous)
      previous = index
      const runs = steps.filter((step) => step.includes(snippet)).length
      expect(runs, `the ${check} step appears once`).toBe(1)
      const linuxOnly = steps[index].includes(LINUX_ONLY)
      expect(
        linuxOnly,
        `the ${check} step runs on ${legs === 'linux' ? 'the Linux leg only' : 'every leg'}`
      ).toBe(legs === 'linux')
    }
  })

  it('[ADR-004] ci.yml fixes TZ, LANG and FC_SEED, prints the shuffle seed and never retries or continues on error', () => {
    expect(workflow).toMatch(/\n {2}TZ: UTC\n/)
    expect(workflow).toMatch(/\n {2}LANG: C\.UTF-8\n/)
    expect(workflow).toMatch(/\n {2}FC_SEED: '\d+'\n/)
    const testStep = stepsOf(jobText('checks')).find((step) =>
      step.includes('pnpm test --sequence.shuffle')
    )
    expect(testStep).toMatch(/echo "[^"\n]*seed[^"\n]*\$SEED/i)
    expect(testStep).toContain('--sequence.seed="$SEED"')
    expect(workflow).not.toMatch(/continue-on-error/)
    expect(workflow).not.toMatch(/--retry|retry:/)
  })

  it('[ADR-004] every action in ci.yml is pinned by a full commit SHA with its tag in a comment', () => {
    const uses = workflow.split('\n').filter((line) => /^\s*(?:-\s+)?uses:/.test(line))
    expect(uses.length, 'ci.yml uses actions').toBeGreaterThan(0)
    for (const line of uses) {
      expect(line, 'pinned by SHA with its tag').toMatch(
        /uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/
      )
    }
  })

  it('[ADR-004] ci.yml reads the repository only: no write permission outside the release jobs', () => {
    expect(workflow).toMatch(/\npermissions:\n {2}contents: read\n/)
    expect(jobText('checks')).not.toMatch(/contents: write/)
  })
})
