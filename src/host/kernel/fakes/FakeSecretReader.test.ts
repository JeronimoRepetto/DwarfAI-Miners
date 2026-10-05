import { describe, expect, it } from 'vitest'
import { SECRET_READ_TIMEOUT_MS } from '../ports/secretReader'
import { runSecretReaderContract } from '../testing/secretReader.contract'
import { FakeClock } from './FakeClock'
import { FakeScheduler } from './FakeScheduler'
import { FakeSecretReader } from './FakeSecretReader'

function fake(values: ConstructorParameters<typeof FakeSecretReader>[0]['values'] = {}) {
  const clock = new FakeClock(0)
  const scheduler = new FakeScheduler(clock)
  return { reader: new FakeSecretReader({ values, scheduler }), clock }
}

describe('FakeSecretReader', () => {
  runSecretReaderContract(() => {
    const configured = { 'jev-key': 'k' }
    return { reader: fake(configured).reader, configured }
  })

  it('[ADR-017] a blocking store answers timeout after SECRET_READ_TIMEOUT_MS, never before', async () => {
    const { reader, clock } = fake({ 'opencode-password': 'p' })
    reader.blocking = true
    let answer: unknown = 'pending'
    void reader.read('opencode-password').then((value) => (answer = value))

    clock.advance(SECRET_READ_TIMEOUT_MS - 1)
    await Promise.resolve()
    expect(answer).toBe('pending')
    clock.advance(1)
    await Promise.resolve()

    expect(answer).toBe('timeout')
    expect(reader.reads).toEqual(['opencode-password'])
  })
})
