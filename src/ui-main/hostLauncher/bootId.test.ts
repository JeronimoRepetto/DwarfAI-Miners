// layer: L2
import { describe, expect, it } from 'vitest'
import { createBootIdReader, WIN32_BOOT_ID_KEY } from './bootId'
import type { QueryRunner } from './processStart'

// L2 (17 §1.2): the UI's restatement of the Host's boot id (ADR-015 item 4; ADR-014 item 1) over scripted OS answers,
// for the hung-Host identity rule (ADR-002 D9 step 2). The real reads are checked against a real Host's identity file
// in hungHost.os.test.ts.

/** A query runner that answers `answer` and records each call. */
function scripted(answer: Awaited<ReturnType<QueryRunner>>) {
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const runQuery: QueryRunner = (file, args) => {
    calls.push({ file, args })
    return Promise.resolve(answer)
  }
  return { calls, runQuery }
}

describe('createBootIdReader (ADR-015 item 4)', () => {
  it('[ADR-014] on Windows the registry BootId counter is read with reg.exe by full path and given as a decimal string', async () => {
    const { calls, runQuery } = scripted({
      ok: true,
      stdout: `\r\n${WIN32_BOOT_ID_KEY}\r\n    BootId    REG_DWORD    0x2a\r\n\r\n`
    })
    const read = createBootIdReader({ platform: 'win32', runQuery, env: { SystemRoot: 'D:\\Win' } })

    expect(await read()).toBe('42')
    expect(calls).toEqual([
      { file: 'D:\\Win\\System32\\reg.exe', args: ['query', WIN32_BOOT_ID_KEY, '/v', 'BootId'] }
    ])
  })

  it('[ADR-014] on Linux the kernel boot_id file is the boot id, and on macOS kern.bootsessionuuid', async () => {
    const linux = createBootIdReader({
      platform: 'linux',
      readText: (path) =>
        path === '/proc/sys/kernel/random/boot_id'
          ? Promise.resolve('0f6b5c2e-1111-4222-8333-944445555666\n')
          : Promise.reject(new Error('unexpected'))
    })
    expect(await linux()).toBe('0f6b5c2e-1111-4222-8333-944445555666')

    const { calls, runQuery } = scripted({
      ok: true,
      stdout: 'A1B2C3D4-0000-1111-2222-333344445555\n'
    })
    expect(await createBootIdReader({ platform: 'darwin', runQuery })()).toBe(
      'A1B2C3D4-0000-1111-2222-333344445555'
    )
    expect(calls).toEqual([{ file: 'sysctl', args: ['-n', 'kern.bootsessionuuid'] }])
  })

  it('[ADR-014] a failed or unparseable read is null, so the identity does not match', async () => {
    expect(
      await createBootIdReader({
        platform: 'win32',
        runQuery: scripted({ ok: false, cause: 'exited with code 1', code: 1 }).runQuery
      })()
    ).toBeNull()
    expect(
      await createBootIdReader({
        platform: 'win32',
        runQuery: scripted({ ok: true, stdout: 'BootId REG_SZ seven' }).runQuery
      })()
    ).toBeNull()
    expect(
      await createBootIdReader({
        platform: 'linux',
        readText: () => Promise.reject(new Error('EACCES'))
      })()
    ).toBeNull()
    expect(
      await createBootIdReader({
        platform: 'darwin',
        runQuery: scripted({ ok: true, stdout: '\n' }).runQuery
      })()
    ).toBeNull()
  })
})
