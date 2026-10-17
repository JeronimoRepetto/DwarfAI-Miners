// layer: L2
// L2 (17 §1.2): `PreferencesCommands.saveSecret` / `clearSecret` and `PreferencesQueries.secretStatus`
// (16 §4.12, §4.12.1; ADR-017 items 1, 4, 5; 06 §14.2 INV-107; 08 `SecretStatusChanged`; UC-029) over
// the `FakeSecretStore` double, a recording bus, a FakeClock and a sequence id generator.
//
// TC-216-01 (the module half), TC-216-02, TC-216-03.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { RecordingEventBus } from '../../../kernel/fakes/RecordingEventBus'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { PreferencesEvent } from '../domain/events'
import { FakeSecretStore } from '../ports/fakes/FakeSecretStore'
import type { SecretName, SecretStore } from '../ports/secretStore'
import { SecretStatusService } from './preferencesService'

const T0 = 1_750_000_000_000
const EPOCH = 'epoch-0216'
/** A seeded value: anything that carries it out of the store is a leak. */
const SEEDED = 'sk-seeded-216-0f3c9a7e5b1d'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The fake, with the next `set` scripted to fail with `failure` (a store that changed under us). */
class ScriptedSecretStore extends FakeSecretStore {
  failure: Error | null = null
  override set(name: SecretName, value: string): Promise<void> {
    const failure = this.failure
    this.failure = null
    return failure === null ? super.set(name, value) : Promise.reject(failure)
  }
}

/** Records every call the service makes on the store, never the value it was given. */
class CallLog implements SecretStore {
  readonly calls: string[] = []
  constructor(private readonly inner: SecretStore) {}
  backend() {
    this.calls.push('backend')
    return this.inner.backend()
  }
  get(name: SecretName) {
    this.calls.push(`get ${name}`)
    return this.inner.get(name)
  }
  has(name: SecretName) {
    this.calls.push(`has ${name}`)
    return this.inner.has(name)
  }
  set(name: SecretName, value: string) {
    this.calls.push(`set ${name}`)
    return this.inner.set(name, value)
  }
  delete(name: SecretName) {
    this.calls.push(`delete ${name}`)
    return this.inner.delete(name)
  }
}

function secrets() {
  const store = new ScriptedSecretStore()
  const recorded = new CallLog(store)
  const bus = new RecordingEventBus<PreferencesEvent>()
  const service = new SecretStatusService({
    secrets: recorded,
    bus,
    clock: new FakeClock(T0),
    ids: new SequenceIdGenerator(),
    hostEpoch: EPOCH
  })
  return { service, store, recorded, bus }
}

