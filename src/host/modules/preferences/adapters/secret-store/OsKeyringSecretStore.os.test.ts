import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findCredentialsAsync } from '@napi-rs/keyring'
import { afterEach, describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import type { SecretName } from '../../ports/secretStore'
import { runSecretStoreContract } from '../../testing/secretStore.contract'
import { NapiKeyringBinding } from './napiKeyringBinding'
import { OsKeyringSecretStore } from './OsKeyringSecretStore'
import { drawRunService, redirectedKeyringBinding } from './testing/redirectedKeyringBinding'
import { ScriptedKeyringBinding } from './testing/ScriptedKeyringBinding'

// L8 (17 §1.8): `OsKeyringSecretStore` over the real OS secret store through `@napi-rs/keyring` —
// Windows Credential Manager, macOS Keychain, Linux Secret Service. Linux without a Secret Service
// is OsKeyringSecretStore.noSecretService.os.test.ts, in its own process so its broken session bus
// never reaches these cases.
//
// The person's own entries are never touched: the store asks for service `DwarfAI-Miners` (the
// redirected binding fails the test if it asks for any other), and that binding stores the
// service's entries under a service unique to this run, which every case deletes afterwards. Values are
// drawn at run time and never printed.

const drawValue = (): string => randomBytes(24).toString('base64url')
const NAMES = ['jev-key', 'opencode-password'] as const satisfies SecretName[]

const runService = drawRunService()
const backendUp = await new NapiKeyringBinding(runService).available()

async function removeRunEntries(): Promise<void> {
  const real = new NapiKeyringBinding(runService)
  for (const name of NAMES) await real.remove(runService, name)
}

// Windows and macOS always have their secret store, so the cases must run there; Linux runs them
// when its session has a Secret Service.
describe.runIf(process.platform !== 'linux' || backendUp)('OsKeyringSecretStore (OS)', () => {
  afterEach(removeRunEntries)

  runSecretStoreContract((backend) => {
    const log = new RecordingDiagnosticsLog()
    // The real store when the service is usable; with no usable service the contract runs over a
    // binding reporting none, since this OS cannot be made to lose its store (the real Linux case
    // is the no-Secret-Service file).
    const binding =
      backend === 'os-secret-store'
        ? redirectedKeyringBinding(runService)
        : new ScriptedKeyringBinding({ available: false })
    const dataDirs = [
      mkdtempSync(join(tmpdir(), 'dwarfai-host-')),
      mkdtempSync(join(tmpdir(), 'dwarfai-ui-'))
    ]
    return {
      store: new OsKeyringSecretStore(binding, log),
      logText: () => JSON.stringify([log.entries, log.refused]),
      dataDirs,
      dispose: async () => {
        await removeRunEntries()
        for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('[ADR-017, C-22] the entry is stored under service DwarfAI-Miners with the secret name as account and survives a new store instance', async () => {
    const values = { 'jev-key': drawValue(), 'opencode-password': drawValue() }
    const first = new OsKeyringSecretStore(
      redirectedKeyringBinding(runService),
      new RecordingDiagnosticsLog()
    )

    expect(await first.backend()).toBe('os-secret-store')
    for (const name of NAMES) await first.set(name, values[name])

    const listed = await findCredentialsAsync(runService)
    expect(listed.map((credential) => credential.account).sort()).toStrictEqual([...NAMES].sort())

    const second = new OsKeyringSecretStore(
      redirectedKeyringBinding(runService),
      new RecordingDiagnosticsLog()
    )
    for (const name of NAMES) expect(await second.get(name)).toBe(values[name])

    for (const name of NAMES) expect(await second.delete(name)).toBe('deleted')
    expect(await findCredentialsAsync(runService)).toStrictEqual([])
    expect(await first.has('jev-key')).toBe(false)
  })
})
