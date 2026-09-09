import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultProviderSnapshot, type Mine, type ProviderSnapshot } from '../domain/types'
import { Poller } from './poller'
import type { Provider } from '../providers/provider'

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
      onUpdate: (mines) => {
        updates.push(mines)
      },
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

  /**
   * #196: onUpdate now sometimes does real async work of its own (the runtime
   * reads a watched dwarf's feed before publishing) rather than being a plain
   * synchronous callback. `tick()` must stay "in flight" for the whole of
   * that work, not just for the scan — otherwise the scheduled interval could
   * fire again, scan, and publish a NEWER snapshot before the slower pass
   * ever reaches its own publish, so the two would land out of order and
   * leave PublishGate's `lastPublished` behind a snapshot the panel never saw.
   */
  it('keeps a slow async onUpdate from being overtaken by the next scheduled tick', async () => {
    vi.useFakeTimers()
    let release: () => void = () => undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let scanCalls = 0
    let onUpdateCalls = 0
    const poller = new Poller({
      providers: [
        fakeProvider('claude', async () => {
          scanCalls++
          return [snapshotAt('C:\\A', scanCalls)]
        })
      ],
      intervalMs: 100,
      tierOf: () => 'bronze',
      onUpdate: async (mines) => {
        onUpdateCalls++
        updates.push(mines)
        // Only the first publish is slow, so a second one proves the
        // interval was free to scan again rather than merely delayed.
        if (onUpdateCalls === 1) await blocked
      }
    })
    try {
      poller.start()
      await vi.advanceTimersByTimeAsync(0)
      expect(scanCalls).toBe(1)
      expect(onUpdateCalls).toBe(1) // called, but still awaiting `blocked`

      // The interval would fire twice more in this window if `ticking` had
      // already cleared after the scan; it must not scan again while the
      // first pass's publish is still pending.
      await vi.advanceTimersByTimeAsync(250)
      expect(scanCalls).toBe(1)
      expect(onUpdateCalls).toBe(1)

      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(onUpdateCalls).toBe(1) // resolved now; no new call caused by this alone

      // Only now, with the first pass fully finished, may the interval scan again.
      await vi.advanceTimersByTimeAsync(100)
      expect(scanCalls).toBe(2)
    } finally {
      poller.stop()
    }
  })

  /**
   * #348. The fold is the poller's because this is the one seam where a cwd
   * becomes a mine path, and it runs BEFORE the aggregation rather than after:
   * two worktrees have to arrive at `aggregateMines` under one cwd for one mine
   * to come out.
   */
  it('folds the scanned snapshots before aggregating them, when a fold is wired', async () => {
    const poller = new Poller({
      providers: [
        fakeProvider('claude', async () => [snapshotAt('C:\\Code\\wt-a')]),
        fakeProvider('codex', async () => [snapshotAt('C:\\Code\\wt-b')])
      ],
      intervalMs: 1000,
      tierOf: () => 'bronze',
      foldWorktrees: async (snapshots) =>
        snapshots.map((snapshot) => ({ ...snapshot, cwd: 'C:\\Code\\Anvil' })),
      onUpdate: (mines) => {
        updates.push(mines)
      }
    })
    await poller.tick()
    expect(updates[0]!.map((mine) => mine.path)).toEqual(['C:\\Code\\Anvil'])
  })

  it('publishes the raw snapshots when a fold refuses, rather than dropping the poll', async () => {
    const poller = new Poller({
      providers: [fakeProvider('claude', async () => [snapshotAt('C:\\Code\\wt-a')])],
      intervalMs: 1000,
      tierOf: () => 'bronze',
      foldWorktrees: async () => {
        throw new Error('the disk said no')
      },
      onUpdate: (mines) => {
        updates.push(mines)
      },
      logError: (_message, error) => errors.push(error)
    })
    await poller.tick()
    expect(updates[0]!.map((mine) => mine.path)).toEqual(['C:\\Code\\wt-a'])
    expect(errors).toHaveLength(1)
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
      onUpdate: (mines) => {
        updates.push(mines)
      }
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
