import { describe, expect, it } from 'vitest'
import { BOOT_ID_QUERY_TIMEOUT_MS, type QueryRunner } from '../probe/types'
import { createDarwinBootSources, parseDarwinBoottime } from './darwin'
import { createLinuxBootSources } from './linux'
import { createWin32BootSources } from './win32'

const errno = (code: string): Error => Object.assign(new Error(code), { code })

describe('boot identity sources (ADR-015 item 4, AMENDMENT-3)', () => {
  it('[ADR-015] Linux: bootTimeMs is now minus os.uptime() to the second; the logon session is /proc/self/sessionid, else XDG_SESSION_ID', async () => {
    const withAudit = createLinuxBootSources({
      now: () => 1_790_000_100_400,
      uptimeSeconds: () => 100.25,
      readText: () => Promise.resolve('3\n'),
      env: { XDG_SESSION_ID: 'c2' }
    })
    const unsetAudit = createLinuxBootSources({
      now: () => 1_790_000_100_400,
      uptimeSeconds: () => 100.25,
      readText: () => Promise.resolve('4294967295'),
      env: { XDG_SESSION_ID: 'c2' }
    })
    const neither = createLinuxBootSources({
      readText: () => Promise.reject(errno('ENOENT')),
      env: {}
    })

    expect(await withAudit.bootTimeMs()).toEqual({ ok: true, value: 1_790_000_000_000 })
    expect(await withAudit.logonSessionId()).toEqual({ ok: true, value: '3' })
    expect(await unsetAudit.logonSessionId()).toEqual({ ok: true, value: 'c2' })
    expect((await neither.logonSessionId()).ok).toBe(false)
  })

  it('[ADR-015] macOS: bootTimeMs is sysctl kern.boottime bounded at 2 000 ms; the audit session id is not readable from Node', async () => {
    const queries: Array<{ file: string; args: readonly string[]; timeoutMs: number }> = []
    const runQuery: QueryRunner = (file, args, options) => {
      queries.push({ file, args, timeoutMs: options.timeoutMs })
      return Promise.resolve({
        ok: true,
        stdout: '{ sec = 1790000000, usec = 456789 } Sat Aug 29 11:07:36 2026\n'
      })
    }
    const sources = createDarwinBootSources({ runQuery })

    expect(parseDarwinBoottime('{ sec = 1790000000, usec = 456789 } Sat Aug 29')).toBe(
      1_790_000_000_456
    )
    expect(parseDarwinBoottime('nothing')).toBeNull()
    expect(await sources.bootTimeMs()).toEqual({ ok: true, value: 1_790_000_000_456 })
    expect(queries).toEqual([
      { file: 'sysctl', args: ['-n', 'kern.boottime'], timeoutMs: BOOT_ID_QUERY_TIMEOUT_MS }
    ])
    expect((await sources.logonSessionId()).ok).toBe(false)
  })

  it('[ADR-015, S-015-2] Windows: bootTimeMs is CIM LastBootUpTime to the second and the logon session the logon SID of whoami /logonid from System32, each bounded at 2 000 ms', async () => {
    const queries: Array<{
      file: string
      args: readonly string[]
      timeoutMs: number
      dropEnv?: readonly string[]
    }> = []
    const sources = createWin32BootSources({
      runQuery: (file, args, options) => {
        queries.push({
          file,
          args,
          timeoutMs: options.timeoutMs,
          ...(options.dropEnv === undefined ? {} : { dropEnv: options.dropEnv })
        })
        return Promise.resolve({
          ok: true,
          stdout: file.endsWith('whoami.exe') ? 'S-1-5-5-0-4242\r\n' : '134343379155000000\r\n'
        })
      },
      env: { SystemRoot: 'C:\\Windows' }
    })

    expect(await sources.bootTimeMs()).toEqual({ ok: true, value: 1_789_864_316_000 })
    expect(await sources.logonSessionId()).toEqual({ ok: true, value: 'S-1-5-5-0-4242' })
    expect(queries).toEqual([
      {
        file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        args: [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '(Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToFileTime()'
        ],
        timeoutMs: BOOT_ID_QUERY_TIMEOUT_MS,
        dropEnv: ['PSModulePath']
      },
      {
        file: 'C:\\Windows\\System32\\whoami.exe',
        args: ['/logonid'],
        timeoutMs: BOOT_ID_QUERY_TIMEOUT_MS
      }
    ])
  })

  it('[ADR-015] an answer that is not a boot instant or a logon session reads as no value', async () => {
    const garbage: QueryRunner = () => Promise.resolve({ ok: true, stdout: 'not it\n' })
    const linux = createLinuxBootSources({
      uptimeSeconds: () => Number.NaN,
      readText: () => Promise.resolve('\n'),
      env: {}
    })

    expect((await linux.bootTimeMs()).ok).toBe(false)
    expect((await createDarwinBootSources({ runQuery: garbage }).bootTimeMs()).ok).toBe(false)
    expect((await createWin32BootSources({ runQuery: garbage }).logonSessionId()).ok).toBe(false)
    expect((await createWin32BootSources({ runQuery: garbage }).bootTimeMs()).ok).toBe(false)
  })
})
