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

/**
 * The push channel's half of the hybrid design: a hook event asks for a scan
 * now instead of waiting out the poll interval, without letting a burst of
 * events in one turn cost one full scan each.
 */
describe('Poller.nudge', () => {
  let updates: Mine[][]

  function makePoller(scan: () => Promise<ProviderSnapshot[]>, nudgeWindowMs = 300): Poller {
    return new Poller({
      providers: [fakeProvider('claude', scan)],
      intervalMs: 2000,
      nudgeWindowMs,
      tierOf: () => 'bronze',
      onUpdate: (mines) => updates.push(mines)
    })
  }

  beforeEach(() => {
    updates = []
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('scans immediately on the first nudge, without waiting for the window', async () => {
    const poller = makePoller(async () => [snapshotAt('C:\\A')])
    poller.nudge()
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toHaveLength(1)
  })

  it('collapses a burst inside the window into one extra scan, not one each', async () => {
    const poller = makePoller(async () => [snapshotAt('C:\\A')])
    poller.nudge()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 20; i++) poller.nudge()
    await vi.advanceTimersByTimeAsync(10)
    expect(updates).toHaveLength(1) // still coalescing
    await vi.advanceTimersByTimeAsync(300)
    expect(updates).toHaveLength(2) // one trailing scan for the whole burst
  })

  it('does not scan again at the end of a window nothing arrived in', async () => {
    const poller = makePoller(async () => [snapshotAt('C:\\A')])
    poller.nudge()
    await vi.advanceTimersByTimeAsync(1000)
    expect(updates).toHaveLength(1)
  })

  it('goes back to immediate once the window has closed quietly', async () => {
    const poller = makePoller(async () => [snapshotAt('C:\\A')])
    poller.nudge()
    await vi.advanceTimersByTimeAsync(400)
    poller.nudge()
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toHaveLength(2)
  })

  it('keeps rate-limiting through a sustained stream of events', async () => {
    const poller = makePoller(async () => [snapshotAt('C:\\A')])
    for (let elapsed = 0; elapsed < 1200; elapsed += 50) {
      poller.nudge()
      await vi.advanceTimersByTimeAsync(50)
    }
    // 1200 ms of events every 50 ms: one leading scan plus one per window.
    expect(updates.length).toBeLessThanOrEqual(5)
    expect(updates.length).toBeGreaterThanOrEqual(4)
  })

  it('defers instead of losing a nudge that lands during an in-flight scan', async () => {
    // tick() drops an overlapping call. The in-flight scan may have started
    // before the event happened, so swallowing the nudge would hide the very
    // state change the hook fired for until the next 2 s poll.
    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const poller = makePoller(async () => {
      calls++
      if (calls === 1) await blocked
      return [snapshotAt('C:\\A')]
    })

    void poller.tick()
    await vi.advanceTimersByTimeAsync(0)
    poller.nudge() // arrives while the first scan is still running
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)

    release()
    await vi.advanceTimersByTimeAsync(300)
    expect(calls).toBe(2)
  })

  it('stop() cancels a pending trailing scan', async () => {
    const poller = makePoller(async () => [snapshotAt('C:\\A')])
    poller.nudge()
    await vi.advanceTimersByTimeAsync(0)
    poller.nudge()
    poller.stop()
    await vi.advanceTimersByTimeAsync(1000)
    expect(updates).toHaveLength(1)
  })

  it('nudging while the interval poll is running still rate-limits', async () => {
    const poller = makePoller(async () => [snapshotAt('C:\\A')])
    poller.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toHaveLength(1)
    poller.nudge()
    await vi.advanceTimersByTimeAsync(0)
    expect(updates).toHaveLength(2)
    poller.stop()
  })
})
