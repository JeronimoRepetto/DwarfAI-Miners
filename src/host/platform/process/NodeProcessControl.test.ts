import { spawn as nodeSpawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { SpawnedProcess } from '../../kernel/ports/processControl'
import { runProcessControlContract } from '../../kernel/testing/processControl.contract'
import {
  NodeProcessControl,
  WIN32_REQUIRED_ENV,
  type NodeSpawn,
  type OsProcessReader
} from './NodeProcessControl'
import { createDarwinReader, parseDarwinLstart } from './probe/darwin'
import { createLinuxReader, parseLinuxStartTime } from './probe/linux'
import { createWin32Reader, filetimeToEpochMs } from './probe/win32'

const SLEEPER = fileURLToPath(
  new URL('../../../../fixtures/bin/sleeper/sleeper.mjs', import.meta.url)
)
// Above every pid limit of the three OSes (Linux pid_max ≤ 4 194 304, macOS 99 999, Windows pids
// fit well below it in practice) and still a valid argument for process.kill.
const ABSENT_PID = 2_147_483_000
const BOOT = '6f1c2d0e-1b2a-4c3d-9e8f-0a1b2c3d4e5f'

const readerOf = (startTimeMs: number | null, bootId: string | null = BOOT): OsProcessReader => ({
  startTimeMs: () => Promise.resolve(startTimeMs),
  bootId: () => Promise.resolve(bootId)
})

const errno = (code: string): Error => Object.assign(new Error(code), { code })

async function readAll(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) throw new Error('the echo target was spawned without a stdout pipe')
  let text = ''
  for await (const chunk of stream) text += String(chunk)
  return text
}

describe('NodeProcessControl', () => {
  // The real spawn half runs the sleeper stub under node; the probe half reads the start time
  // through an injected reader that cannot read it, so `unknown` is exercised on a live pid.
  runProcessControlContract(() => {
    const control = new NodeProcessControl({ reader: readerOf(null) })
    return {
      control,
      unreadablePid: process.pid,
      absentPid: ABSENT_PID,
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
      osRequiredEnv: process.platform === 'win32' ? WIN32_REQUIRED_ENV : [],
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
        bootId: () => Promise.resolve(BOOT)
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

    it('[ADR-015] the boot id is read once and reused; a failed read is retried on the next probe', async () => {
      let reads = 0
      const answers: Array<string | null> = [null, BOOT, 'must-not-be-read']
      const reader: OsProcessReader = {
        startTimeMs: () => Promise.resolve(1_000),
        bootId: () => {
          reads += 1
          return Promise.resolve(answers.shift() ?? null)
        }
      }
      const control = new NodeProcessControl({ reader, signalZero: () => {} })

      expect(await control.probe(5)).toBe('unknown')
      expect(await control.probe(5)).toEqual({ pid: 5, processStartTimeMs: 1_000, bootId: BOOT })
      expect(await control.probe(5)).toEqual({ pid: 5, processStartTimeMs: 1_000, bootId: BOOT })
      expect(reads).toBe(2)
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
      expect(await reader.startTimeMs(4242)).toBe(1_790_000_000_000 + 12_345 * 10)
      expect(await reader.startTimeMs(1)).toBeNull()
      expect(await reader.bootId()).toBe(BOOT)
    })

    it('[ADR-014] the macOS reader parses ps lstart in local time with a C locale and reads kern.bootsessionuuid', async () => {
      const queries: Array<{
        file: string
        args: readonly string[]
        env?: Record<string, string>
      }> = []
      const reader = createDarwinReader({
        runQuery: (file, args, env) => {
          queries.push({ file, args, ...(env === undefined ? {} : { env }) })
          return Promise.resolve(file === 'ps' ? 'Sat Aug 29 11:07:36 2026\n' : `${BOOT}\n`)
        }
      })

      expect(parseDarwinLstart('Sat Aug 29 11:07:36 2026')).toBe(
        new Date(2026, 7, 29, 11, 7, 36).getTime()
      )
      expect(await reader.startTimeMs(42)).toBe(new Date(2026, 7, 29, 11, 7, 36).getTime())
      expect(await reader.bootId()).toBe(BOOT)
      expect(queries).toEqual([
        { file: 'ps', args: ['-p', '42', '-o', 'lstart='], env: { LC_ALL: 'C' } },
        { file: 'sysctl', args: ['-n', 'kern.bootsessionuuid'] }
      ])
    })

    it('[ADR-014] the Windows reader converts FILETIMEs and rounds the boot instant to the second', async () => {
      const queries: Array<readonly string[]> = []
      const reader = createWin32Reader({
        runQuery: (_file, args) => {
          queries.push(args)
          const script = args.at(-1) ?? ''
          return Promise.resolve(
            script.includes('Win32_OperatingSystem')
              ? '134343379155000000\r\n'
              : '134352733836959841\r\n'
          )
        }
      })

      expect(filetimeToEpochMs('134352733836959841')).toBe(1_790_799_783_695)
      expect(await reader.startTimeMs(4242)).toBe(1_790_799_783_695)
      expect(await reader.bootId()).toBe('1789864316000')
      expect(queries[0]).toEqual([
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-Process -Id 4242).StartTime.ToFileTime()'
      ])
    })

    it('[INV-51] a failed, empty or implausible OS answer reads as no start time and no boot id', async () => {
      const failing = { runQuery: () => Promise.resolve(null) }
      const garbage = { runQuery: () => Promise.resolve('not a number\n') }
      const blank = { readText: () => Promise.resolve('   \n') }

      expect(parseLinuxStartTime('btime 1790000000\n', 'btime 1790000000\n')).toBeNull()
      expect(parseDarwinLstart('')).toBeNull()
      expect(filetimeToEpochMs('')).toBeNull()
      expect(filetimeToEpochMs('1')).toBeNull() // lands in 1601: implausible
      for (const reader of [
        createDarwinReader(failing),
        createWin32Reader(failing),
        createDarwinReader(garbage),
        createWin32Reader(garbage)
      ]) {
        expect(await reader.startTimeMs(10)).toBeNull()
        expect(await reader.bootId()).toBeNull()
      }
      expect(await createLinuxReader(blank).bootId()).toBeNull()
      expect(
        await createLinuxReader({ readText: () => Promise.reject(errno('EACCES')) }).startTimeMs(10)
      ).toBeNull()
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
