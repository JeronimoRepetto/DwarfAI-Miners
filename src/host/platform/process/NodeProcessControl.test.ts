import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import { RecordingDiagnosticsLog } from '../../kernel/fakes/RecordingDiagnosticsLog'
import type { SpawnedProcess } from '../../kernel/ports/processControl'
import {
  runProcessControlContract,
  type KillWorld
} from '../../kernel/testing/processControl.contract'
import {
  NodeProcessControl,
  OS_ADDED_ENV,
  BOOT_ID_QUERY_TIMEOUT_MS,
  START_TIME_QUERY_TIMEOUT_MS,
  createQueryRunner,
  type NodeSpawn,
  type OsProcessReader,
  type QueryRunner
} from './NodeProcessControl'
import { createDarwinReader, parseDarwinLstart } from './probe/darwin'
import { createLinuxReader, parseLinuxStartTime } from './probe/linux'
import { WIN32_BOOT_ID_KEY, createWin32Reader, filetimeToEpochMs } from './probe/win32'
import { windowsPowerShell, windowsSystemTool } from './probe/types'
import { createDarwinBootSources } from './bootIdentity/darwin'
import { createSnapshotReader } from './kill/snapshot'
import { createWin32BootSources } from './bootIdentity/win32'
import {
  FAILING_READER,
  SCRIPTED_BOOT,
  ScriptedOs,
  scriptedBootSources,
  type ScriptedPlatform
} from './testing/ScriptedOs'

const SLEEPER = fileURLToPath(
  new URL('../../../../fixtures/bin/sleeper/sleeper.mjs', import.meta.url)
)
// Above every pid limit of the three OSes (Linux pid_max ≤ 4 194 304, macOS 99 999, Windows pids
// fit well below it in practice) and still a valid argument for process.kill.
const ABSENT_PID = 2_147_483_000
const BOOT = '6f1c2d0e-1b2a-4c3d-9e8f-0a1b2c3d4e5f'
const OWN_PID = 4_000
const UNREADABLE_PID = 4_001
const T0 = 1_790_000_000_000
const OWNED = { graceMs: 3_000, group: 'owned' } as const
const FOREIGN = { graceMs: 3_000, group: 'foreign' } as const
const ROOT = { pid: 100, processStartTimeMs: T0, bootId: SCRIPTED_BOOT }

/** A NodeProcessControl whose every OS primitive is the scripted OS's. */
function scriptedControl(
  os: ScriptedOs,
  diagnostics?: RecordingDiagnosticsLog
): NodeProcessControl {
  return new NodeProcessControl({
    platform: os.platform,
    reader: os.reader,
    signalZero: os.signalZero,
    sendSignal: os.sendSignal,
    runCommand: os.runCommand,
    snapshot: os.snapshot,
    scheduler: os.scheduler,
    bootSources: scriptedBootSources('working'),
    ...(diagnostics === undefined ? {} : { diagnostics })
  })
}

/** A root at T0 with a child and a grandchild, all in the root's process group. */
function scriptedTree(
  platform: ScriptedPlatform,
  root: { endsOn?: 'term' | 'kill' | 'never'; pgid?: number } = {}
): ScriptedOs {
  const os = new ScriptedOs(platform)
  os.add({ pid: 100, ppid: 1, startTimeMs: T0, ...root })
  os.add({ pid: 101, ppid: 100, pgid: root.pgid ?? 100, startTimeMs: T0 + 10 })
  os.add({ pid: 102, ppid: 101, pgid: root.pgid ?? 100, startTimeMs: T0 + 20 })
  return os
}

const FAILED = { ok: false, cause: 'failed for the test' } as const
const outcome = <T>(value: T | null) => (value === null ? FAILED : { ok: true as const, value })
const readerOf = (startTimeMs: number | null, bootId: string | null = BOOT): OsProcessReader => ({
  startTimeMs: () => Promise.resolve(outcome(startTimeMs)),
  bootId: () => Promise.resolve(outcome(bootId))
})
const timedOut = (ms: number) => ({ ok: false, cause: `timed out after ${ms} ms` }) as const

/**
 * A query runner that answers after `latencyMs` of simulated time: past the bound the caller passes
 * it reports a timeout, as the real runner does, so no real time passes in the test.
 */
const answeringAfter =
  (latencyMs: number, stdout: (file: string, args: readonly string[]) => string): QueryRunner =>
  (file, args, options) =>
    Promise.resolve(
      latencyMs > options.timeoutMs
        ? timedOut(options.timeoutMs)
        : { ok: true, stdout: stdout(file, args) }
    )

const errno = (code: string): Error => Object.assign(new Error(code), { code })

async function readAll(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) throw new Error('the echo target was spawned without a stdout pipe')
  let text = ''
  for await (const chunk of stream) text += String(chunk)
  return text
}

