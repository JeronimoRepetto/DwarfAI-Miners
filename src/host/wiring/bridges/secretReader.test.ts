import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../kernel/domain/errors'
import { FakeClock } from '../../kernel/fakes/FakeClock'
import { FakeScheduler } from '../../kernel/fakes/FakeScheduler'
import {
  SECRET_NAMES,
  SECRET_READ_TIMEOUT_MS,
  type SecretName
} from '../../kernel/ports/secretReader'
import { runSecretReaderContract } from '../../kernel/testing/secretReader.contract'
import type { SecretStore } from '../../modules/preferences'
import { FakeSecretStore } from '../../modules/preferences/testing/fakeSecretStore'
import { failClosedSecretReader, storeSecretReader } from './secretReader'

const T0 = 1_790_000_000_000
const JEV_KEY = 'jev-test-key-0324'

function world(store: SecretStore = new FakeSecretStore()) {
  const clock = new FakeClock(T0)
  const scheduler = new FakeScheduler(clock)
  return { clock, scheduler, reader: storeSecretReader({ store, scheduler }) }
}

/** A store whose `get` never settles: a keychain blocked on an unlock prompt (FM-116). */
function blockingStore(): SecretStore & { gets: SecretName[] } {
  const gets: SecretName[] = []
  const fake = new FakeSecretStore()
  return Object.assign(fake, {
    gets,
    get: (name: SecretName) => {
      gets.push(name)
      return new Promise<string | null>(() => undefined)
    }
  })
}

/** Lets the continuations of already-settled promises run (no real timer). */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 10; turn += 1) await Promise.resolve()
}

// Cut 1: the OS secret store is not wired, so nothing is configured (ADR-017).
describe('failClosedSecretReader', () => {
  runSecretReaderContract(() => ({ reader: failClosedSecretReader, configured: {} }))
})

// Step 3a (ISSUE-324): the kernel SecretReader reads through the preferences SecretStore.
describe('storeSecretReader', () => {
  describe('with the Jev key configured', () => {
    runSecretReaderContract(() => {
      const store = new FakeSecretStore()
      void store.set('jev-key', JEV_KEY)
      return { reader: world(store).reader, configured: { 'jev-key': JEV_KEY } }
    })
  })

  describe('with nothing configured', () => {
    runSecretReaderContract(() => ({ reader: world().reader, configured: {} }))
  })

  it('[ADR-017, FM-116, CH-09] a store slower than 10 000 ms answers timeout, never before', async () => {
    const { clock, reader } = world(blockingStore())
    let answer: unknown = 'pending'
    void reader.read('jev-key').then((value) => (answer = value))

    clock.advance(SECRET_READ_TIMEOUT_MS - 1)
    await settle()
    expect(answer).toBe('pending')

    clock.advance(1)
    await settle()
    expect(answer).toBe('timeout')
  })

  it('[ADR-017] a store that answers in time leaves no timeout pending', async () => {
    const store = new FakeSecretStore()
    await store.set('jev-key', JEV_KEY)
    const { scheduler, reader } = world(store)

    await expect(reader.read('jev-key')).resolves.toBe(JEV_KEY)
    expect(scheduler.nextDueAt()).toBeNull()
  })

  it('[ADR-017, FM-116] an answer arriving after the timeout is dropped', async () => {
    let answerLate: (value: string | null) => void = () => undefined
    const store = Object.assign(new FakeSecretStore(), {
      get: () => new Promise<string | null>((resolve) => (answerLate = resolve))
    })
    const { clock, reader } = world(store)
    const read = reader.read('jev-key')

    clock.advance(SECRET_READ_TIMEOUT_MS)
    answerLate(JEV_KEY)

    await expect(read).resolves.toBe('timeout')
  })

  it('[ADR-017] a store failure rejects without the value and leaves no timeout pending', async () => {
    const store = Object.assign(new FakeSecretStore(), {
      get: () => Promise.reject(new Error('SecretStore get of jev-key failed'))
    })
    const { scheduler, reader } = world(store)

    await expect(reader.read('jev-key')).rejects.toThrow('SecretStore get of jev-key failed')
    expect(scheduler.nextDueAt()).toBeNull()
  })

  it('[ADR-017] a name outside the allowlist is refused before the store is asked', async () => {
    const store = blockingStore()
    const { reader } = world(store)

    await expect(reader.read('anthropic-api-key' as SecretName)).rejects.toBeInstanceOf(
      HostInvariantError
    )
    expect(store.gets).toEqual([])
    for (const name of SECRET_NAMES) void reader.read(name)
    expect(store.gets).toEqual([...SECRET_NAMES])
  })
})
