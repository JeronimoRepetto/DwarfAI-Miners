// L8 OS lane (17 §1.8): `ProcessControl.listProcesses` (owner amendment I) against real stub
// processes, the contract's listing case on each OS. Runs only in `pnpm test:os`. The processes are
// the sleeper stub (stem `sleeper`) and a plain node process, never a provider CLI; both are ended
// through their own stdin (they exit), never by pid.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import type { SpawnedProcess } from '../../kernel/ports/processControl'
import { NodeProcessControl } from './NodeProcessControl'

const SLEEPER = fileURLToPath(
  new URL('../../../../fixtures/bin/sleeper/sleeper.mjs', import.meta.url)
)

/** A node process carrying no `sleeper` stem, that exits when its stdin ends (or after 20 s). */
const OTHER_PROGRAM =
  "process.stdin.on('end', () => process.exit(0)); process.stdin.resume(); setTimeout(() => process.exit(0), 20000)"

/** The two spellings name one folder: separators, a trailing separator and, where the OS folds, case. */
function sameFolder(listed: string, folder: string): boolean {
  const norm = (path: string): string => {
    const unified = posix.normalize(path.replace(/\\/g, '/')).replace(/\/+$/, '')
    return process.platform === 'linux' ? unified : unified.toLowerCase()
  }
  return norm(listed) === norm(folder)
}

function listingCases(): void {
  const started: SpawnedProcess[] = []
  const folders: string[] = []

  afterEach(async () => {
    // Leave nothing running: each stub exits when its stdin ends.
    for (const child of started.splice(0)) {
      child.stdin?.end()
      await Promise.race([
        child.exited.catch(() => null),
        new Promise((resolve) => setTimeout(resolve, 5_000))
      ])
    }
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  })

  const folder = (): string => {
    const made = realpathSync.native(mkdtempSync(join(tmpdir(), 'dwarfai-list-')))
    folders.push(made)
    return made
  }

  const start = async (control: NodeProcessControl, cwd: string, args: string[]) => {
    const child = control.spawn({
      executable: process.execPath,
      args,
      env: {},
      cwd,
      processGroup: 'inherit',
      stdio: 'pipe'
    })
    started.push(child)
    await child.identity
  }

  it('[INV-51, FM-059] listProcesses names the sleeper stub in its own working folder, and nothing in the folder of a process carrying no stem', async () => {
    const control = new NodeProcessControl()
    const here = folder()
    const there = folder()
    await start(control, here, [SLEEPER, 'sleep', '20000'])
    await start(control, there, ['-e', OTHER_PROGRAM])

    const listed = await control.listProcesses({ stems: ['sleeper'] })

    expect(listed).not.toBe('unreadable')
    const rows = listed as ReadonlyArray<{ stem: string; cwd: string | null }>
    expect(rows.every((row) => row.stem === 'sleeper')).toBe(true)
    expect(rows.filter((row) => row.cwd !== null && sameFolder(row.cwd, here))).toHaveLength(1)
    expect(rows.filter((row) => row.cwd !== null && sameFolder(row.cwd, there))).toEqual([])
    expect(await control.listProcesses({ stems: ['dwarfai-no-process-has-this-stem'] })).toEqual([])
  }, 60_000)
}

/**
 * A process every machine of the OS runs under a system account, never as the person: Windows'
 * `wininit` (a session-0 service process) and macOS's `launchd` (pid 1, root). Linux has no such
 * name that a person's own `systemd --user` cannot share, so its rule is proven at L3 only.
 */
function systemProcessCase(stem: string): () => void {
  return () => {
    it(`[INV-51, FM-059] listProcesses lists no process of another OS account: the system's ${stem} carries the stem and is not listed`, async () => {
      expect(await new NodeProcessControl().listProcesses({ stems: [stem] })).toEqual([])
    }, 60_000)
  }
}

describe.runIf(process.platform === 'win32')('listProcesses on Windows', listingCases)
describe.runIf(process.platform === 'win32')(
  'listProcesses on Windows: system processes',
  systemProcessCase('wininit')
)
describe.runIf(process.platform === 'darwin')('listProcesses on macOS', listingCases)
describe.runIf(process.platform === 'darwin')(
  'listProcesses on macOS: system processes',
  systemProcessCase('launchd')
)
describe.runIf(process.platform === 'linux')('listProcesses on Linux', listingCases)