describe('saveSecret and clearSecret (16 §4.12; ADR-017)', () => {
  it('[INV-107] saving a key makes no network call and never validates it', async () => {
    const fetches: unknown[] = []
    vi.stubGlobal('fetch', (...args: unknown[]) => {
      fetches.push(args)
      return Promise.reject(new Error('no network in this suite'))
    })
    const { service, store, recorded } = secrets()

    // A value no provider would accept is stored as typed: saving never asks anyone (UC-029).
    const status = await service.saveSecret('jev-key', SEEDED)

    expect(status).toStrictEqual({ name: 'jev-key', configured: true })
    expect(await store.get('jev-key')).toBe(SEEDED)
    expect(fetches).toStrictEqual([])
    // The store is asked to write and to answer the flag; the value is never read back (16 §4.12.1:
    // `get` only from the readers behind `SecretReader`).
    expect(recorded.calls).toStrictEqual(['backend', 'set jev-key', 'has jev-key'])
    expect(JSON.stringify(status)).not.toContain(SEEDED)
  })

  it('[ADR-017] a save or a clear publishes SecretStatusChanged with the configured flag and never the value', async () => {
    const { service, bus } = secrets()

    await service.saveSecret('opencode-password', SEEDED)
    await service.clearSecret('opencode-password')

    const changed = bus.ofType('SecretStatusChanged')
    expect(changed.map((event) => event.payload)).toStrictEqual([
      { status: { name: 'opencode-password', configured: true } },
      { status: { name: 'opencode-password', configured: false } }
    ])
    expect(changed[0]).toMatchObject({ v: 1, at: T0, hostEpoch: EPOCH })
    expect(JSON.stringify(bus.published)).not.toContain(SEEDED)
  })

  it('[ADR-017] secretStatus answers the flag of the last save or clear, for that name only', async () => {
    const { service } = secrets()

    await service.saveSecret('jev-key', SEEDED)

    expect(service.secretStatus('jev-key')).toStrictEqual({ name: 'jev-key', configured: true })
    expect(service.secretStatus('opencode-password')).toStrictEqual({
      name: 'opencode-password',
      configured: false
    })
    expect(service.secretStatuses()).toStrictEqual([
      { name: 'jev-key', configured: true },
      { name: 'opencode-password', configured: false }
    ])
    expect(service.secretBackend()).toBe('os-secret-store')

    await service.clearSecret('jev-key')
    expect(service.secretStatus('jev-key')).toStrictEqual({ name: 'jev-key', configured: false })
  })

  it('[ADR-017, FM-115] with an unavailable backend saveSecret answers configured false, writes nothing and reports the backend', async () => {
    const { service, store, recorded, bus } = secrets()
    store.setBackend('unavailable')

    const status = await service.saveSecret('jev-key', SEEDED)

    expect(status).toStrictEqual({ name: 'jev-key', configured: false })
    // No plain-text fallback (ADR-017 item 5): the store is never asked to write.
    expect(recorded.calls).not.toContain('set jev-key')
    store.setBackend('os-secret-store')
    expect(await store.get('jev-key')).toBeNull()
    expect(service.secretBackend()).toBe('unavailable')
    expect(bus.ofType('SecretStatusChanged').map((event) => event.payload)).toStrictEqual([
      { status: { name: 'jev-key', configured: false } }
    ])
  })

  it('[ADR-017, FM-115] a set refused as SecretStoreUnavailable after the backend answered available writes nothing and answers configured false', async () => {
    const { service, store } = secrets()
    // The secret service went away between `backend()` and `set` (ADR-017 item 5).
    store.failure = Object.assign(
      new Error('SecretStoreUnavailable: no usable OS secret service'),
      {
        name: 'SecretStoreUnavailable'
      }
    )

    const status = await service.saveSecret('jev-key', SEEDED)

    expect(status).toStrictEqual({ name: 'jev-key', configured: false })
    expect(service.secretBackend()).toBe('unavailable')
  })

  it('[ADR-017] clearSecret answers configured false and a second clear succeeds', async () => {
    const { service, store } = secrets()
    await service.saveSecret('jev-key', SEEDED)

    expect(await service.clearSecret('jev-key')).toStrictEqual({
      name: 'jev-key',
      configured: false
    })
    expect(await service.clearSecret('jev-key')).toStrictEqual({
      name: 'jev-key',
      configured: false
    })
    expect(await store.get('jev-key')).toBeNull()
    expect(store.deleted).toStrictEqual(['jev-key', 'jev-key'])
  })

  it('[ADR-017] with an unavailable backend clearSecret is a successful no-op answering configured false', async () => {
    const { service, store } = secrets()
    store.setBackend('unavailable')

    expect(await service.clearSecret('opencode-password')).toStrictEqual({
      name: 'opencode-password',
      configured: false
    })
    expect(service.secretBackend()).toBe('unavailable')
  })

  it('[ADR-017] loadSecretStatuses reads the backend and every flag from the store; before it nothing is configured', async () => {
    const { service, store } = secrets()
    await store.set('opencode-password', SEEDED)

    expect(service.secretStatuses()).toStrictEqual([
      { name: 'jev-key', configured: false },
      { name: 'opencode-password', configured: false }
    ])
    expect(service.secretBackend()).toBe('unavailable')

    await service.loadSecretStatuses()

    expect(service.secretStatuses()).toStrictEqual([
      { name: 'jev-key', configured: false },
      { name: 'opencode-password', configured: true }
    ])
    expect(service.secretBackend()).toBe('os-secret-store')
  })

  it('[ADR-017] saves and clears run one at a time, in the order asked', async () => {
    const { service, store } = secrets()

    const results = await Promise.all([
      service.saveSecret('jev-key', SEEDED),
      service.clearSecret('jev-key'),
      service.saveSecret('jev-key', `${SEEDED}-2`)
    ])

    expect(results.map((status) => status.configured)).toStrictEqual([true, false, true])
    expect(await store.get('jev-key')).toBe(`${SEEDED}-2`)
    expect(service.secretStatus('jev-key').configured).toBe(true)
  })

  it('[ADR-017] a store failure other than an unavailable backend rejects without the value and publishes nothing', async () => {
    const { service, store, bus } = secrets()
    store.failure = new Error('keyring locked')

    const failure = await service.saveSecret('jev-key', SEEDED).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect(String((failure as Error).message)).not.toContain(SEEDED)
    expect(bus.ofType('SecretStatusChanged')).toStrictEqual([])
    // The queue is not stuck behind the failure.
    expect(await service.saveSecret('jev-key', SEEDED)).toStrictEqual({
      name: 'jev-key',
      configured: true
    })
  })
})
