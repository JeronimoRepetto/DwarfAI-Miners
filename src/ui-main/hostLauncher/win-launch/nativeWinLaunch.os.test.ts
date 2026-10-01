// L8 Windows (17 §1.8): the launch helper win_launch.c, built (`pnpm build:native`) and loaded in
// this process. The Host's survival of the UI's job, end to end, is detach.os.test.ts (the SP-02
// regression test, which also proves the job check: a UI in nested jobs whose breakaway leaves the
// Host in a job); this file proves the helper's own steps: the launch, the refusals, the exit
// watch, release. Every process a case starts is ended in its `finally`.
//
// Whether this test process is in a job that keeps its children depends on what started pnpm
// (libuv's own job lets a grandchild leave it silently), so a breakaway here may launch or be
// refused; both are checked for what they must be.
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BREAKAWAY_CREATION_FLAGS,
  CREATE_SUSPENDED,
  environmentBlock,
  environmentList,
  windowsCommandLine
} from '../windows'
import { loadWinLaunch, type WinLaunchBinding } from './nativeWinLaunch'

const WINDOWS = process.platform === 'win32'
const PREBUILDS = fileURLToPath(new URL('../../../../prebuilds', import.meta.url))
const SYSTEM_ROOT = process.env['SystemRoot'] ?? 'C:\\Windows'
const CMD = join(SYSTEM_ROOT, 'System32', 'cmd.exe')
/** D6 item 3's forbidden flag. */
const DETACHED_PROCESS = 0x0000_0008

function helper(): WinLaunchBinding {
  const loaded = loadWinLaunch({ prebuildsDir: PREBUILDS })
  if (!loaded.ok) throw new Error(`the launch helper did not load: ${loaded.errCode}`)
  return loaded.binding
}

/** `cmd.exe /c exit <code>` started by the helper with `flags`. */
function breakawayExit(binding: WinLaunchBinding, code: number, flags = BREAKAWAY_CREATION_FLAGS) {
  return binding.breakaway(
    CMD,
    `${windowsCommandLine(CMD, ['/d', '/c'])} exit ${code}`,
    SYSTEM_ROOT,
    environmentBlock({ SystemRoot: SYSTEM_ROOT }),
    flags
  )
}

function exitOf(binding: WinLaunchBinding, process: object, ms: number): Promise<number> {
  return new Promise((resolve) => binding.watch(process, ms, resolve))
}

/** A Node child that exits with `code` after `afterMs`; ended by the caller's `finally`. */
function nodeChild(code: number, afterMs: number): ChildProcess {
  return spawn(process.execPath, ['-e', `setTimeout(() => process.exit(${code}), ${afterMs})`], {
    stdio: 'ignore',
    windowsHide: true
  })
}

function end(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) child.kill()
}

