import { describe, expect, it } from 'vitest'
import { PRIVILEGE_QUERY_TIMEOUT_MS, createPrivilegeCheck } from './privilege'
import type { QueryOutcome, QueryRunner } from './probe/types'

// `whoami /groups /fo csv /nh` as Windows prints it. Group names are localized (here a Spanish
// install); the integrity label's SID is not, and is what the check reads.
const groupsAt = (rid: number): string =>
  [
    '"Todos","Grupo conocido","S-1-1-0","Grupo obligatorio, Habilitado de manera predeterminada, Grupo habilitado"',
    '"BUILTIN\\Usuarios","Alias","S-1-5-32-545","Grupo obligatorio, Habilitado de manera predeterminada, Grupo habilitado"',
    `"Etiqueta obligatoria\\Nivel obligatorio","Etiqueta","S-1-16-${rid}",""`
  ].join('\r\n') + '\r\n'

interface Query {
  file: string
  args: readonly string[]
  timeoutMs: number
}

/** A QueryRunner that answers by program name (whoami.exe or powershell.exe) and records calls. */
function scripted(answers: { whoami?: QueryOutcome; powershell?: QueryOutcome }): {
  runQuery: QueryRunner
  queries: Query[]
} {
  const queries: Query[] = []
  const runQuery: QueryRunner = (file, args, options) => {
    queries.push({ file, args, timeoutMs: options.timeoutMs })
    const answer = file.endsWith('whoami.exe') ? answers.whoami : answers.powershell
    return Promise.resolve(answer ?? { ok: false, cause: 'could not start (ENOENT)' })
  }
  return { runQuery, queries }
}

const WINDOWS_ENV = { SystemRoot: 'C:\\Windows' }

/** The PowerShell script carried by `-EncodedCommand` (UTF-16LE, base64). */
function decodedScript(args: readonly string[]): string {
  const encoded = args[args.indexOf('-EncodedCommand') + 1] ?? ''
  return Buffer.from(encoded, 'base64').toString('utf16le')
}

describe('privilege check (ADR-002 D6)', () => {
  it('[ADR-002, FM-011] a Windows token at high or system integrity is elevated; medium and low are not', async () => {
    const answers: Array<[number, boolean]> = [
      [4096, false], // low
      [8192, false], // medium: a normal start, also for an administrator under UAC
      [8448, false], // medium plus
      [12288, true], // high: "Run as administrator"
      [16384, true] // system
    ]
    for (const [rid, elevated] of answers) {
      const { runQuery, queries } = scripted({
        whoami: { ok: true, stdout: groupsAt(rid) },
        powershell: { ok: true, stdout: 'False\r\n' }
      })
      const check = createPrivilegeCheck({
        platform: 'win32',
        runQuery,
        env: WINDOWS_ENV,
        pid: 4242
      })

      const report = await check()

      expect(report.elevated, `S-1-16-${rid}`).toEqual({ ok: true, value: elevated })
      // whoami from System32 by path, never from PATH (Git for Windows ships another whoami).
      expect(queries.find((q) => q.file.endsWith('whoami.exe'))).toEqual({
        file: 'C:\\Windows\\System32\\whoami.exe',
        args: ['/groups', '/fo', 'csv', '/nh'],
        timeoutMs: PRIVILEGE_QUERY_TIMEOUT_MS
      })
    }
  })

  it('[ADR-002, FM-011] on POSIX root is elevated only when the launching user is not root', async () => {
    const cases: Array<{
      ids: { uid: number; euid: number }
      env: Record<string, string | undefined>
      elevated: boolean
      why: string
    }> = [
      { ids: { uid: 501, euid: 501 }, env: {}, elevated: false, why: 'a normal user' },
      {
        ids: { uid: 0, euid: 0 },
        env: {},
        elevated: false,
        why: 'a root login: the UI user is root'
      },
      {
        ids: { uid: 0, euid: 0 },
        env: { SUDO_UID: '501' },
        elevated: true,
        why: 'sudo from a user'
      },
      { ids: { uid: 0, euid: 0 }, env: { PKEXEC_UID: '1000' }, elevated: true, why: 'pkexec' },
      { ids: { uid: 0, euid: 0 }, env: { SUDO_UID: '0' }, elevated: false, why: 'sudo from root' },
      { ids: { uid: 1000, euid: 0 }, env: {}, elevated: true, why: 'a set-uid root binary' }
    ]
    for (const { ids, env, elevated, why } of cases) {
      for (const platform of ['linux', 'darwin'] as const) {
        const { runQuery, queries } = scripted({})
        const check = createPrivilegeCheck({ platform, runQuery, env, ids: () => ids })

        const report = await check()

        expect(report, `${platform}: ${why}`).toEqual({
          elevated: { ok: true, value: elevated },
          inJob: 'not-applicable'
        })
        expect(queries, 'POSIX reads the ids in-process').toEqual([])
      }
    }
  })

  it("[FM-012] on Windows the Host's own IsProcessInJob answer is read through PowerShell; elsewhere it is not applicable", async () => {
    for (const [stdout, inJob] of [
      ['True\r\n', true],
      ['False\r\n', false]
    ] as const) {
      const { runQuery, queries } = scripted({
        whoami: { ok: true, stdout: groupsAt(8192) },
        powershell: { ok: true, stdout }
      })
      const check = createPrivilegeCheck({
        platform: 'win32',
        runQuery,
        env: WINDOWS_ENV,
        pid: 4242
      })

      expect((await check()).inJob).toEqual({ ok: true, value: inJob })

      const ps = queries.find((q) => q.file.endsWith('powershell.exe'))
      expect(ps?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
      expect(ps?.timeoutMs).toBe(PRIVILEGE_QUERY_TIMEOUT_MS)
      expect(ps?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
      // The Host's pid is the only value put into the script, and the job is the Host's own.
      const script = decodedScript(ps?.args ?? [])
      expect(script).toContain('IsProcessInJob')
      expect(script).toContain('OpenProcess(0x1000, $false, 4242)')
    }
  })

  it('[ADR-002, FM-011, FM-012] an unreadable or unparseable answer is reported with its cause, never guessed', async () => {
    const { runQuery } = scripted({
      whoami: { ok: false, cause: `timed out after ${PRIVILEGE_QUERY_TIMEOUT_MS} ms` },
      powershell: { ok: true, stdout: 'Add-Type : no se puede compilar\r\n' }
    })
    const check = createPrivilegeCheck({ platform: 'win32', runQuery, env: WINDOWS_ENV, pid: 4242 })

    expect(await check()).toEqual({
      elevated: { ok: false, cause: `timed out after ${PRIVILEGE_QUERY_TIMEOUT_MS} ms` },
      inJob: { ok: false, cause: 'gave an unparseable answer' }
    })

    const noLabel = scripted({
      whoami: { ok: true, stdout: '"Todos","Grupo conocido","S-1-1-0",""\r\n' },
      powershell: { ok: false, cause: 'exited with code 4' }
    })
    const report = await createPrivilegeCheck({
      platform: 'win32',
      runQuery: noLabel.runQuery,
      env: WINDOWS_ENV,
      pid: 4242
    })()
    expect(report).toEqual({
      elevated: { ok: false, cause: 'gave an unparseable answer' },
      inJob: { ok: false, cause: 'exited with code 4' }
    })
  })
})
