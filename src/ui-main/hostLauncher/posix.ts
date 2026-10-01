// POSIX detach (ADR-002 D6; 13 FM-012, FM-114): the Host starts in a new session (`detached: true`,
// which calls setsid), so it leaves the UI's process group and controlling terminal and outlives
// the UI being killed with its group. Its stdout and stderr go to a file, stdin is closed, and the
// child is unref'd so the UI's event loop never waits on it. `shell: false` (R17).
//
// The stdio file is `<hostDataDir>/run/host-stdio.log` (decision recorded in the hand-off: the
// package names "the Host log file" without a path; the Host's own records go to its log segments
// through the logger, so this file only catches what the runtime itself prints, such as a crash
// before the logger exists). It is outside `logs/`, so raw runtime output never enters a
// diagnostics bundle, it is created `0600` in a `0700` folder, and it is started afresh once it
// grows past STDIO_FILE_MAX_BYTES.
//
// While the UI runs it sees the Host's exit (Node reports it even for a detached, unref'd child):
// a signal death is reported as 128 + the signal number, the shell convention.
import { spawn } from 'node:child_process'
import { closeSync, mkdirSync, openSync, statSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname } from 'node:path'
import type { HostSpawner, LaunchOutcome, LaunchedHost } from './ports'
import type { SpawnProcess } from './windows'

/** The stdio file is truncated before a spawn once it is larger than this. */
export const STDIO_FILE_MAX_BYTES = 1_048_576

export interface PosixSpawnerOptions {
  spawnProcess?: SpawnProcess
  /** Where the Host's stdout and stderr go. */
  stdioFile: string
}

export function createPosixSpawner(options: PosixSpawnerOptions): HostSpawner {
  const spawnProcess = options.spawnProcess ?? spawn
  return (request) =>
    new Promise<LaunchOutcome>((resolve) => {
      let fd: number
      try {
        fd = openStdioFile(options.stdioFile)
      } catch (error) {
        resolve({ kind: 'failed', errCode: errorCode(error) })
        return
      }
      let reportExit: (code: number | null) => void = () => {}
      const exited = new Promise<number | null>((done) => {
        reportExit = done
      })
      try {
        const child = spawnProcess(request.file, request.args, {
          detached: true,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', fd, fd],
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
      } finally {
        // The child holds its own copy of the descriptor.
        closeSync(fd)
      }
    })
}

function openStdioFile(path: string): number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  let size = 0
  try {
    size = statSync(path).size
  } catch {
    // no file yet
  }
  return openSync(path, size > STDIO_FILE_MAX_BYTES ? 'w' : 'a', 0o600)
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : 'SPAWN_ERROR'
}