describe('NodeProcessControl', () => {
  // The real spawn half runs the sleeper stub under node; the probe, kill and boot-identity halves
  // run on a scripted OS (liveness, reads, signals, taskkill, listing, scheduler), once per
  // platform's kill sequence, so no real process is signalled and no real time passes.
  describe.each(['linux', 'darwin', 'win32'] as const)('kill sequence of %s', (platform) => {
    runProcessControlContract(() => {
      const os = new ScriptedOs(platform)
      os.add({ pid: OWN_PID, ppid: 1, startTimeMs: 1_789_000_500_000 })
      os.add({ pid: UNREADABLE_PID, ppid: 1, startTimeMs: 1_789_000_600_000, readable: false })
      const control = scriptedControl(os)
      let nextTreePid = 50_000
      const kill: KillWorld = {
        liveTree: ({ rootEndsOn, access }) => {
          const root = { pid: nextTreePid, processStartTimeMs: T0, bootId: SCRIPTED_BOOT }
          const child = { ...root, pid: nextTreePid + 1, processStartTimeMs: T0 + 5 }
          nextTreePid += 2
          os.add({
            pid: root.pid,
            ppid: 1,
            startTimeMs: T0,
            endsOn: rootEndsOn,
            denied: access === 'denied'
          })
          os.add({ pid: child.pid, ppid: root.pid, pgid: root.pid, startTimeMs: T0 + 5 })
          return Promise.resolve({ root, child })
        },
        signals: () => os.sent,
        isRunning: (pid) => Promise.resolve(os.isRunning(pid))
      }
      return {
        control,
        ownPid: OWN_PID,
        unreadablePid: UNREADABLE_PID,
        absentPid: ABSENT_PID,
        kill,
        failingBootIdentity: () =>
          new NodeProcessControl({
            platform,
            reader: FAILING_READER,
            signalZero: os.signalZero,
            bootSources: scriptedBootSources('failing')
          }),
        echoSpec: (args, env) => ({
          executable: process.execPath,
          args: [SLEEPER, 'echo', ...args],
          env,
          cwd: dirname(SLEEPER),
          processGroup: 'inherit',
          stdio: 'pipe'
        }),
        received: async (child: SpawnedProcess) => {
          const [stdout] = await Promise.all([readAll(child.stdout), child.exited])
          try {
            const echoed = JSON.parse(stdout) as { args: string[]; env: Record<string, string> }
            return { args: echoed.args, env: echoed.env }
          } catch {
            // Not the stub's report (for example a shell ran instead): let the assertion show it.
            return { args: ['<not the echo report>', stdout], env: {} }
          }
        },
        osAddedEnv: OS_ADDED_ENV[process.platform as keyof typeof OS_ADDED_ENV] ?? [],
        setParentVariable: (name, value) => {
          const before = process.env[name]
          process.env[name] = value
          return () => {
            if (before === undefined) delete process.env[name]
            else process.env[name] = before
          }
        },
        dispose: () => Promise.resolve()
      }
    })
  })

  describe('probe', () => {
    it('[ADR-014] probe answers the pid, its start time and the boot id; a non-positive pid is absent without asking the OS', async () => {
      const asked: number[] = []
      const control = new NodeProcessControl({
        reader: readerOf(1_790_000_000_123),
        signalZero: (pid) => {
          asked.push(pid)
        }
      })

      expect(await control.probe(321)).toEqual({
        pid: 321,
        processStartTimeMs: 1_790_000_000_123,
        bootId: BOOT
      })
      expect(await control.probe(0)).toBe('absent')
      expect(await control.probe(-1)).toBe('absent')
      expect(await control.probe(1.5)).toBe('absent')
      expect(asked).toEqual([321])
    })

    it('[INV-51] EPERM from the liveness check means the pid exists; ESRCH means it is absent', async () => {
      const eperm = new NodeProcessControl({
        reader: readerOf(5_000),
        signalZero: () => {
          throw errno('EPERM')
        }
      })
      const esrch = new NodeProcessControl({
        reader: readerOf(5_000),
        signalZero: () => {
          throw errno('ESRCH')
        }
      })

      expect(await eperm.probe(77)).toEqual({ pid: 77, processStartTimeMs: 5_000, bootId: BOOT })
      expect(await esrch.probe(77)).toBe('absent')
    })

    it('[INV-51] a live pid whose start time or boot id cannot be read probes as unknown; one that vanished meanwhile probes as absent', async () => {
      const alive = (): void => {}
      let calls = 0
      const vanishing = (): void => {
        calls += 1
        if (calls > 1) throw errno('ESRCH')
      }
      const throwingReader: OsProcessReader = {
        startTimeMs: () => Promise.reject(new Error('probe failed')),
        bootId: () => Promise.resolve(outcome(BOOT))
      }

      expect(
        await new NodeProcessControl({ reader: readerOf(null), signalZero: alive }).probe(9)
      ).toBe('unknown')
      expect(
        await new NodeProcessControl({ reader: readerOf(9_000, null), signalZero: alive }).probe(9)
      ).toBe('unknown')
      expect(
        await new NodeProcessControl({ reader: throwingReader, signalZero: alive }).probe(9)
      ).toBe('unknown')
      expect(
        await new NodeProcessControl({
          reader: readerOf(9_000),
          signalZero: () => {
            throw errno('EINVAL')
          }
        }).probe(9)
      ).toBe('unknown')
      expect(
        await new NodeProcessControl({ reader: readerOf(null), signalZero: vanishing }).probe(9)
      ).toBe('absent')
    })

    it('[ADR-015] the boot id read starts when the adapter is built and is reused; a failed read is retried once per probe', async () => {
      let reads = 0
      const answers: Array<string | null> = [null, null, BOOT, 'must-not-be-read']
      const reader: OsProcessReader = {
        startTimeMs: () => Promise.resolve(outcome(1_000)),
        bootId: () => {
          reads += 1
          return Promise.resolve(outcome(answers.shift() ?? null))
        }
      }
      const control = new NodeProcessControl({ reader, signalZero: () => {} })

      expect(reads).toBe(1)
      expect(await control.probe(5)).toBe('unknown')
      expect(reads).toBe(2)
      expect(await control.probe(5)).toEqual({ pid: 5, processStartTimeMs: 1_000, bootId: BOOT })
      expect(await control.probe(5)).toEqual({ pid: 5, processStartTimeMs: 1_000, bootId: BOOT })
      expect(reads).toBe(3)
    })

    it('[ADR-015] a probe that finds the construction-time boot id read in flight awaits that same read', async () => {
      let reads = 0
      let answer: (read: { ok: true; value: string }) => void = () => {}
      const reader: OsProcessReader = {
        startTimeMs: () => Promise.resolve(outcome(1_000)),
        bootId: () => {
          reads += 1
          return new Promise((resolve) => {
            answer = resolve
          })
        }
      }
      const control = new NodeProcessControl({ reader, signalZero: () => {} })

      const first = control.probe(5)
      const second = control.probe(6)
      answer({ ok: true, value: BOOT })

      expect(await first).toEqual({ pid: 5, processStartTimeMs: 1_000, bootId: BOOT })
      expect(await second).toEqual({ pid: 6, processStartTimeMs: 1_000, bootId: BOOT })
      expect(reads).toBe(1)
    })

    it('[INV-51] an unreadable spawned identity names the read that failed and why', async () => {
      const spawnEcho: NodeSpawn = () =>
        nodeSpawn(process.execPath, [SLEEPER, 'echo'], {
          stdio: 'ignore',
          env: {},
          shell: false,
          windowsHide: true
        })
      const spec = {
        executable: 'tool',
        args: [],
        env: {},
        cwd: '/work',
        processGroup: 'inherit',
        stdio: 'ignore'
      } as const
      const slowStart = new NodeProcessControl({
        spawnProcess: spawnEcho,
        signalZero: () => {},
        reader: {
          startTimeMs: () => Promise.resolve(timedOut(START_TIME_QUERY_TIMEOUT_MS)),
          bootId: () => Promise.resolve(outcome(BOOT))
        }
      })
      const slowBoot = new NodeProcessControl({
        spawnProcess: spawnEcho,
        signalZero: () => {},
        reader: {
          startTimeMs: () => Promise.resolve(outcome(1_000)),
          bootId: () => Promise.resolve(timedOut(BOOT_ID_QUERY_TIMEOUT_MS))
        }
      })

      const first = slowStart.spawn(spec)
      const second = slowBoot.spawn(spec)
      await Promise.allSettled([first.exited, second.exited])

      await expect(first.identity).rejects.toThrow(
        'could not be read: unknown (start-time read timed out after 5000 ms)'
      )
      await expect(second.identity).rejects.toThrow(
        'could not be read: unknown (boot-id read timed out after 2000 ms)'
      )
    })
  })

  describe('per-OS readers', () => {
    it('[ADR-014] the Linux reader turns /proc starttime ticks and btime into epoch ms and reads boot_id', async () => {
      // comm may hold spaces and ')' — the numeric fields resume after the LAST ')'.
      const fields = ['S', ...Array.from({ length: 18 }, (_, i) => String(i + 1)), '12345', '0']
      const stat = `4242 (my) odd (name) ${fields.join(' ')}\n`
      const procStat = 'cpu  1 2 3\nbtime 1790000000\nprocesses 99\n'
      const files: Record<string, string> = {
        '/proc/4242/stat': stat,
        '/proc/stat': procStat,
        '/proc/sys/kernel/random/boot_id': `${BOOT}\n`
      }
      const reader = createLinuxReader({
        readText: (path) =>
          path in files ? Promise.resolve(files[path] as string) : Promise.reject(errno('ENOENT'))
      })

      expect(parseLinuxStartTime(stat, procStat)).toBe(1_790_000_000_000 + 12_345 * 10)
      expect(await reader.startTimeMs(4242)).toEqual(outcome(1_790_000_000_000 + 12_345 * 10))
      expect(await reader.startTimeMs(1)).toEqual({
        ok: false,
        cause: 'could not read /proc/1/stat (ENOENT)'
      })
      expect(await reader.bootId()).toEqual(outcome(BOOT))
    })

    it('[ADR-014] the macOS reader parses ps lstart in local time with a C locale and reads kern.bootsessionuuid', async () => {
      const queries: Array<{
        file: string
        args: readonly string[]
        options: { timeoutMs: number; env?: Record<string, string> }
      }> = []
      const reader = createDarwinReader({
        runQuery: (file, args, options) => {
          queries.push({ file, args, options })
          return Promise.resolve({
            ok: true as const,
            stdout: file === '/bin/ps' ? 'Sat Aug 29 11:07:36 2026\n' : `${BOOT}\n`
          })
        }
      })

      expect(parseDarwinLstart('Sat Aug 29 11:07:36 2026')).toBe(
        new Date(2026, 7, 29, 11, 7, 36).getTime()
      )
      expect(await reader.startTimeMs(42)).toEqual(
        outcome(new Date(2026, 7, 29, 11, 7, 36).getTime())
      )
      expect(await reader.bootId()).toEqual(outcome(BOOT))
      expect(queries).toEqual([
        {
          file: '/bin/ps',
          args: ['-p', '42', '-o', 'lstart='],
          options: { timeoutMs: 5_000, env: { LC_ALL: 'C' } }
        },
        {
          file: '/usr/sbin/sysctl',
          args: ['-n', 'kern.bootsessionuuid'],
          options: { timeoutMs: 2_000 }
        }
      ])
    })

    // The Windows readers already run their System32 tools by full path. On macOS a bare `ps` or
    // `sysctl` was resolved through the Host's PATH, which the person's environment decides: without
    // /usr/sbin on it the Host could not read its own identity and wrote no `run/host.identity` (CI run
    // 36940954328, macOS), and an earlier PATH entry could answer for a system tool.
    it('[ADR-014] on macOS the probe, the boot sources and the listing run /bin/ps and /usr/sbin/sysctl by full path, never through PATH', async () => {
      const files: string[] = []
      const runQuery = (file: string) => {
        files.push(file)
        return Promise.resolve({ ok: true as const, stdout: '' })
      }
      const reader = createDarwinReader({ runQuery })
      await reader.startTimeMs(42)
      await reader.bootId()
      await createDarwinBootSources({ runQuery }).bootTimeMs()
      await createSnapshotReader('darwin', { runQuery })()

      expect(files).toEqual(['/bin/ps', '/usr/sbin/sysctl', '/usr/sbin/sysctl', '/bin/ps'])
    })

    // ISSUE-019 changed the expected boot-id source: the registry BootId counter replaces the CIM
    // LastBootUpTime instant, which exceeded the frozen 2 000 ms bound on a cold CI runner (S-015-2).
    it('[ADR-014] the Windows reader converts FILETIMEs and reads the boot id from the registry BootId counter with reg.exe from System32', async () => {
      const queries: Array<{ file: string; args: readonly string[]; dropEnv?: readonly string[] }> =
        []
      const reader = createWin32Reader({
        runQuery: (file, args, options) => {
          queries.push({
            file,
            args,
            ...(options.dropEnv === undefined ? {} : { dropEnv: options.dropEnv })
          })
          return Promise.resolve({
            ok: true as const,
            stdout: file.endsWith('reg.exe')
              ? `\r\n${WIN32_BOOT_ID_KEY}\r\n    BootId    REG_DWORD    0xd5\r\n\r\n`
              : '134352733836959841\r\n'
          })
        },
        env: { SystemRoot: 'C:\\Windows' }
      })

      expect(filetimeToEpochMs('134352733836959841')).toBe(1_790_799_783_695)
      expect(await reader.startTimeMs(4242)).toEqual(outcome(1_790_799_783_695))
      expect(await reader.bootId()).toEqual(outcome('213'))
      // ISSUE-019: PowerShell by its full path under SystemRoot (was the bare name, found on PATH),
      // without an inherited PSModulePath.
      expect(queries[0]).toEqual({
        file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-Process -Id 4242).StartTime.ToFileTime()'
        ],
        dropEnv: ['PSModulePath']
      })
      expect(queries[1]).toEqual({
        file: 'C:\\Windows\\System32\\reg.exe',
        args: ['query', WIN32_BOOT_ID_KEY, '/v', 'BootId']
      })
    })

    it('[INV-51] a failed, empty or implausible OS answer reads as no start time and no boot id', async () => {
      const failing = { runQuery: () => Promise.resolve(timedOut(700)) }
      const garbage = {
        runQuery: () => Promise.resolve({ ok: true as const, stdout: 'not a number\n' })
      }
      const blank = { readText: () => Promise.resolve('   \n') }
      const unparseable = { ok: false, cause: 'gave an unparseable answer' }

      expect(parseLinuxStartTime('btime 1790000000\n', 'btime 1790000000\n')).toBeNull()
      expect(parseDarwinLstart('')).toBeNull()
      expect(filetimeToEpochMs('')).toBeNull()
      expect(filetimeToEpochMs('1')).toBeNull() // lands in 1601: implausible
      for (const reader of [createDarwinReader(failing), createWin32Reader(failing)]) {
        expect(await reader.startTimeMs(10)).toEqual(timedOut(700))
        expect(await reader.bootId()).toEqual(timedOut(700))
      }
      for (const reader of [createDarwinReader(garbage), createWin32Reader(garbage)]) {
        expect(await reader.startTimeMs(10)).toEqual(unparseable)
        expect(await reader.bootId()).toEqual(unparseable)
      }
      expect(await createLinuxReader(blank).bootId()).toEqual(unparseable)
      expect(
        await createLinuxReader({ readText: () => Promise.reject(errno('EACCES')) }).startTimeMs(10)
      ).toEqual({ ok: false, cause: 'could not read /proc/10/stat (EACCES)' })
    })

    it('[INV-51] an OS query that outlives its bound reports a timeout; one that fails reports how', async () => {
      // The bound runs on a FakeScheduler: a slow child start under load can never reach it, and it
      // ends the hanging child only when the test advances the clock past it.
      const clock = new FakeClock(T0)
      const scheduler = new FakeScheduler(clock)
      const run = createQueryRunner({ scheduler })
      const node = (script: string) => run(process.execPath, ['-e', script], { timeoutMs: 300 })

      expect(await node('process.stdout.write("42")')).toEqual({ ok: true, stdout: '42' })
      const hanging = node('setInterval(() => {}, 2 ** 30)')
      expect(scheduler.nextDueAt()).toBe(T0 + 300)
      clock.advance(300)
      expect(await hanging).toEqual({
        ok: false,
        cause: 'timed out after 300 ms'
      })
      expect(await node('process.exit(3)')).toEqual({ ok: false, cause: 'exited with code 3' })
      expect(await run(`${SLEEPER}.does-not-exist`, [], { timeoutMs: 300 })).toEqual({
        ok: false,
        cause: 'could not start (ENOENT)'
      })
    }, 10_000)

    it('[INV-51] a query bound is a task on the injected scheduler, never a real timer: an answer that comes after the bound in real time but before it on the scheduler is taken', async () => {
      // The child answers 600 ms of real time after it starts; the 300 ms bound is due only when
      // the test advances the scheduler's clock, which it never does here.
      const run = createQueryRunner({ scheduler: new FakeScheduler(new FakeClock(T0)) })

      expect(
        await run(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("late"), 600)'], {
          timeoutMs: 300
        })
      ).toEqual({ ok: true, stdout: 'late' })
    }, 10_000)

    it('[C-17] a query child never inherits a dropped variable such as PSModulePath, whatever its case in the parent, and keeps the rest', async () => {
      const before = {
        PSModulePath: process.env['PSModulePath'],
        KEEP: process.env['DWARFAI_KEEP']
      }
      process.env['PSModulePath'] = 'C:\\pwsh7\\Modules'
      process.env['DWARFAI_KEEP'] = 'kept'
      try {
        // A bound on a FakeScheduler that never advances: the child's start time is not raced.
        const out = await createQueryRunner({ scheduler: new FakeScheduler(new FakeClock(T0)) })(
          process.execPath,
          ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env)))'],
          { timeoutMs: 5_000, dropEnv: ['psmodulepath'] }
        )

        expect(out.ok).toBe(true)
        const names = JSON.parse(out.ok ? out.stdout : '[]') as string[]
        expect(names.filter((name) => name.toUpperCase() === 'PSMODULEPATH')).toEqual([])
        expect(names).toContain('DWARFAI_KEEP')
      } finally {
        if (before.PSModulePath === undefined) delete process.env['PSModulePath']
        else process.env['PSModulePath'] = before.PSModulePath
        if (before.KEEP === undefined) delete process.env['DWARFAI_KEEP']
        else process.env['DWARFAI_KEEP'] = before.KEEP
      }
    }, 10_000)

    it('[C-17] Windows system tools are named by their full path under SystemRoot, never by a bare name; C:\\Windows only when SystemRoot is missing', () => {
      expect(windowsSystemTool('reg.exe', { SystemRoot: 'D:\\WinDir\\' })).toBe(
        'D:\\WinDir\\System32\\reg.exe'
      )
      expect(windowsPowerShell({ SystemRoot: 'D:\\WinDir' })).toBe(
        'D:\\WinDir\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      )
      expect(windowsSystemTool('taskkill.exe', {})).toBe('C:\\Windows\\System32\\taskkill.exe')
    })

    it('[ADR-015] the boot-id query is bounded at 2 000 ms (16 §2.6) and the start-time query at 5 000 ms', async () => {
      // ISSUE-019: the Windows boot id is the registry BootId counter (was CIM LastBootUpTime).
      const stdout = (file: string, args: readonly string[]) =>
        file.endsWith('reg.exe') || args.includes('kern.bootsessionuuid')
          ? args.includes('kern.bootsessionuuid')
            ? BOOT
            : '    BootId    REG_DWORD    0xd5\r\n'
          : args.includes('lstart=')
            ? 'Sat Aug 29 11:07:36 2026'
            : '134352733836959841'

      expect(BOOT_ID_QUERY_TIMEOUT_MS).toBe(2_000)
      expect(START_TIME_QUERY_TIMEOUT_MS).toBe(5_000)
      for (const make of [createWin32Reader, createDarwinReader]) {
        const slow = make({ runQuery: answeringAfter(2_100, stdout) })
        const quick = make({ runQuery: answeringAfter(1_900, stdout) })

        expect(await slow.bootId()).toEqual(timedOut(2_000))
        expect((await slow.startTimeMs(42)).ok).toBe(true)
        expect((await quick.bootId()).ok).toBe(true)
      }
      const control = new NodeProcessControl({
        reader: createWin32Reader({ runQuery: answeringAfter(2_100, stdout) }),
        signalZero: () => {}
      })
      expect(await control.probe(42)).toBe('unknown')
    })

    it('[INV-59] the OS-added environment names only what the OS or its runtime puts into a child itself', () => {
      expect(OS_ADDED_ENV).toEqual({
        win32: [
          'HOMEDRIVE',
          'HOMEPATH',
          'LOGONSERVER',
          'PATH',
          'SYSTEMDRIVE',
          'SYSTEMROOT',
          'TEMP',
          'USERDOMAIN',
          'USERNAME',
          'USERPROFILE',
          'WINDIR'
        ],
        darwin: ['__CF_USER_TEXT_ENCODING'],
        linux: []
      })
    })
  })

  describe('killTree', () => {
    it('[ADR-014] Windows: taskkill /PID <root> /T /F from System32 as an argv array, then /PID <survivor> /F for each identity-checked survivor', async () => {
      const os = scriptedTree('win32')
      let first = true
      const control = new NodeProcessControl({
        platform: 'win32',
        reader: os.reader,
        signalZero: os.signalZero,
        // The grandchild's parent exits just before the kill, so taskkill /T cannot reach it.
        runCommand: (file, args, options) => {
          if (first) {
            first = false
            os.end(101)
          }
          return os.runCommand(file, args, options)
        },
        snapshot: os.snapshot,
        scheduler: os.scheduler,
        bootSources: scriptedBootSources('working'),
        env: { SystemRoot: 'C:\\Windows' }
      })

      expect(await control.killTree(ROOT, OWNED)).toEqual({ kind: 'ended' })

      expect(os.taskkills).toEqual([
        { file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '100', '/T', '/F'] },
        { file: 'C:\\Windows\\System32\\taskkill.exe', args: ['/PID', '102', '/F'] }
      ])
      expect([100, 101, 102].map((pid) => os.isRunning(pid))).toEqual([false, false, false])
    })

    it("[ADR-014] POSIX owned: one SIGTERM to the root's process group, then SIGKILL only to identity-checked survivors, including one that left the group", async () => {
      const os = scriptedTree('linux', { endsOn: 'kill' })
      os.add({ pid: 103, ppid: 100, pgid: 999, startTimeMs: T0 + 30, endsOn: 'kill' })

      expect(await scriptedControl(os).killTree(ROOT, OWNED)).toEqual({ kind: 'ended' })

      expect(os.sent).toEqual([
        { pid: 100, signal: 'term', scope: 'group' },
        { pid: 103, signal: 'kill', scope: 'process' },
        { pid: 100, signal: 'kill', scope: 'process' }
      ])
      expect(os.isRunning(103)).toBe(false)
    })

    it('[ADR-014] POSIX: a root that does not lead its own process group is never signalled as a group, even with group owned', async () => {
      const os = scriptedTree('darwin', { pgid: 1 })

      expect(await scriptedControl(os).killTree(ROOT, OWNED)).toEqual({ kind: 'ended' })

      expect(os.sent.length).toBeGreaterThan(0)
      expect(os.sent.filter((sent) => sent.scope === 'group')).toEqual([])
    })

    it('[ADR-014] POSIX foreign: SIGTERM to the leaves first, then the root, never to a group', async () => {
      const os = scriptedTree('linux')

      expect(await scriptedControl(os).killTree(ROOT, FOREIGN)).toEqual({ kind: 'ended' })

      expect(os.sent).toEqual([
        { pid: 102, signal: 'term', scope: 'process' },
        { pid: 101, signal: 'term', scope: 'process' },
        { pid: 100, signal: 'term', scope: 'process' }
      ])
    })

    it('[ADR-014, FM-065] descendants that survive the first step are killed and logged as terminate.leftover, and the outcome stays ended', async () => {
      const os = scriptedTree('linux')
      os.add({ pid: 104, ppid: 102, pgid: 555, startTimeMs: T0 + 40, endsOn: 'kill' })
      const diagnostics = new RecordingDiagnosticsLog()

      expect(await scriptedControl(os, diagnostics).killTree(ROOT, OWNED)).toEqual({
        kind: 'ended'
      })

      expect(os.isRunning(104)).toBe(false)
      expect(diagnostics.byEvent('terminate.leftover')).toEqual([
        { level: 'warn', event: 'terminate.leftover', subsystem: 'kernel', count: 1 }
      ])
    })

    it('[ADR-014, INV-51] the root identity is re-checked before the escalation: a pid reused during the TERM wait is never killed', async () => {
      const os = scriptedTree('linux', { endsOn: 'never' })
      os.onSignal = (pid, signal) => {
        if (pid !== 100 || signal !== 'SIGTERM') return
        // The root exits and another process gets its pid within the wait.
        os.end(100)
        os.add({ pid: 100, ppid: 1, startTimeMs: T0 + 60_000, endsOn: 'never' })
      }

      expect(await scriptedControl(os).killTree(ROOT, FOREIGN)).toEqual({ kind: 'ended' })

      expect(os.sent.filter((sent) => sent.pid === 100 && sent.signal === 'kill')).toEqual([])
      expect(os.isRunning(100)).toBe(true)
    })

    it('[ADR-014] the waits are the 16 §2.6 values: TERM wait graceMs, then KILL wait 2 000 ms, polled at most every 2 s', async () => {
      const os = scriptedTree('linux', { endsOn: 'never' })

      expect(await scriptedControl(os).killTree(ROOT, OWNED)).toEqual({
        kind: 'failed',
        reason: 'still-alive'
      })

      expect(os.waits.reduce((sum, ms) => sum + ms, 0)).toBe(3_000 + 2_000)
      expect(Math.max(...os.waits)).toBeLessThanOrEqual(2_000)
    })

    it('[ADR-014] a process listing that cannot be read still ends the root, never signals a group, and says why in the log', async () => {
      const os = scriptedTree('linux')
      const diagnostics = new RecordingDiagnosticsLog()
      const control = new NodeProcessControl({
        platform: 'linux',
        reader: os.reader,
        signalZero: os.signalZero,
        sendSignal: os.sendSignal,
        snapshot: () => Promise.resolve({ ok: false, cause: 'could not read /proc (EACCES)' }),
        scheduler: os.scheduler,
        bootSources: scriptedBootSources('working'),
        diagnostics
      })

      expect(await control.killTree(ROOT, OWNED)).toEqual({ kind: 'ended' })

      expect(os.sent.filter((sent) => sent.scope === 'group')).toEqual([])
      expect(diagnostics.byEvent('process.snapshot.unreadable')).toEqual([
        {
          level: 'warn',
          event: 'process.snapshot.unreadable',
          subsystem: 'kernel',
          outcome: 'degraded',
          errCode: 'EACCES'
        },
        {
          level: 'warn',
          event: 'process.snapshot.unreadable',
          subsystem: 'kernel',
          outcome: 'degraded',
          errCode: 'EACCES'
        }
      ])
    })
  })

  describe('currentBootIdentity', () => {
    it('[ADR-015] when every source fails or times out it resolves three unknown fields within the 2 000 ms bound and logs each failure', async () => {
      const diagnostics = new RecordingDiagnosticsLog()
      const bounds: number[] = []
      const slow: QueryRunner = (file, args, options) => {
        bounds.push(options.timeoutMs)
        return answeringAfter(2_100, () => '')(file, args, options)
      }
      const control = new NodeProcessControl({
        platform: 'win32',
        reader: createWin32Reader({ runQuery: slow }),
        bootSources: createWin32BootSources({ runQuery: slow }),
        diagnostics
      })

      expect(await control.currentBootIdentity()).toEqual({
        bootId: 'unknown',
        bootTimeMs: 'unknown',
        logonSessionId: 'unknown'
      })
      expect(bounds.length).toBeGreaterThan(0)
      expect(bounds.every((ms) => ms === BOOT_ID_QUERY_TIMEOUT_MS)).toBe(true)
      expect(diagnostics.byEvent('process.boot-identity.unknown')).toEqual(
        ['bootId', 'bootTimeMs', 'logonSessionId'].map((field) => ({
          level: 'warn',
          event: 'process.boot-identity.unknown',
          subsystem: 'kernel',
          outcome: 'degraded',
          causeClass: field,
          errCode: 'ETIMEDOUT'
        }))
      )
    })

    it('[ADR-015] bootId comes from the same read the probes use: one boot-id read serves both', async () => {
      let reads = 0
      const reader: OsProcessReader = {
        startTimeMs: () => Promise.resolve(outcome(1_000)),
        bootId: () => {
          reads += 1
          return Promise.resolve(outcome(BOOT))
        }
      }
      const control = new NodeProcessControl({
        platform: 'darwin',
        reader,
        signalZero: () => {},
        bootSources: createDarwinBootSources({
          runQuery: () =>
            Promise.resolve({ ok: true, stdout: '{ sec = 1790000000, usec = 0 } Sat Aug 29\n' })
        })
      })

      const probed = await control.probe(5)
      const identity = await control.currentBootIdentity()

      expect(probed).toEqual({ pid: 5, processStartTimeMs: 1_000, bootId: BOOT })
      expect(identity).toEqual({
        bootId: BOOT,
        bootTimeMs: 1_790_000_000_000,
        logonSessionId: 'unknown'
      })
      expect(reads).toBe(1)
    })

    it('[ADR-015] a source that throws is a field unknown, never a rejection', async () => {
      const control = new NodeProcessControl({
        platform: 'linux',
        reader: readerOf(1, BOOT),
        bootSources: {
          bootTimeMs: () => Promise.reject(new Error('boom')),
          logonSessionId: () => {
            throw new Error('boom')
          },
          sources: { bootId: 'x', bootTimeMs: 'x', logonSessionId: 'x' }
        }
      })

      expect(await control.currentBootIdentity()).toEqual({
        bootId: BOOT,
        bootTimeMs: 'unknown',
        logonSessionId: 'unknown'
      })
    })
  })

  describe('spawn', () => {
    it('[C-17] spawn fixes shell false and windowsHide true, copies the env and maps processGroup and stdio', async () => {
      const calls: Array<{
        file: string
        args: readonly string[]
        options: Record<string, unknown>
      }> = []
      const recordingSpawn: NodeSpawn = (file, args, options) => {
        calls.push({ file, args, options: { ...options } })
        // Hand back a real, harmless child so the adapter can wire its events.
        return nodeSpawn(process.execPath, [SLEEPER, 'echo'], {
          stdio: 'ignore',
          env: {},
          shell: false,
          windowsHide: true
        })
      }
      const control = new NodeProcessControl({ spawnProcess: recordingSpawn, reader: readerOf(1) })
      const env = { ONLY: '1' }

      const child = control.spawn({
        executable: 'tool',
        args: ['a & b'],
        env,
        cwd: '/work',
        processGroup: 'own',
        stdio: 'ignore'
      })
      await child.exited

      expect(calls).toHaveLength(1)
      expect(calls[0]?.file).toBe('tool')
      expect(calls[0]?.args).toEqual(['a & b'])
      expect(calls[0]?.options).toMatchObject({
        cwd: '/work',
        env: { ONLY: '1' },
        shell: false,
        windowsHide: true,
        detached: true,
        stdio: 'ignore'
      })
      expect(calls[0]?.options['env']).not.toBe(env)
    })

    it('[ADR-014] a spawn that cannot start rejects identity and exited instead of inventing a process', async () => {
      const control = new NodeProcessControl()

      const child = control.spawn({
        executable: `${SLEEPER}.does-not-exist`,
        args: [],
        env: {},
        cwd: dirname(SLEEPER),
        processGroup: 'inherit',
        stdio: 'ignore'
      })

      await expect(child.exited).rejects.toThrow(/ENOENT/)
      await expect(child.identity).rejects.toThrow(/ENOENT/)
    })

    it('[ADR-014] a spawn that Node refuses synchronously rejects identity and exited the same way', async () => {
      const control = new NodeProcessControl({
        spawnProcess: () => {
          throw errno('EINVAL')
        }
      })

      const spec = {
        executable: 'tool.cmd',
        args: [],
        env: {},
        cwd: '/work',
        processGroup: 'inherit',
        stdio: 'pipe'
      } as const
      let spawned: SpawnedProcess | undefined
      expect(() => {
        spawned = control.spawn(spec)
      }).not.toThrow()
      const child = spawned as SpawnedProcess

      await expect(child.exited).rejects.toThrow(/EINVAL/)
      await expect(child.identity).rejects.toThrow(/EINVAL/)
      expect([child.stdin, child.stdout, child.stderr]).toEqual([null, null, null])
    })
  })
})
