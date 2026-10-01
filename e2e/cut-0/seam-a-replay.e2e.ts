import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { launchApp, type LaunchedApp } from '../_harness/launchApp.ts'
import { withStubs, type StubSetup } from '../_harness/stubs.ts'
import {
  canonicalJson,
  comparable,
  keepOffTheDesktop,
  readScenario,
  recordingFile,
  REPLAY_STUBS,
  replayEnv,
  replayPath,
  runScenario
} from '../../scripts/strangler/seamAReplay.ts'

/**
 * L9, cut 0 (TC-056-02; 21 §2 note 1, the legacy seam-A replay): the scenario of every `legacy` row, recorded on the
 * pre-cut build (`scripts/strangler/record-seam-a.mjs`, today's runtime as the app's entry), is replayed on this build
 * (the UI-main root, its router and `LegacyRuntimeRoute`) against the same simulated fixture world, through the
 * renderer's own `window.api`. Every answer and every push must be byte-equal in canonical form, which masks only the
 * wall-clock fields `WALL_CLOCK_KEYS` names: the router and `LegacyRuntimeRoute` add a hop and nothing else.
 *
 * The recording is per OS (the simulated world's mine ids carry the OS's separator): `recording.<platform>.json`. A
 * missing one fails the case with the step that makes it, so a lane never passes without its comparison.
 */

const RELEASE = 'cut-0'

test.describe.configure({ timeout: 180_000 })

test.describe('cut 0: the legacy seam-A replay (TC-056-02)', () => {
  let launched: LaunchedApp | undefined
  let stubs: StubSetup | undefined

  test.afterEach(async () => {
    await launched?.teardown()
    launched = undefined
    stubs?.dispose()
    stubs = undefined
  })

  test('[ADR-001] every legacy row answers byte-equal to the pre-cut recording, pushes included', async () => {
    const file = recordingFile(RELEASE)
    expect(
      existsSync(file),
      `the pre-cut recording for ${process.platform} (record it on the pre-cut build: ` +
        `node scripts/strangler/record-seam-a.mjs --app <pre-cut build folder>)`
    ).toBe(true)
    const recorded = JSON.parse(readFileSync(file, 'utf8')) as {
      release: string
      platform: string
      calls: unknown[]
      pushes: Record<string, unknown[]>
    }
    expect(recorded.release).toBe(RELEASE)
    expect(recorded.platform).toBe(process.platform)

    const scenario = readScenario(RELEASE)
    stubs = withStubs(REPLAY_STUBS)
    const setup = stubs
    launched = await launchApp({
      stubs: replayPath(setup.stubs),
      pathOnly: true,
      env: (profile) => ({ ...setup.env, ...replayEnv(scenario, profile) }),
      tracePath: test.info().outputPath('trace.zip')
    })
    await keepOffTheDesktop(launched.app)
    const run = await runScenario(launched.window, scenario)

    expect(comparable(run)).toBe(canonicalJson({ calls: recorded.calls, pushes: recorded.pushes }))
    // The comparison covered every call of the scenario and every push row it listens to.
    expect(run.calls).toHaveLength(scenario.calls.length)
    expect(Object.keys(run.pushes).sort()).toEqual(
      scenario.pushes.map((push: { channel: string }) => push.channel).sort()
    )
  })
})
