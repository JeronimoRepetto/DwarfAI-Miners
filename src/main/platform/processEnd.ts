import { execFile } from 'node:child_process'
import type { Platform } from './platform'
import { currentPlatform } from './platform'

/**
 * Ending a process TREE — the one act the panel had no way to perform (#217).
 *
 * A launch is deliberately detached and deliberately more than one process:
 * the panel spawns a console-hosting intermediary, which spawns the real CLI,
 * which spawns whatever its tools need (see launchRunner's comment block for
 * the measured Win32 reasoning). So "end the session" is never one signal to
 * one pid, and how a tree is ended is the one part of it that differs per OS.
 *
 * Pure builder, thin runner, exactly like processProbe beside it: the argv is a
 * value a test asserts on every platform, and only the spawn is integration
 * territory. Verified live on Windows 11 / Node v24.11.1 against a rebuilt
 * copy of the real launch shape — intermediary, program and grandchild all
 * gone, and the retained handle's own `exit` observed firing.
 */

/** One kill command, as an argv pair that never goes through a shell. */
export interface EndProcessCommand {
  command: string
  args: string[]
}

/** Runs one kill command; rejects when it could not be run or refused. */
export type EndProcessRunner = (command: EndProcessCommand) => Promise<void>

export interface ProcessEndPort {
  /**
   * End the process at `pid` and everything below it. True means the platform
   * reported the tree gone; false covers every other answer — a refusal, a
   * missing tool, a pid no command may be built for — and callers must report
   * it as a failure rather than as a session ended.
   */
  endProcessTree(pid: number): Promise<boolean>
}

/**
 * The kill command for one platform, or null when `pid` is not a pid.
 *
 * Windows kills by tree because the tree is the point: `taskkill /T` walks the
 * live parent/child rows at kill time, so it reaches the CLI's own tool
 * processes, which no job object of ours holds. (Measured: killing only the
 * intermediary happens to take the tree with it too, because libuv gives every
 * non-detached child a KILL_ON_JOB_CLOSE job and the cascade runs down the
 * chain — but that holds only for as long as every link spawns through libuv,
 * and the CLI's own children do not.)
 *
 * POSIX signals the process GROUP — the negative pid — because `detached`
 * makes the process this panel started a group leader and its children inherit
 * that group. A plain `kill <pid>` would end the intermediary and leave the
 * real program orphaned but running, which is the current bug rather than a
 * fix for it. Unverified on a real macOS or Linux host, like the osascript
 * path beside it; the argv is what is asserted.
 *
 * Null for anything that is not a real positive integer pid, and that guard is
 * the whole reason this returns a value rather than a string: `kill -TERM -1`
 * signals every process the user owns, and group 0 is the PANEL's own.
 */
export function buildEndProcessTreeCommand(
  platform: Platform,
  pid: number
): EndProcessCommand | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  if (platform === 'win32') {
    return { command: 'taskkill', args: ['/PID', String(pid), '/T', '/F'] }
  }
  return { command: 'kill', args: ['-TERM', `-${pid}`] }
}

function runEndCommand(kill: EndProcessCommand): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(kill.command, kill.args, { timeout: 5_000, windowsHide: true }, (error) => {
      // Unlike a probe, a non-zero exit here is a real failure and not an
      // answer: taskkill exits 128 for a pid it cannot find, and reporting
      // that as an ended session is precisely the exit-0-shaped lie.
      if (error !== null) {
        reject(error)
        return
      }
      resolve()
    })
  })
}

export interface ProcessEndOptions {
  platform?: Platform
  /** Injected for tests; defaults to a real child-process run. */
  run?: EndProcessRunner
}

/** The process-ending port for one platform. Nothing runs until it is asked. */
export function createProcessEnd(options: ProcessEndOptions = {}): ProcessEndPort {
  const platform = options.platform ?? currentPlatform()
  const run = options.run ?? runEndCommand
  return {
    async endProcessTree(pid: number): Promise<boolean> {
      const kill = buildEndProcessTreeCommand(platform, pid)
      if (kill === null) return false
      try {
        await run(kill)
        return true
      } catch {
        // Missing binary, timeout, access denied, no such process — all
        // reported as "it did not happen", never as an ended session.
        return false
      }
    }
  }
}
