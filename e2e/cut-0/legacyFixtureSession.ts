import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAppDatabase, APP_DB_FILENAME } from '../../src/main/appDatabase/appDatabase.ts'
import { createProcessProbe } from '../../src/main/platform/processProbe.ts'
import { createSqliteLaunchedSessionStore } from '../../src/main/sessionLaunch/launchedSessionStore.ts'
import type { IsolatedProfile } from '../_harness/launchApp.ts'

/**
 * A legacy-launched fixture session for the cut-0 Stop everything cases (ISSUE-053, ISSUE-054 L9; 21 §3
 * `LegacyEndFirstAdapter`): a stub process (`fixtures/bin/sleeper`, never a provider CLI, 17 §1.8) written down in the
 * profile's `launched_sessions` exactly as today's runtime writes a launch it made, with the process's own creation
 * time, so today's runtime re-adopts it at start (`LaunchedSessionRegistry.restore`) and owns its identity-checked end.
 * The rows are written with today's own store, before the app starts.
 */
export interface LegacyFixtureSession {
  readonly pid: number
  readonly launchId: string
  /** Whether the process still runs. */
  alive(): boolean
  /** When the process exited (epoch ms), once it did. */
  exitedAt(): number | null
  /** Ends the process if it still runs (the case's own cleanup). */
  dispose(): void
}

const SLEEPER = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'bin',
  'sleeper',
  'sleeper.mjs'
)

/** Starts the stub (it lives at most `maxMs`) and writes it down as a launch of today's runtime in `profile`. */
export async function seedLegacyFixtureSession(
  profile: IsolatedProfile,
  maxMs = 120_000
): Promise<LegacyFixtureSession> {
  const child: ChildProcess = spawn(process.execPath, [SLEEPER, 'sleep', String(maxMs)], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true
  })
  let exitedAt: number | null = null
  child.once('exit', () => (exitedAt = Date.now()))
  const pid = child.pid
  if (pid === undefined) throw new Error('the fixture session did not start')
  const started = await createProcessProbe().processStartTimeMs(pid)
  if (started === null) {
    child.kill()
    throw new Error('the fixture session has no creation time to write down')
  }
  mkdirSync(profile.userDataDir, { recursive: true })
  const database = createAppDatabase({ filePath: path.join(profile.userDataDir, APP_DB_FILENAME) })
  const launchId = 'launch:e2e-fixture'
  try {
    await createSqliteLaunchedSessionStore({ database }).put({
      launchId,
      provider: 'claude',
      sessionId: 'e2e-fixture-session',
      minePath: path.join(profile.root, 'mine'),
      pid,
      processStartTimeMs: started,
      routedByJev: false
    })
  } finally {
    database.close()
  }
  return {
    pid,
    launchId,
    alive: () => exitedAt === null,
    exitedAt: () => exitedAt,
    dispose: () => {
      if (exitedAt === null) child.kill()
    }
  }
}
