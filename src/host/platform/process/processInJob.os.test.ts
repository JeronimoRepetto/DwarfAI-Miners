// L8 OS lane (17 §1.8; here because R17 keeps child_process in host/platform/process): the Host's native in-job read (13 FM-012, S12.04; ISSUE-056) against real processes, Windows
// only. The stub (fixtures/bin/job-probe) reads IsProcessInJob of itself through the Host's binary before it spawns
// anything and again after one plain spawn. Started by the UI's launch helper with job breakaway, as the Host is, it
// is outside every job at start, and libuv puts it into a job of its own at its first spawn (libuv 1.51.0
// src/win/process.c:109): the read must be taken first. Started plainly by this test, it is inside the test runner's
// libuv job, which kills on close (KILL_ON_JOB_CLOSE), and reads in-job from the start.
//
// The binaries are prebuilds/win32-<arch>/ (`pnpm build:native` first); DWARFAI_WIN_PREBUILDS names another folder.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createNativeProcessInJob } from '../endpoint/win-pipe/nativeProcessInJob'
import { WIN_PIPE_BINARY } from '../endpoint/win-pipe/nativeOwnerOnlyPipe'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const PREBUILDS = process.env.DWARFAI_WIN_PREBUILDS ?? join(ROOT, 'prebuilds')
const BINARIES = join(PREBUILDS, `win32-${process.arch}`)
const PROBE = join(ROOT, 'fixtures', 'bin', 'job-probe', 'job-probe.mjs')

const folders: string[] = []
afterEach(() => {
  // The breakaway-started stub may still be closing its answer file: retried, never left behind.
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  }
})

/** Runs the stub to its exit and answers what it wrote to `file` (the stub exits within its own cap). */
async function probe(
  args: string[],
  file: string
): Promise<{ atStart: boolean; afterSpawn: boolean }> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [PROBE, ...args], { stdio: 'ignore', windowsHide: true })
    child.once('error', reject)
    child.once('exit', () => resolve())
  })
  const deadline = Date.now() + 20_000
  while (!existsSync(file)) {
    if (Date.now() >= deadline) {
      const launch = existsSync(`${file}.launch`) ? readFileSync(`${file}.launch`, 'utf8') : 'none'
      throw new Error(`the job probe wrote no answer (launch: ${launch})`)
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return JSON.parse(readFileSync(file, 'utf8')) as { atStart: boolean; afterSpawn: boolean }
}

function outFile(): string {
  const folder = mkdtempSync(join(tmpdir(), 'dwarfai-job-probe-'))
  folders.push(folder)
  return join(folder, 'answer.json')
}

describe.runIf(process.platform === 'win32')('the Host in-job read on Windows (FM-012)', () => {
  // AMENDED (CI run 36974311406; was: breakaway alone, which a runner whose job forbids breakaway refuses with
  // STILL_IN_JOB): the stub is launched the way the launcher launches the Host, breakaway and then WMI when breakaway is
  // refused (windows.ts), and the expectation is unchanged.
  it('[FM-012, S12.04] a process the launcher takes out of the job (breakaway, else WMI) reads not-in-job before its first spawn, and in-job after it', async () => {
    const file = outFile()
    const answer = await probe(
      ['launch', join(BINARIES, 'dwarfai_win_launch.node'), join(BINARIES, WIN_PIPE_BINARY), file],
      file
    )

    expect(answer.atStart, 'outside every job at start').toBe(false)
    expect(answer.afterSpawn, "inside libuv's own job after a plain spawn").toBe(true)
  }, 30_000)

  // The WMI step alone, so the path a runner that forbids breakaway takes is proven on every Windows machine.
  it('[FM-012, S12.04] a process created through WMI reads not-in-job before its first spawn', async () => {
    const file = outFile()
    const answer = await probe(
      ['wmi', join(BINARIES, 'dwarfai_win_launch.node'), join(BINARIES, WIN_PIPE_BINARY), file],
      file
    )

    expect(answer.atStart, 'outside every job at start').toBe(false)
    expect(answer.afterSpawn, "inside libuv's own job after a plain spawn").toBe(true)
  }, 30_000)

  it('[FM-012] a process started plainly inside a KILL_ON_JOB_CLOSE job reads in-job from the start', async () => {
    const file = outFile()
    const answer = await probe(['report', join(BINARIES, WIN_PIPE_BINARY), file], file)

    expect(answer.atStart).toBe(true)
  }, 30_000)

  it('[FM-012] the adapter answers the read of the real binary', () => {
    const read = createNativeProcessInJob({ prebuildsDir: PREBUILDS })()
    expect(read).toEqual({ ok: true, value: expect.any(Boolean) })
  })
})
