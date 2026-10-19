import { describe, expect, it } from 'vitest'
import type { QueryRunner } from '../process/probe/types'
import { createNodeEndpointFacts, type FileIdentity } from './nodeEndpointEnv'

// L3 adapter (17 §1.3): the facts the Host feeds the ADR-002 D2 endpoint rule, with the OS reads
// injected so each OS's branch runs on any host. Synthetic identities only (privacy-guard).

const SID = 'S-1-5-5-0-4242'

/** A runner that answers one fixed stdout and records each call. */
function runner(answer: Awaited<ReturnType<QueryRunner>>): {
  run: QueryRunner
  calls: Array<{ file: string; args: readonly string[] }>
} {
  const calls: Array<{ file: string; args: readonly string[] }> = []
  return {
    calls,
    run: (file, args) => {
      calls.push({ file, args })
      return Promise.resolve(answer)
    }
  }
}

/** A volume of `paths`: each path has an identity; a case-insensitive one also answers any case. */
function volume(
  paths: readonly string[],
  caseInsensitive: boolean
): (path: string) => Promise<FileIdentity | null> {
  return (path) => {
    const index = paths.findIndex((known) =>
      caseInsensitive ? known.toLowerCase() === path.toLowerCase() : known === path
    )
    return Promise.resolve(index === -1 ? null : { dev: 1, ino: 100 + index })
  }
}

describe('Node endpoint facts (ADR-002 D2)', () => {
  it('[ADR-002] on Windows the user SID is read from whoami of System32 by path and the hash is SHA-256 hex', async () => {
    const whoami = runner({ ok: true, stdout: `"canary\\j","${SID}"\r\n` })
    const facts = createNodeEndpointFacts({
      platform: 'win32',
      hostDataDir: 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host',
      runQuery: whoami.run,
      env: { SystemRoot: 'C:\\Windows' }
    })

    const result = await facts()

    expect(whoami.calls).toEqual([
      { file: 'C:\\Windows\\System32\\whoami.exe', args: ['/user', '/fo', 'csv', '/nh'] }
    ])
    expect(result).toEqual({
      ok: true,
      value: expect.objectContaining({
        platform: 'win32',
        hostDataDir: 'C:\\Users\\j\\AppData\\Roaming\\DwarfAI-Miners\\host',
        userSid: SID
      })
    })
    if (!result.ok) return
    // FIPS 180-2 test vector for "abc".
    expect(result.value.sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    )
  })

  it('[ADR-002] a SID that cannot be read is a failed read with its cause, never a guessed value', async () => {
    for (const [answer, cause] of [
      [{ ok: false, cause: 'timed out after 5000 ms' }, 'timed out after 5000 ms'],
      [{ ok: true, stdout: 'no sid here' }, 'gave an unparseable answer']
    ] as const) {
      const facts = createNodeEndpointFacts({
        platform: 'win32',
        hostDataDir: 'C:\\h\\host',
        runQuery: runner(answer).run,
        env: {}
      })

      expect(await facts()).toEqual({ ok: false, cause })
    }
  })

  it('[ADR-002] on macOS the volume is case-insensitive only when the case-swapped path is the same file, probed on the nearest existing folder', async () => {
    const hostDataDir = '/Users/j/Library/Application Support/DwarfAI-Miners/host'
    // hostDataDir does not exist yet (first start): the probe walks up to its parent.
    const existing = ['/Users/j/Library/Application Support/DwarfAI-Miners']
    for (const caseInsensitive of [true, false]) {
      const facts = createNodeEndpointFacts({
        platform: 'darwin',
        hostDataDir,
        home: '/Users/j',
        env: {},
        identityOf: volume(existing, caseInsensitive)
      })

      expect(await facts(), String(caseInsensitive)).toEqual({
        ok: true,
        value: expect.objectContaining({
          platform: 'darwin',
          home: '/Users/j',
          caseInsensitiveVolume: caseInsensitive
        })
      })
    }
  })

  it('[ADR-002] on Linux the facts carry XDG_RUNTIME_DIR and never a case probe', async () => {
    const facts = createNodeEndpointFacts({
      platform: 'linux',
      hostDataDir: '/home/j/.config/DwarfAI-Miners/host',
      env: { XDG_RUNTIME_DIR: '/run/user/1000' },
      identityOf: () => Promise.reject(new Error('no probe on Linux'))
    })

    expect(await facts()).toEqual({
      ok: true,
      value: expect.objectContaining({ platform: 'linux', xdgRuntimeDir: '/run/user/1000' })
    })
  })
})
