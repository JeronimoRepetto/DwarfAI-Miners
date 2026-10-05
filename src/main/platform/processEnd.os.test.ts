// L8 OS lane (17 §1.8): today's launched-session end (`createProcessEnd().endProcessTree`, the kill behind
// `LaunchedSessionRegistry.end` and the cut-0 `LegacyEndFirstAdapter`, 21 §3) against real stub processes. Runs only in
// `pnpm test:os`, one describe per OS family. A launch is spawned detached (`launchRunner.ts`), so on POSIX its process
// leads a group that its children inherit; the stub tree here is spawned the same way. Every process is started by the
// test, and the cleanup ends only those it started.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createProcessEnd } from './processEnd'
import { createProcessProbe, sameProcessStart } from './processProbe'

const TREE = fileURLToPath(new URL('../../../fixtures/bin/tree/tree.mjs', import.meta.url))
const SLEEPER = fileURLToPath(new URL('../../../fixtures/bin/sleeper/sleeper.mjs', import.meta.url))
const CAP_MS = 60_000

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (alive(pid)) {
    if (Date.now() >= deadline) return false
    await sleep(50)
  }
  return true
}

function endCases(): void {
  const children: ChildProcess[] = []
  /** The tree's descendants by identity: pid and start time, read while they ran (ADR-014). */
  const descendants: Array<{ pid: number; startMs: number }> = []
  const folders: string[] = []
  const startTimes = createProcessProbe()

  afterEach(async () => {
    for (const child of children.splice(0)) {
      child.stdin?.end()
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    // The tree's own descendants, ended only while each pid is still the process recorded: a pid
    // the OS handed on, or one whose start time cannot be read, is never signalled.
    for (const { pid, startMs } of descendants.splice(0)) {
      const now = await startTimes.processStartTimeMs(pid)
      if (now === null || !sameProcessStart(now, startMs)) continue
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // ended meanwhile
      }
    }
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })

  /** A launch's shape: a detached root with a child and a grandchild; answers the three pids once all run. */
  async function startLaunchTree(): Promise<{ root: number; child: number; grandchild: number }> {
    const folder = mkdtempSync(join(tmpdir(), 'dwarfai-process-end-'))
    folders.push(folder)
    const record = join(folder, 'tree.txt')
    const root = spawn(process.execPath, [TREE, 'root', record, String(CAP_MS)], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      detached: true
    })
    children.push(root)
    const deadline = Date.now() + 15_000
    for (;;) {
      let text = ''
      try {
        text = readFileSync(record, 'utf8')
      } catch {
        // not written yet
      }
      const roles = new Map(
        text
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => {
            const [role, pid] = line.trim().split(' ')
            return [role, Number(pid)] as const
          })
      )
      const [r, c, g] = [roles.get('root'), roles.get('child'), roles.get('grandchild')]
      if (r !== undefined && c !== undefined && g !== undefined) {
        for (const pid of [c, g]) {
          const startMs = await startTimes.processStartTimeMs(pid)
          if (startMs !== null) descendants.push({ pid, startMs })
        }
        return { root: r, child: c, grandchild: g }
      }
      if (Date.now() >= deadline) throw new Error(`the stub tree did not start: ${text}`)
      await sleep(50)
    }
  }

  it('[ADR-014] ending a detached launch ends its whole tree and answers true', async () => {
    const tree = await startLaunchTree()

    await expect(createProcessEnd().endProcessTree(tree.root)).resolves.toBe(true)

    for (const pid of [tree.root, tree.child, tree.grandchild]) {
      expect(await goneWithin(pid, 10_000), `pid ${pid} of the tree ended`).toBe(true)
    }
  })
}

describe.runIf(process.platform === 'win32')('endProcessTree on Windows (taskkill /T)', endCases)

describe.runIf(process.platform !== 'win32')(
  'endProcessTree on Linux and macOS (kill -TERM -- -<pgid>)',
  () => {
    endCases()

    const strays: ChildProcess[] = []
    afterEach(() => {
      for (const child of strays.splice(0)) child.kill('SIGKILL')
    })

    // A pid that leads no group is never reported ended: procps-ng's `kill`, handed `-<pid>` without `--`, signalled
    // the group of the pid's first digit and exited 0 (processEnd.test.ts), so this answered true with the process
    // still running, and a session whose end was refused looked ended.
    it('[ADR-014] a pid that leads no process group answers false and is left running', async () => {
      const stray = spawn(process.execPath, [SLEEPER, 'sleep', String(CAP_MS)], {
        stdio: ['pipe', 'ignore', 'ignore'],
        shell: false
      })
      strays.push(stray)
      const pid = stray.pid
      if (pid === undefined) throw new Error('the stub did not start')

      await expect(createProcessEnd().endProcessTree(pid)).resolves.toBe(false)

      await sleep(300)
      expect(alive(pid), 'the stub keeps running').toBe(true)
    })
  }
)
