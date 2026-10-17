import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { RecordingDiagnosticsLog } from '../../../../kernel/fakes/RecordingDiagnosticsLog'
import { runSecretStoreContract } from '../../testing/secretStore.contract'
import { OsKeyringSecretStore, SECRET_SERVICE } from './OsKeyringSecretStore'
import { ScriptedKeyringBinding } from './testing/ScriptedKeyringBinding'

// L3 (17 §1.3): the adapter runs the same contract as `FakeSecretStore`, over a scripted keyring
// binding. The real keyring half runs in the OS lane (OsKeyringSecretStore.os.test.ts,
// OsKeyringSecretStore.noSecretService.os.test.ts).

const drawValue = (): string => randomBytes(24).toString('base64url')

function world(options: { available?: boolean } = {}): {
  binding: ScriptedKeyringBinding
  log: RecordingDiagnosticsLog
  store: OsKeyringSecretStore
} {
  const binding = new ScriptedKeyringBinding(options)
  const log = new RecordingDiagnosticsLog()
  return { binding, log, store: new OsKeyringSecretStore(binding, log) }
}

/** Everything an error carries that a caller could print or log. */
function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return [error.name, error.message, error.stack ?? '', JSON.stringify(error)].join('\n')
}

describe('OsKeyringSecretStore', () => {
  runSecretStoreContract((backend) => {
    const { log, store } = world({ available: backend === 'os-secret-store' })
    const dataDirs = [
      mkdtempSync(join(tmpdir(), 'dwarfai-host-')),
      mkdtempSync(join(tmpdir(), 'dwarfai-ui-'))
    ]
    return {
      store,
      logText: () => JSON.stringify([log.entries, log.refused]),
      dataDirs,
      dispose: () => {
        for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('[ADR-017, C-22] each secret is one entry under service DwarfAI-Miners with the secret name as account, read back by a new store instance', async () => {
    const { binding, store } = world()
    const jevKey = drawValue()
    const password = drawValue()

    await store.set('jev-key', jevKey)
    await store.set('opencode-password', password)

    expect(SECRET_SERVICE).toBe('DwarfAI-Miners')
    expect([...binding.snapshot()]).toStrictEqual([
      ['DwarfAI-Miners/jev-key', jevKey],
      ['DwarfAI-Miners/opencode-password', password]
    ])
    const restarted = new OsKeyringSecretStore(binding, new RecordingDiagnosticsLog())
    expect(await restarted.get('jev-key')).toBe(jevKey)
    expect(await restarted.get('opencode-password')).toBe(password)
  })

  it('[ADR-017, FM-115] the secret service is probed once, and when it is unavailable the keyring is never touched', async () => {
    const { binding, store } = world({ available: false })

    expect(await store.backend()).toBe('unavailable')
    await expect(store.set('jev-key', drawValue())).rejects.toThrow(/SecretStoreUnavailable/)
    expect(await store.get('jev-key')).toBeNull()
    expect(await store.has('opencode-password')).toBe(false)
    expect(await store.delete('jev-key')).toBe('unavailable')
    expect(await store.backend()).toBe('unavailable')

    expect(binding.probes).toBe(1)
    expect(binding.calls).toStrictEqual([])
    expect(binding.snapshot().size).toBe(0)
  })

  it('[ADR-017, FM-115] a probe that fails counts as no secret service', async () => {
    const binding = new ScriptedKeyringBinding()
    binding.available = () => Promise.reject(new Error('the library failed to load'))
    const store = new OsKeyringSecretStore(binding, new RecordingDiagnosticsLog())

    expect(await store.backend()).toBe('unavailable')
    await expect(store.set('jev-key', drawValue())).rejects.toThrow(/SecretStoreUnavailable/)
    expect(binding.calls).toStrictEqual([])
  })

  it('[ADR-017, C-23, FM-115] a secret service lost after the probe still fails set, answers not configured and resolves delete unavailable', async () => {
    const { binding, store } = world()
    expect(await store.backend()).toBe('os-secret-store')
    binding.failWith('unavailable')

    await expect(store.set('jev-key', drawValue())).rejects.toThrow(/SecretStoreUnavailable/)
    expect(await store.get('jev-key')).toBeNull()
    expect(await store.has('jev-key')).toBe(false)
    expect(await store.delete('jev-key')).toBe('unavailable')
    expect(binding.snapshot().size).toBe(0)
  })

  it('[ADR-017, NFR-SEC-12] a keyring failure on an available backend rejects get, set and delete without the value or the library message', async () => {
    const { binding, store } = world()
    const value = drawValue()
    binding.failWith(new Error(`library said: cannot store ${value}`))

    const errors: unknown[] = []
    await store.set('jev-key', value).catch((error: unknown) => errors.push(error))
    await store.get('jev-key').catch((error: unknown) => errors.push(error))
    await store.delete('jev-key').catch((error: unknown) => errors.push(error))

    expect(errors).toHaveLength(3)
    for (const error of errors) {
      expect(error).toBeInstanceOf(Error)
      expect(errorText(error)).not.toContain(value)
      expect(errorText(error)).not.toContain('library said')
    }
  })

  it('[ADR-017, NFR-SEC-12] set and delete record secret.op with the name, the operation and the outcome, never the value', async () => {
    const value = drawValue()
    const up = world()
    await up.store.set('jev-key', value)
    await up.store.delete('jev-key')
    up.binding.failWith(new Error('locked'))
    await up.store.delete('opencode-password').catch(() => undefined)
    const down = world({ available: false })
    await down.store.set('jev-key', value).catch(() => undefined)
    await down.store.delete('opencode-password')

    expect(up.log.refused).toStrictEqual([])
    expect(down.log.refused).toStrictEqual([])
    expect(up.log.byEvent('secret.op')).toStrictEqual([
      {
        level: 'info',
        event: 'secret.op',
        subsystem: 'preferences',
        msg: 'jev-key set',
        outcome: 'ok'
      },
      {
        level: 'info',
        event: 'secret.op',
        subsystem: 'preferences',
        msg: 'jev-key delete',
        outcome: 'ok'
      },
      {
        level: 'warn',
        event: 'secret.op',
        subsystem: 'preferences',
        msg: 'opencode-password delete',
        outcome: 'failed'
      }
    ])
    expect(down.log.byEvent('secret.op')).toStrictEqual([
      {
        level: 'warn',
        event: 'secret.op',
        subsystem: 'preferences',
        msg: 'jev-key set',
        outcome: 'failed',
        causeClass: 'backend-unavailable'
      },
      {
        level: 'info',
        event: 'secret.op',
        subsystem: 'preferences',
        msg: 'opencode-password delete',
        outcome: 'skipped',
        causeClass: 'backend-unavailable'
      }
    ])
    expect(JSON.stringify([up.log.entries, down.log.entries])).not.toContain(value)
  })
})
