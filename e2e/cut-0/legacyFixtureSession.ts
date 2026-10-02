import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
  // Detached on POSIX, as today's runtime spawns a launch (`launchRunner.ts`): the process leads its own group, which
  // is what today's end signals there (`kill -TERM -- -<pid>`, `processEnd.ts`). On Windows the end is `taskkill /T` by
  // pid, and a detached child would only lose its console.
  const child: ChildProcess = spawn(process.execPath, [SLEEPER, 'sleep', String(maxMs)], {
    stdio: ['pipe', 'ignore', 'ignore'],
    windowsHide: true,
    detached: process.platform !== 'win32'
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

/**
 * A `PATH` on which today's runtime finds its process probe but not its kill, so its identity-checked end of a launch
 * is refused (`processEnd.ts`: a kill that could not run answers false, `LaunchedSessionRegistry.end` → `'refused'`)
 * while nothing is ever signalled. An identity mismatch is not a refusal: today's runtime drops such a row at start and
 * answers `'already-ended'` at end (`launchedSessions.ts` `restore`, `end`).
 *
 * - Windows: the probe is `powershell.exe` (its own folder), the kill `taskkill` (`System32`, left out).
 * - Linux and macOS: the probe is `cat` (Linux) or `ps` (macOS), linked into a folder of their own; `kill` is left out.
 *
 * The Node that runs the stubs comes along. Answers the folders and a cleanup for the one this makes on POSIX.
 */
export function pathWithoutKill(): { path: string; dispose(): void } {
  const node = path.dirname(process.execPath)
  if (process.platform === 'win32') {
    const systemRoot = process.env.SystemRoot ?? String.raw`C:\Windows`
    const powershell = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0')
    return { path: [powershell, node].join(path.delimiter), dispose: () => {} }
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'dwarfai-e2e-nokill-'))
  const tool = process.platform === 'linux' ? 'cat' : 'ps'
  const found = ['/bin', '/usr/bin'].map((folder) => path.join(folder, tool)).find(existsSync)
  if (found === undefined) throw new Error(`no ${tool} to probe with`)
  symlinkSync(found, path.join(dir, tool))
  return {
    path: [dir, node].join(path.delimiter),
    dispose: () => rmSync(dir, { recursive: true, force: true })
  }
}
