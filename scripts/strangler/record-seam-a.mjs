#!/usr/bin/env node
// Records the legacy seam-A replay of a release on a given build (21 §2 note 1; ISSUE-056): every `legacy` row of the
// scenario, request → answer, and the pushes the fixture world sends meanwhile, written scrubbed and canonical to
// `fixtures/ipc/seam-a-replay/<release>/recording.json` (17 §1.4). The recording is made on the build BEFORE the cut,
// whose entry is today's runtime; `e2e/cut-0/seam-a-replay.e2e.ts` replays it on the cut build.
//
//   node scripts/strangler/record-seam-a.mjs --app <built app folder> [--release cut-0] [--out <file>]
//
// The file is `recording.<platform>.json`: one per OS, made on that OS (the simulated world's mine ids carry its path
// separator).
//
// `--app` is the folder of a built checkout (`pnpm build` done there), launched as the packaged app is, from its own
// `package.json` `main`. Electron is this repository's. The app runs under the E2E harness's isolated profile, with its
// `-r` guard (no modal box), with every per-user folder pointed into the profile and the OS pickers answering
// "cancelled" (`seamAReplay.ts`), so nothing outside the profile is read or written. Not run in CI: a maintainer
// records once per cut, on the build the cut starts from; regenerating the file is a reviewed diff.
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { launchApp } from '../../e2e/_harness/launchApp.ts'
import { withStubs } from '../../e2e/_harness/stubs.ts'
import {
  canonicalJson,
  comparableRun,
  keepOffTheDesktop,
  readScenario,
  recordingFile,
  REPLAY_STUBS,
  replayEnv,
  replayPath,
  runScenario
} from './seamAReplay.ts'

function option(name, fallback) {
  const at = process.argv.indexOf(name)
  if (at === -1) return fallback
  const value = process.argv[at + 1]
  if (value === undefined || value.startsWith('--')) throw new Error(`${name} needs a value`)
  return value
}

const appDir = option('--app')
if (appDir === undefined) {
  console.error(
    'usage: node scripts/strangler/record-seam-a.mjs --app <built app folder> [--release cut-0]'
  )
  process.exit(2)
}
const release = option('--release', 'cut-0')
const out = path.resolve(option('--out', recordingFile(release)))
const scenario = readScenario(release)

const stubs = withStubs(REPLAY_STUBS)
const launched = await launchApp({
  appDir: path.resolve(appDir),
  stubs: replayPath(stubs.stubs),
  pathOnly: true,
  // The home folders point into the profile, which the harness removes.
  env: (profile) => ({ ...stubs.env, ...replayEnv(scenario, profile) })
})
let failure
try {
  await keepOffTheDesktop(launched.app)
  const run = await runScenario(launched.window, scenario)
  mkdirSync(path.dirname(out), { recursive: true })
  writeFileSync(out, canonicalJson({ release, platform: process.platform, ...comparableRun(run) }))
  console.log(
    `recorded ${run.calls.length} calls and ${Object.keys(run.pushes).length} push rows into ${out}`
  )
} catch (error) {
  failure = error
} finally {
  await launched.teardown().catch((error) => (failure ??= error))
  stubs.dispose()
}
if (failure !== undefined) {
  console.error(failure)
  process.exit(1)
}
