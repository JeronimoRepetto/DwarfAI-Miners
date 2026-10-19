import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * A legacy-launched fixture session for the cut-0 Stop everything cases (ISSUE-053, ISSUE-054 L9; 21 §3
 * `LegacyEndFirstAdapter`): a stub process (`fixtures/bin/sleeper`, never a provider CLI, 17 §1.8) written down in the
 * profile's `launched_sessions` exactly as today's runtime writes a launch it made, with the process's own creation
 * time, so today's runtime re-adopts it at start (`LaunchedSessionRegistry.restore`) and owns its identity-checked end.
 * AMENDED for ISSUE-249, the cut-5 close (was: the row written into the profile's `projects-v1.db` `launched_sessions`
 * before the app starts, through `e2e/_harness/legacyLaunchedSessions.ts`): today's runtime and every reader of that
 * file left the tree (ISSUE-243, ISSUE-244; 21 §5.3), so the case starts the stub alone and no code touches the file.
 */
export interface LegacyFixtureSession {
  readonly pid: number
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

/** Starts the stub (it lives at most `maxMs`); since ISSUE-249 nothing is written down for it. */
export async function seedLegacyFixtureSession(maxMs = 120_000): Promise<LegacyFixtureSession> {
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
  return {
    pid,
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
