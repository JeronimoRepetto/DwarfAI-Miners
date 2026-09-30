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
  'scripts/checks/quarantine.test.mjs'
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

  it('[ADR-004] neither config configures a retry, so L1-L7 run with zero retries', () => {
    expect(defaultConfig.test.retry ?? 0).toBe(0)
    expect(osConfig.test.retry ?? 0).toBe(0)
  })
})