describe.runIf(WINDOWS)('the launch helper (ADR-002 D6 item 1, SP-02), built and loaded', () => {
  it('[ADR-002, FM-012] with breakaway the Host is started outside every job and its exit code reaches the watch', async () => {
    const binding = helper()
    const result = breakawayExit(binding, 7)
    if (result.status === 'refused') {
      // An outer job of this machine's shell forbids breakaway: the helper refused rather than
      // leave the child in a job (the WMI step then runs, covered by detach.os.test.ts).
      expect(result.code).toMatch(/^(STILL_IN_JOB|CREATE_5)$/)
      return
    }
    if (result.status !== 'launched' || result.process === null) {
      throw new Error(`breakaway: ${JSON.stringify(result)}`)
    }
    const launched = result.process
    try {
      expect(await exitOf(binding, launched, 10_000)).toBe(7)
    } finally {
      binding.release(launched)
    }
  })

  it('[ADR-002, FM-114] DETACHED_PROCESS and a create that is not suspended are refused before anything starts; a missing file fails the create', () => {
    const binding = helper()
    expect(() => breakawayExit(binding, 0, BREAKAWAY_CREATION_FLAGS | DETACHED_PROCESS)).toThrow(
      TypeError
    )
    expect(() => breakawayExit(binding, 0, BREAKAWAY_CREATION_FLAGS & ~CREATE_SUSPENDED)).toThrow(
      TypeError
    )
    expect(
      binding.breakaway(
        join(SYSTEM_ROOT, 'no-such-launcher.exe'),
        '"no-such-launcher.exe"',
        SYSTEM_ROOT,
        environmentBlock({}),
        BREAKAWAY_CREATION_FLAGS
      )
    ).toEqual({ status: 'failed', code: 'CREATE_2' })
  })

  it('[S12.03, FM-011] a process opened by pid is watched to its exit; one still running when the watch ends reports -1', async () => {
    const binding = helper()
    const exiting = nodeChild(65, 200)
    const running = nodeChild(0, 60_000)
    try {
      const watched = binding.open(exiting.pid ?? -1)
      if (watched === null) throw new Error('open(pid) found no process')
      try {
        expect(await exitOf(binding, watched, 10_000)).toBe(65)
      } finally {
        binding.release(watched)
      }
      const outlived = binding.open(running.pid ?? -1)
      if (outlived === null) throw new Error('open(pid) found no process')
      try {
        expect(await exitOf(binding, outlived, 100)).toBe(-1)
      } finally {
        binding.release(outlived)
      }
      expect(binding.open(0x7ffffff0)).toBeNull()
    } finally {
      end(exiting)
      end(running)
    }
  })

  // ADDED (fix: FM-009 LAUNCHER_TIMEOUT, CI run 36889737566): the WMI create (D6 item 2) runs in
  // this process now, not in a Windows PowerShell step whose cold start outran the launch timeout.
  it('[ADR-002, FM-012] the WMI create starts the process with exactly the given environment and working folder, and its pid is opened to watch its exit', async () => {
    const binding = helper()
    const dir = mkdtempSync(join(tmpdir(), 'dw-wmi-'))
    const report = join(dir, 'report.json')
    const script = [
      "const { writeFileSync } = require('node:fs')",
      'writeFileSync(process.argv[1], JSON.stringify({ probe: process.env.DWARFAI_WMI_PROBE,',
      '  names: Object.keys(process.env).map((name) => name.toUpperCase()), cwd: process.cwd() }))',
      'setTimeout(() => process.exit(7), 1500)'
    ].join('\n')
    let pid = 0
    try {
      const result = await binding.wmiCreate(
        windowsCommandLine(process.execPath, ['-e', script, report]),
        dir,
        environmentList({ SystemRoot: SYSTEM_ROOT, DWARFAI_WMI_PROBE: 'wmi-ok' })
      )
      expect(result.status, JSON.stringify(result)).toBe('launched')
      pid = result.status === 'launched' ? result.pid : 0
      const watched = binding.open(pid)
      if (watched === null) throw new Error('open(pid) found no process')
      try {
        expect(await exitOf(binding, watched, 20_000)).toBe(7)
      } finally {
        binding.release(watched)
      }
      const seen = JSON.parse(readFileSync(report, 'utf8')) as {
        probe?: string
        names: string[]
        cwd: string
      }
      expect(seen.probe).toBe('wmi-ok')
      expect(seen.names, 'only the given environment, not the WMI service one').not.toContain(
        'PATH'
      )
      expect(seen.cwd.toLowerCase()).toBe(dir.toLowerCase())
    } finally {
      if (pid !== 0) {
        try {
          process.kill(pid)
        } catch {
          // already gone
        }
      }
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  })

  it('[ADR-002, FM-012] a WMI create that Win32_Process.Create refuses answers refused with its ReturnValue and starts nothing', async () => {
    const binding = helper()
    const missing = join(SYSTEM_ROOT, 'no-such-launcher.exe')
    expect(
      await binding.wmiCreate(windowsCommandLine(missing, []), SYSTEM_ROOT, [
        `SystemRoot=${SYSTEM_ROOT}`
      ])
    ).toEqual({ status: 'refused', code: 'WMI_9' })
    expect(() => binding.wmiCreate('x', SYSTEM_ROOT, [1] as never)).toThrow(TypeError)
  })

  it('[S12.03] release ends the watch: the exit is not reported afterwards, and the process runs on', async () => {
    const binding = helper()
    const child = nodeChild(3, 300)
    try {
      const watched = binding.open(child.pid ?? -1)
      if (watched === null) throw new Error('open(pid) found no process')
      const reported: number[] = []
      binding.watch(watched, 10_000, (code) => reported.push(code))
      binding.release(watched)
      expect(child.exitCode, 'the process is not ended by release').toBeNull()
      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve))
      expect(code).toBe(3)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(reported).toEqual([])
    } finally {
      end(child)
    }
  })
})
