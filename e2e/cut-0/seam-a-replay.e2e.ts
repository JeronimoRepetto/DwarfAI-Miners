import { existsSync, readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { launchApp, type LaunchedApp } from '../_harness/launchApp.ts'
import { withStubs, type StubSetup } from '../_harness/stubs.ts'
import { ROUTES } from '../../src/ui-main/ipc/routes.ts'
import {
  canonicalJson,
  comparable,
  keepOffTheDesktop,
  legacyTodayPart,
  readScenario,
  recordingFile,
  type Recorded,
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
 *
 * From cut 1 on (ISSUE-123), the build replays only the rows its route table (`ROUTES`) still routes `legacy` with
 * today's shape, against the same cut-0 recording (`legacyTodayPart`): those rows answer as the pre-cut build did,
 * which is what this case proves. A row the release moved to the Host or `ui-local` (A-12, A-15, A-19, A-20, A-30…A-32,
 * A-34, A-44, A-P2), reshaped (A-33 through `ResetFanout`) or retired (A-14, A-16…A-18, A-P5) leaves the comparison;
 * its parity is `docs/strangler/parity-cut-1.md`. No new recording is needed: the pre-cut build of a later release
 * answers those rows exactly as the cut-0 recording says (cut 0's own replay proved it).
 *
 * A-40 and A-41 leave it too: from cut 1 they reach today's runtime through `LegacyAskRelay`, whose ask ids live in its
 * own `legacy:` namespace (21 §3), so the recording's ask id, a today id, is stale and dropped before today's runtime
 * with today's "no longer open" answer (ADR-010 item 5). That is an intended difference of parity-cut-1; the relayed
 * answers reaching today's runtime unchanged are the legacy-row parity of `boardParity.cut-1.test.ts`.
 */

const RELEASE = 'cut-0'

/** The rows whose ask ids `LegacyAskRelay` namespaces from cut 1 (21 §3): not comparable with today's ids. */
const RELAYED_ASK_ROWS: readonly string[] = ['agent:answerQuestion', 'agent:answerPermission']

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
    const recording = JSON.parse(readFileSync(file, 'utf8')) as Recorded & {
      release: string
      platform: string
    }
    expect(recording.release).toBe(RELEASE)
    expect(recording.platform).toBe(process.platform)

    const { scenario, recorded } = legacyTodayPart(
      readScenario(RELEASE),
      recording,
      ROUTES.filter((route) => !RELAYED_ASK_ROWS.includes(route.channel))
    )
    expect(scenario.calls.length, 'the table still routes some rows legacy').toBeGreaterThan(0)
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
