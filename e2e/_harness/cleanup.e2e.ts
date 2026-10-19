import { existsSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { launchApp, processesNaming } from './launchApp.ts'

/**
 * L9 smoke of the E2E harness's cleanup (testing strategy `17` §1.9; ISSUE-056): from cut 0 every launched app starts a
 * DwarfAI Host for its profile, and on Windows the process Playwright spawns is not the app's browser process, so an
 * app can still be writing its profile, and its Host still starting, when the spawned process has exited. A teardown
 * leaves no process that names the profile's folders and no folder of the profile behind, however early it comes.
 */

// The harness self-test runs once: a retry would hide a harness defect (17 §5.4).
test.describe.configure({ retries: 0, timeout: 120_000 })

test('[ADR-002] a teardown while the Host is still starting leaves no process and no folder of the profile behind', async () => {
  const launched = await launchApp({ tracePath: test.info().outputPath('trace.zip') })
  const { profile } = launched

  // Right away: the Host is being copied and started for this profile.
  await launched.teardown()
  // Long enough for a Host that was starting to have written its run files, and for a closing browser process to
  // have written its last profile files.
  await new Promise((resolve) => setTimeout(resolve, 8_000))

  expect(processesNaming(profile.root), 'no process names the profile').toEqual([])
  expect(processesNaming(profile.dataRoot), 'no process names its data root').toEqual([])
  expect(existsSync(profile.root), 'the profile is removed').toBe(false)
  expect(existsSync(profile.dataRoot), 'its data root is removed').toBe(false)
})
