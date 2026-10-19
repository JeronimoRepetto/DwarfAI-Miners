import { describe, expect, it } from 'vitest'
import {
  IDENTITY_TOLERANCE_MS,
  createIdentityProbe,
  createProcessStartReader,
  type QueryRunner,
  type StartRead
} from './processStart'
import { runIdentityProbeContract } from './testing/identityProbe.contract'

/** A query runner answering from a table keyed by the program's file name. */
function runner(answers: Record<string, Awaited<ReturnType<QueryRunner>>>) {
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const run: QueryRunner = (file, args) => {
    calls.push({ file, args })
    const name = Object.keys(answers).find((key) => file.endsWith(key))
    return Promise.resolve(name === undefined ? { ok: false, cause: 'no answer' } : answers[name]!)
  }
  return { run, calls }
}

// 2026-10-01T10:00:00.000Z as a Windows FILETIME (100 ns since 1601).
const FILETIME = '134353224000000000'
const EPOCH_MS = Date.UTC(2026, 9, 1, 10, 0, 0)

describe('process start reader (ADR-002 D3 gate owner identity)', () => {
  it('[ADR-002, FM-010] on Windows the start time comes from PowerShell by path, a missing process is gone and a failed query is unknown', async () => {
    const ok = runner({ 'powershell.exe': { ok: true, stdout: `${FILETIME}\r\n` } })
    const read = createProcessStartReader({
      platform: 'win32',
      runQuery: ok.run,
      env: { SystemRoot: 'C:\\Windows' }
    })
    expect(await read(4242)).toEqual({ kind: 'started', ms: EPOCH_MS })
    expect(ok.calls[0]?.file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(ok.calls[0]?.args.join(' ')).toContain('Get-Process -Id 4242')

    const gone = runner({ 'powershell.exe': { ok: true, stdout: 'gone\r\n' } })
    expect(await createProcessStartReader({ platform: 'win32', runQuery: gone.run })(4242)).toEqual(
      { kind: 'gone' }
    )
    const hung = runner({ 'powershell.exe': { ok: false, cause: 'timed out after 5000 ms' } })
    expect(await createProcessStartReader({ platform: 'win32', runQuery: hung.run })(4242)).toEqual(
      { kind: 'unknown' }
    )
  })

  it('[ADR-002, FM-010] on Linux the start time comes from procfs, and a missing /proc entry is gone', async () => {
    const files: Record<string, string> = {
      '/proc/4242/stat':
        '4242 (dwarf ai) S 1 4242 4242 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 12345 0 0',
      '/proc/stat': 'cpu 1 2 3\nbtime 1790000000\n'
    }
    const readText = (path: string): Promise<string> =>
      path in files
        ? Promise.resolve(files[path]!)
        : Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }))
    const read = createProcessStartReader({ platform: 'linux', readText })
    expect(await read(4242)).toEqual({ kind: 'started', ms: 1_790_000_000_000 + 123_450 })
    expect(await read(17)).toEqual({ kind: 'gone' })
  })

  it('[ADR-002, FM-010] on macOS the start time comes from ps lstart, and a pid ps does not know is gone', async () => {
    const ok = runner({ ps: { ok: true, stdout: 'Thu Oct  1 12:00:00 2026\n' } })
    const read = createProcessStartReader({ platform: 'darwin', runQuery: ok.run })
    expect(await read(4242)).toEqual({ kind: 'started', ms: new Date(2026, 9, 1, 12).getTime() })
    expect(ok.calls[0]?.args).toEqual(['-p', '4242', '-o', 'lstart='])

    const gone = runner({ ps: { ok: false, cause: 'exited with code 1', code: 1, stdout: '' } })
    expect(
      await createProcessStartReader({ platform: 'darwin', runQuery: gone.run })(4242)
    ).toEqual({ kind: 'gone' })
  })

  it('[ADR-002, FM-010] an owner is alive while its pid runs with a start time within 2 000 ms; gone or another start is not, unknown counts as alive', async () => {
    const reads = new Map<number, StartRead>([
      [1, { kind: 'started', ms: 10_000 + IDENTITY_TOLERANCE_MS }],
      [2, { kind: 'started', ms: 10_000 + IDENTITY_TOLERANCE_MS + 1 }],
      [3, { kind: 'gone' }],
      [4, { kind: 'unknown' }]
    ])
    const probe = createIdentityProbe((pid) => Promise.resolve(reads.get(pid)!))
    expect(await probe({ pid: 1, processStartTimeMs: 10_000 })).toBe(true)
    expect(await probe({ pid: 2, processStartTimeMs: 10_000 })).toBe(false)
    expect(await probe({ pid: 3, processStartTimeMs: 10_000 })).toBe(false)
    expect(await probe({ pid: 4, processStartTimeMs: 10_000 })).toBe(true)
  })
})

// L3: the real probe over a scripted start-time reader; its OS readers are the L8 leg (processStart.os.test.ts).
runIdentityProbeContract('createIdentityProbe over a scripted reader', () => {
  const live = { pid: 4242, processStartTimeMs: 1_759_395_600_000 }
  const probe = createIdentityProbe((pid) =>
    Promise.resolve(
      pid === live.pid ? { kind: 'started', ms: live.processStartTimeMs } : { kind: 'gone' }
    )
  )
  return Promise.resolve({ probe, live, gonePid: 4343 })
})
