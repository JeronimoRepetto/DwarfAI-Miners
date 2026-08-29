import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultProviderSnapshot, type Mine, type ProviderSnapshot } from './domain/types'
import { Poller } from './poller'
import type { Provider } from './providers/provider'

function fakeProvider(kind: 'claude' | 'codex', scan: () => Promise<ProviderSnapshot[]>): Provider {
  return { kind, scan, feed: async () => null }
}

function snapshotAt(cwd: string, updatedAt = 0): ProviderSnapshot {
  return { ...defaultProviderSnapshot(), sessionId: `s-${cwd}`, cwd, updatedAt }
}

describe('Poller', () => {
  let updates: Mine[][]
  let errors: unknown[]

  beforeEach(() => {
    updates = []
    errors = []
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  function makePoller(providers: Provider[], intervalMs = 1000): Poller {
    return new Poller({
      providers,
      intervalMs,
      tierOf: () => 'bronze',
      onUpdate: (mines) => updates.push(mines),
      logError: (_message, error) => errors.push(error)
    })
  }

  it('aggregates snapshots from every provider into one update', async () => {
    const poller = makePoller([
      fakeProvider('claude', async () => [snapshotAt('C:\\A')]),
      fakeProvider('codex', async () => [snapshotAt('C:\\B')])
    ])
    await poller.tick()
    expect(updates).toHaveLength(1)
    expect(updates[0]!.map((m) => m.path).sort()).toEqual(['C:\\A', 'C:\\B'])
  })

  it('keeps polling when one provider fails, and logs the error', async () => {
    const poller = makePoller([
      fakeProvider('claude', async () => {
        throw new Error('boom')
      }),
      fakeProvider('codex', async () => [snapshotAt('C:\\B')])
    ])
    await poller.tick()
    expect(updates[0]!.map((m) => m.path)).toEqual(['C:\\B'])
    expect(errors).toHaveLength(1)
  })

  it('skips a tick while the previous one is still running', async () => {
    let calls = 0
    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const poller = makePoller([
      fakeProvider('claude', async () => {
        calls++
        await blocked
        return []
      })
    ])
    const first = poller.tick()
    await poller.tick() // overlapping -> skipped
    expect(calls).toBe(1)
    release()
    await first
    expect(updates).toHaveLength(1)
  })

  it('start() polls immediately and then on every interval; stop() ends it', async () => {
    vi.useFakeTimers()
    const poller = makePoller([fakeProvider('claude', async () => [snapshotAt('C:\\A')])], 500)
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1500)
    expect(updates).toHaveLength(4)
    poller.stop()
    await vi.advanceTimersByTimeAsync(2000)
    expect(updates).toHaveLength(4)
  })
})
