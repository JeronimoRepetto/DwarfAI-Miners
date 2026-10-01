import { describe, expect, it } from 'vitest'
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { QueryRunner } from '../probe/types'
import {
  SNAPSHOT_QUERY_TIMEOUT_MS,
  createSnapshotReader,
  descendantsOf,
  parseDarwinProcessTable,
  parseWin32ProcessTable,
  survivorsIn
} from './snapshot'
import type { ProcessRow } from './types'

const BOOT = 'boot'
const T0 = 1_790_000_000_000
const row = (pid: number, ppid: number, startTimeMs: number | null, pgid: number | null = null) =>
  ({ pid, ppid, pgid, startTimeMs }) satisfies ProcessRow
const id = (pid: number, startTimeMs: number): ProcessIdentity => ({
  pid,
  processStartTimeMs: startTimeMs,
  bootId: BOOT
})

describe('process tree snapshot (ADR-014 item 3)', () => {
  it('[ADR-014] descendants are found through parent links, deepest first, and a row older than its supposed parent is not its child', () => {
    const rows = [
      row(1, 0, T0 - 100_000),
      row(10, 1, T0), // the root
      row(11, 10, T0 + 1_000), // child
      row(12, 11, T0 + 2_000), // grandchild
      row(13, 10, T0 - 60_000), // a dangling PPID: pid 10 was reused after 13 started
      row(14, 13, T0 + 3_000), // below the dangling row: not in the tree either
      row(20, 1, T0 + 500) // a sibling of the root
    ]

    expect(descendantsOf(rows, id(10, T0))).toEqual([id(12, T0 + 2_000), id(11, T0 + 1_000)])
  })

  it('[ADR-014, INV-51] a descendant without a readable start time is never listed, so it is never signalled by pid', () => {
    const rows = [row(10, 1, T0), row(11, 10, null), row(12, 10, T0 + 10)]

    expect(descendantsOf(rows, id(10, T0))).toEqual([id(12, T0 + 10)])
  })

  it('[ADR-014, FM-065] survivors are the recorded descendants still listed with the same start time, wherever their parent link now points', () => {
    const recorded = [id(12, T0 + 2_000), id(11, T0 + 1_000), id(15, T0 + 4_000)]
    const later = [
      row(12, 1, T0 + 2_000), // re-parented to init: still a survivor
      row(11, 10, T0 + 9_000), // pid 11 reused by another process: not ours
      row(30, 1, T0)
    ]

    expect(survivorsIn(later, recorded)).toEqual([id(12, T0 + 2_000)])
  })

  it('[ADR-014] the Linux listing reads /proc/<pid>/stat of every numeric entry and skips zombies', async () => {
    const stat = (pid: number, state: string, ppid: number, pgrp: number, ticks: number) =>
      `${pid} (node) ${state} ${ppid} ${pgrp} ${Array.from({ length: 16 }, () => '0').join(' ')} ${ticks} 0\n`
    const files: Record<string, string> = {
      '/proc/stat': 'cpu 1\nbtime 1790000000\n',
      '/proc/10/stat': stat(10, 'S', 1, 10, 500),
      '/proc/11/stat': stat(11, 'Z', 10, 10, 600),
      '/proc/12/stat': stat(12, 'R', 10, 10, 700)
    }
    const reader = createSnapshotReader('linux', {
      listDir: () => Promise.resolve(['10', '11', '12', 'self', 'stat', '99']),
      readText: (path) =>
        path in files
          ? Promise.resolve(files[path] as string)
          : Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' }))
    })

    expect(await reader()).toEqual({
      ok: true,
      value: [row(10, 1, 1_790_000_005_000, 10), row(12, 10, 1_790_000_007_000, 10)]
    })
  })

  it('[ADR-014] the macOS listing is one ps query with a C locale, and the Windows listing one CIM query by the full path of PowerShell without PSModulePath, both argv arrays and bounded', async () => {
    const queries: Array<{
      file: string
      args: readonly string[]
      timeoutMs: number
      dropEnv?: readonly string[]
    }> = []
    const runQuery: QueryRunner = (file, args, options) => {
      queries.push({
        file,
        args,
        timeoutMs: options.timeoutMs,
        ...(options.dropEnv === undefined ? {} : { dropEnv: options.dropEnv })
      })
      return Promise.resolve({
        ok: true,
        stdout:
          file === 'ps'
            ? '   10     1    10 Ss   Sat Aug 29 11:07:36 2026\n   11    10    10 Z    Sat Aug 29 11:07:37 2026\n'
            : '10 1 134352733836959841\r\n4 0 -\r\n'
      })
    }

    const darwin = await createSnapshotReader('darwin', { runQuery })()
    const win32 = await createSnapshotReader('win32', {
      runQuery,
      env: { SystemRoot: 'C:\\Windows' }
    })()

    expect(darwin).toEqual({
      ok: true,
      value: [row(10, 1, new Date(2026, 7, 29, 11, 7, 36).getTime(), 10)]
    })
    expect(win32).toEqual({ ok: true, value: [row(10, 1, 1_790_799_783_695), row(4, 0, null)] })
    expect(queries[0]).toEqual({
      file: 'ps',
      args: ['-A', '-o', 'pid=,ppid=,pgid=,stat=,lstart='],
      timeoutMs: SNAPSHOT_QUERY_TIMEOUT_MS
    })
    expect(queries[1]?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(queries[1]?.dropEnv).toEqual(['PSModulePath'])
    expect(queries[1]?.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command'])
    expect(queries[1]?.args[3]).toContain('Win32_Process')
    expect(queries[1]?.timeoutMs).toBe(SNAPSHOT_QUERY_TIMEOUT_MS)
  })

  it('[ADR-014] a listing that cannot be run or parsed says why instead of listing nothing', async () => {
    const failing = createSnapshotReader('win32', {
      runQuery: () => Promise.resolve({ ok: false, cause: 'timed out after 5000 ms' })
    })

    expect(await failing()).toEqual({ ok: false, cause: 'timed out after 5000 ms' })
    expect(parseDarwinProcessTable('garbage\n')).toBeNull()
    expect(parseWin32ProcessTable('')).toBeNull()
  })
})
