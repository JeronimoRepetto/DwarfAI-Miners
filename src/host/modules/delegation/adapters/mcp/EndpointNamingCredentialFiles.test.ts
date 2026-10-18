// L3 (17 §1.3): the credential files the lifecycle writes name the MCP endpoint the Host bound
// (foreman decision 2026-10-18, in place of the rejected AMENDMENT-24; ADR-013 items 2–3), over
// the real RunDirCredentialFileStore in a temp directory, one per test (17 §5.3).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { LaunchId } from '../../../../kernel/domain/values'
import { runCredentialFileStoreContract } from '../../testing/credentialFileStore.contract'
import { RunDirCredentialFileStore } from '../fs/RunDirCredentialFileStore'
import { EndpointNamingCredentialFiles } from './EndpointNamingCredentialFiles'
import { MAX_CREDENTIAL_FILE_BYTES, parseCredentialFile } from './relay/credentialFileLayout'

const LAUNCH = '01890a5d-ac96-774b-bcce-b302099a8a01' as LaunchId
const CREDENTIAL = 'a1'.repeat(32)
const XDG_ENDPOINT = '/run/user/1000/dwarfai/mcp-0123456789ab.sock'
const PIPE = '\\\\.\\pipe\\dwarfai-mcp-0123456789abcdef-0123456789ab'

function temp(): { hostDataDir: string; dispose: () => void } {
  const hostDataDir = mkdtempSync(join(tmpdir(), 'dwarfai-cred-endpoint-'))
  return { hostDataDir, dispose: () => rmSync(hostDataDir, { recursive: true, force: true }) }
}

describe('EndpointNamingCredentialFiles before the MCP endpoint listens', () => {
  runCredentialFileStoreContract(() => {
    const { hostDataDir, dispose } = temp()
    return {
      store: new EndpointNamingCredentialFiles(
        new RunDirCredentialFileStore({ hostDataDir }),
        () => null
      ),
      read: (path) => (existsSync(path) ? readFileSync(path, 'utf8') : null),
      dispose
    }
  })
})

describe('EndpointNamingCredentialFiles (ADR-013 item 3)', () => {
  it('[ADR-013] once the endpoint listens, the file holds the credential and the endpoint in the exact layout the relay reads', async () => {
    for (const endpoint of [XDG_ENDPOINT, PIPE]) {
      const { hostDataDir, dispose } = temp()
      try {
        const files = new EndpointNamingCredentialFiles(
          new RunDirCredentialFileStore({ hostDataDir }),
          () => endpoint
        )
        const written = await files.write(LAUNCH, CREDENTIAL)
        if (!written.ok) throw new Error(String(written.error))

        expect(written.value.path).toBe(join(hostDataDir, 'run', 'mcp', `${LAUNCH}.cred`))
        const text = readFileSync(written.value.path, 'utf8')
        expect(text).toBe(JSON.stringify({ v: 1, credential: CREDENTIAL, endpoint }))
        expect(parseCredentialFile(text)).toEqual({ credential: CREDENTIAL, endpoint })
        expect(await files.list()).toEqual([LAUNCH])
      } finally {
        dispose()
      }
    }
  })

  it('[ADR-013] the endpoint is read at each write, and one too long for the byte cap leaves the credential alone', async () => {
    const { hostDataDir, dispose } = temp()
    try {
      let endpoint: string | null = null
      const files = new EndpointNamingCredentialFiles(
        new RunDirCredentialFileStore({ hostDataDir }),
        () => endpoint
      )
      const first = await files.write(LAUNCH, CREDENTIAL)
      endpoint = XDG_ENDPOINT
      const second = await files.write(
        '01890a5d-ac96-774b-bcce-b302099a8a02' as LaunchId,
        CREDENTIAL
      )
      endpoint = `/${'d'.repeat(MAX_CREDENTIAL_FILE_BYTES)}`
      const third = await files.write(
        '01890a5d-ac96-774b-bcce-b302099a8a03' as LaunchId,
        CREDENTIAL
      )
      if (!first.ok || !second.ok || !third.ok) throw new Error('write failed')

      expect(readFileSync(first.value.path, 'utf8')).toBe(CREDENTIAL)
      expect(parseCredentialFile(readFileSync(second.value.path, 'utf8'))).toEqual({
        credential: CREDENTIAL,
        endpoint: XDG_ENDPOINT
      })
      expect(readFileSync(third.value.path, 'utf8')).toBe(CREDENTIAL)
    } finally {
      dispose()
    }
  })
})
