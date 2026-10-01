import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { endpointFor } from '@dwarfai/contracts'
import { resolveUiEndpoint } from './endpointFacts'
import type { QueryRunner } from './processStart'

const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')
const SID = 'S-1-5-5-0-4242'

function whoami(answer: Awaited<ReturnType<QueryRunner>>) {
  const calls: Array<{ file: string; args: readonly string[] }> = []
  const runQuery: QueryRunner = (file, args) => {
    calls.push({ file, args })
    return Promise.resolve(answer)
  }
  return { runQuery, calls }
}

describe('UI endpoint (ADR-002 D2, AM-17-01)', () => {
  it('[ADR-002] on Windows the UI names the same pipe as the Host, from the SID that whoami of System32 reports', async () => {
    const hostDataDir = 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host'
    const run = whoami({ ok: true, stdout: `"desktop\\j","${SID}"\r\n` })
    const endpoint = await resolveUiEndpoint({
      platform: 'win32',
      hostDataDir,
      env: { SystemRoot: 'C:\\Windows' },
      runQuery: run.runQuery
    })
    expect(endpoint).toEqual(endpointFor({ platform: 'win32', hostDataDir, userSid: SID, sha256 }))
    expect(run.calls).toEqual([
      { file: 'C:\\Windows\\System32\\whoami.exe', args: ['/user', '/fo', 'csv', '/nh'] }
    ])

    const failed = whoami({ ok: false, cause: 'timed out after 5000 ms' })
    expect(
      await resolveUiEndpoint({
        platform: 'win32',
        hostDataDir,
        env: {},
        runQuery: failed.runQuery
      })
    ).toEqual({ ok: false, error: { kind: 'user-sid-missing' } })
  })

  it('[ADR-002] on Linux the socket is under XDG_RUNTIME_DIR, else under the data folder', async () => {
    const hostDataDir = '/home/j/.config/DwarfAI-Miners/host'
    expect(
      await resolveUiEndpoint({
        platform: 'linux',
        hostDataDir,
        env: { XDG_RUNTIME_DIR: '/run/user/1000' }
      })
    ).toEqual(
      endpointFor({ platform: 'linux', hostDataDir, xdgRuntimeDir: '/run/user/1000', sha256 })
    )
    expect(await resolveUiEndpoint({ platform: 'linux', hostDataDir, env: {} })).toEqual(
      endpointFor({ platform: 'linux', hostDataDir, sha256 })
    )
  })

  it('[ADR-002] on macOS the profile key folds case exactly when the volume ignores case, as the Host decides', async () => {
    const hostDataDir = '/Users/j/Library/Application Support/DwarfAI-Miners/host'
    const sameFile = { dev: 1, ino: 7 }
    const insensitive = await resolveUiEndpoint({
      platform: 'darwin',
      hostDataDir,
      env: {},
      home: '/Users/j',
      identityOf: () => Promise.resolve(sameFile)
    })
    expect(insensitive).toEqual(
      endpointFor({
        platform: 'darwin',
        hostDataDir,
        home: '/Users/j',
        caseInsensitiveVolume: true,
        sha256
      })
    )
    const sensitive = await resolveUiEndpoint({
      platform: 'darwin',
      hostDataDir,
      env: {},
      home: '/Users/j',
      identityOf: (path) => Promise.resolve(path === hostDataDir ? sameFile : null)
    })
    expect(sensitive).toEqual(
      endpointFor({
        platform: 'darwin',
        hostDataDir,
        home: '/Users/j',
        caseInsensitiveVolume: false,
        sha256
      })
    )
  })
})
