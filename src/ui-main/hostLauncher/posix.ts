// POSIX detach (ADR-002 D6; 13 FM-012, FM-114): the Host starts in a new session (`detached: true`,
// which calls setsid), so it leaves the UI's process group and controlling terminal and outlives
// the UI being killed with its group. Its stdin, stdout and stderr are not captured, as on Windows
// (windows.ts: clean stdio), and the child is unref'd so the UI's event loop never waits on it.
// `shell: false` (R17).
//
// No stdio file is kept (cut-0 conformance, 19 §7; 09 §1 lists no such file under `run/`): the
// Host's own records, uncaught errors and a missing data directory included, go to its log
// segments through the logger (19 §9.1), and raw runtime output is never written anywhere. What a
// Host that dies before its logger exists leaves is its exit code, which the launcher logs
// (`host.spawn`, FM-008).
//
// While the UI runs it sees the Host's exit (Node reports it even for a detached, unref'd child):
// a signal death is reported as 128 + the signal number, the shell convention.
import { spawn } from 'node:child_process'
import { constants } from 'node:os'
import type { HostSpawner, LaunchOutcome, LaunchedHost } from './ports'
import type { SpawnProcess } from './windows'

export interface PosixSpawnerOptions {
  spawnProcess?: SpawnProcess
}

export function createPosixSpawner(options: PosixSpawnerOptions = {}): HostSpawner {
  const spawnProcess = options.spawnProcess ?? spawn
  return (request) =>
    new Promise<LaunchOutcome>((resolve) => {
      let reportExit: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((done) => {
        reportExit = done
      })
      try {
        const child = spawnProcess(request.file, request.args, {
          detached: true,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          env: { ...request.env },
          cwd: request.cwd
        })
        child.unref()
        const host: LaunchedHost = {
          how: 'detached',
          exited,
          release: () => reportExit(null)
        }
        child.once('spawn', () => resolve({ kind: 'launched', host }))
        child.once('error', (error) => {
          resolve({ kind: 'failed', errCode: errorCode(error) })
          reportExit(null)
        })
        child.once('exit', (code, signal) => {
          reportExit(code ?? (signal === null ? null : 128 + (constants.signals[signal] ?? 0)))
        })
      } catch (error) {
        resolve({ kind: 'failed', errCode: errorCode(error) })
      }
    })
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : 'SPAWN_ERROR'
}
