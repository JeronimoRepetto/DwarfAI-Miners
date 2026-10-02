import { describe, expect, it } from 'vitest'
import { PRIVILEGE_QUERY_TIMEOUT_MS, createPrivilegeCheck } from './privilege'
import type { QueryOutcome, QueryRunner, ReadOutcome } from './probe/types'

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

/** A QueryRunner that answers whoami.exe and records calls; any other program could not start. */
function scripted(answers: { whoami?: QueryOutcome }): {
  runQuery: QueryRunner
  queries: Query[]
} {
  const queries: Query[] = []
  const runQuery: QueryRunner = (file, args, options) => {
    queries.push({ file, args, timeoutMs: options.timeoutMs })
    const answer = file.endsWith('whoami.exe') ? answers.whoami : undefined
    return Promise.resolve(answer ?? { ok: false, cause: 'could not start (ENOENT)' })
  }
  return { runQuery, queries }
}

const WINDOWS_ENV = { SystemRoot: 'C:\\Windows' }

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
        whoami: { ok: true, stdout: groupsAt(rid) }
      })
      // AMENDED for ISSUE-056 (was: a PowerShell job answer and the Host's pid): the job status is the native read.
      const check = createPrivilegeCheck({
        platform: 'win32',
        runQuery,
        env: WINDOWS_ENV,
        readInJob: () => ({ ok: true, value: false })
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

  // AMENDED for ISSUE-056 (was: read through a PowerShell script the Host spawned, with the Host's pid in it): the
  // answer is the Host's own native read, taken when the check is created (libuv's own job, see below); the
  // expectation that the Host's own IsProcessInJob answer is reported as read is unchanged.
  it("[FM-012] on Windows the Host's own IsProcessInJob answer is read natively; elsewhere it is not applicable", async () => {
    for (const inJob of [true, false]) {
      const { runQuery, queries } = scripted({ whoami: { ok: true, stdout: groupsAt(8192) } })
      const check = createPrivilegeCheck({
        platform: 'win32',
        runQuery,
        env: WINDOWS_ENV,
        readInJob: () => ({ ok: true, value: inJob })
      })

      expect((await check()).inJob).toEqual({ ok: true, value: inJob })
      // No PowerShell, and no process at all for the job status: whoami alone is spawned.
      expect(queries.map((q) => q.file)).toEqual(['C:\\Windows\\System32\\whoami.exe'])
    }
    for (const platform of ['darwin', 'linux'] as const) {
      const check = createPrivilegeCheck({
        platform,
        ids: () => ({ uid: 501, euid: 501 }),
        env: {}
      })
      expect((await check()).inJob).toBe('not-applicable')
    }
  })

  // AMENDED for ISSUE-056 (was: the PowerShell job read failing or unparseable): an in-job read that failed, or no native
  // reader at all, is reported with its cause; the elevation causes are unchanged.
  it('[ADR-002, FM-011, FM-012] an unreadable or unparseable answer is reported with its cause, never guessed', async () => {
    const { runQuery } = scripted({
      whoami: { ok: false, cause: `timed out after ${PRIVILEGE_QUERY_TIMEOUT_MS} ms` }
    })
    const check = createPrivilegeCheck({
      platform: 'win32',
      runQuery,
      env: WINDOWS_ENV,
      readInJob: () => ({ ok: false, cause: 'WIN32_5' })
    })

    expect(await check()).toEqual({
      elevated: { ok: false, cause: `timed out after ${PRIVILEGE_QUERY_TIMEOUT_MS} ms` },
      inJob: { ok: false, cause: 'WIN32_5' }
    })

    const noLabel = scripted({
      whoami: { ok: true, stdout: '"Todos","Grupo conocido","S-1-1-0",""\r\n' }
    })
    const report = await createPrivilegeCheck({
      platform: 'win32',
      runQuery: noLabel.runQuery,
      env: WINDOWS_ENV
    })()
    expect(report).toEqual({
      elevated: { ok: false, cause: 'gave an unparseable answer' },
      inJob: { ok: false, cause: 'has no in-job reader' }
    })
  })

  /*
   * libuv adds the process itself to a job of its own at its first non-detached spawn (libuv 1.51.0
   * src/win/process.c:109, AssignProcessToJobObject(own job, GetCurrentProcess())), so an IsProcessInJob read taken
   * after any spawn, the PowerShell that took it included, said in-job on every Windows Host (ISSUE-056, owner's live
   * check). The read is the Host's own native one, taken when the check is created, before the Host spawns anything.
   */
  it('[FM-012, S12.04] the job status is read when the check is created, before the first spawn', async () => {
    const order: string[] = []
    const runQuery: QueryRunner = (file) => {
      order.push(`spawn ${file.split('\\').pop() ?? file}`)
      return Promise.resolve({ ok: true, stdout: groupsAt(8192) })
    }
    const readInJob = (): ReadOutcome<boolean> => {
      order.push('read in-job')
      return { ok: true, value: false }
    }

    const check = createPrivilegeCheck({ platform: 'win32', runQuery, env: WINDOWS_ENV, readInJob })
    expect(order, 'read at creation, nothing spawned yet').toEqual(['read in-job'])

    const report = await check()
    expect(order).toEqual(['read in-job', 'spawn whoami.exe'])
    expect(report.inJob).toEqual({ ok: true, value: false })
  })

  it("[FM-012] a job the Host enters later, libuv's own at its first spawn, does not change the boot answer", async () => {
    let reads = 0
    const readInJob = (): ReadOutcome<boolean> => {
      reads += 1
      // Outside every job at start; inside libuv's own job once anything was spawned.
      return { ok: true, value: reads > 1 }
    }
    const { runQuery } = scripted({ whoami: { ok: true, stdout: groupsAt(8192) } })
    const check = createPrivilegeCheck({ platform: 'win32', runQuery, env: WINDOWS_ENV, readInJob })

    expect((await check()).inJob).toEqual({ ok: true, value: false })
    expect((await check()).inJob).toEqual({ ok: true, value: false })
    expect(reads).toBe(1)
  })
})
