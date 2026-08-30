import { describe, expect, it } from 'vitest'
import { PollProfiler, formatPollSample, perfLoggingEnabled } from './perf'

/** A clock the tests advance by hand, so no timing assertion is ever flaky. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let current = 0
  return {
    now: () => current,
    advance: (ms) => {
      current += ms
    }
  }
}

describe('perfLoggingEnabled', () => {
  it('stays off when the flag is absent', () => {
    expect(perfLoggingEnabled({})).toBe(false)
  })

  it('stays off for the explicit off values', () => {
    expect(perfLoggingEnabled({ DWARFAI_PERF: '0' })).toBe(false)
    expect(perfLoggingEnabled({ DWARFAI_PERF: 'false' })).toBe(false)
    expect(perfLoggingEnabled({ DWARFAI_PERF: '' })).toBe(false)
  })

  it('turns on for 1 and true, whatever the casing', () => {
    expect(perfLoggingEnabled({ DWARFAI_PERF: '1' })).toBe(true)
    expect(perfLoggingEnabled({ DWARFAI_PERF: 'true' })).toBe(true)
    expect(perfLoggingEnabled({ DWARFAI_PERF: 'TRUE' })).toBe(true)
  })
})

describe('PollProfiler when disabled', () => {
  it('records nothing and logs nothing', () => {
    const lines: string[] = []
    const profiler = new PollProfiler({ enabled: false, log: (line) => lines.push(line) })
    profiler.begin()
    profiler.stage('claude', 9)
    profiler.count('dwarfs', 3)
    expect(profiler.end()).toBeNull()
    expect(lines).toEqual([])
  })

  it('still runs and returns what measure() wraps', async () => {
    const profiler = new PollProfiler({ enabled: false, log: () => undefined })
    profiler.begin()
    await expect(profiler.measure('claude', () => Promise.resolve(7))).resolves.toBe(7)
    profiler.end()
  })
})

describe('PollProfiler when enabled', () => {
  it('reports the wall time of one whole poll', () => {
    const clock = fakeClock()
    const profiler = new PollProfiler({ enabled: true, log: () => undefined, now: clock.now })
    profiler.begin()
    clock.advance(12.5)
    expect(profiler.end()?.totalMs).toBe(12.5)
  })

  it('keeps stages in the order they were measured', async () => {
    const clock = fakeClock()
    const profiler = new PollProfiler({ enabled: true, log: () => undefined, now: clock.now })
    profiler.begin()
    await profiler.measure('claude', () => {
      clock.advance(9)
      return Promise.resolve(undefined)
    })
    await profiler.measure('codex', () => {
      clock.advance(3)
      return Promise.resolve(undefined)
    })
    expect(Object.entries(profiler.end()?.stages ?? {})).toEqual([
      ['claude', 9],
      ['codex', 3]
    ])
  })

  it('times a synchronous stage and returns its value', () => {
    const clock = fakeClock()
    const profiler = new PollProfiler({ enabled: true, log: () => undefined, now: clock.now })
    profiler.begin()
    const value = profiler.measureSync('aggregate', () => {
      clock.advance(2.5)
      return 'mines'
    })
    expect(value).toBe('mines')
    expect(profiler.end()?.stages.aggregate).toBe(2.5)
  })

  it('still times a synchronous stage that throws', () => {
    const clock = fakeClock()
    const profiler = new PollProfiler({ enabled: true, log: () => undefined, now: clock.now })
    profiler.begin()
    expect(() =>
      profiler.measureSync('publish', () => {
        clock.advance(1.5)
        throw new Error('listener blew up')
      })
    ).toThrow('listener blew up')
    expect(profiler.end()?.stages.publish).toBe(1.5)
  })

  it('adds up repeated stages instead of overwriting them', () => {
    const profiler = new PollProfiler({ enabled: true, log: () => undefined })
    profiler.begin()
    profiler.stage('tail', 4)
    profiler.stage('tail', 6)
    expect(profiler.end()?.stages.tail).toBe(10)
  })

  it('adds up counts, defaulting to one per call', () => {
    const profiler = new PollProfiler({ enabled: true, log: () => undefined })
    profiler.begin()
    profiler.count('sessions', 4)
    profiler.count('pushed')
    profiler.count('pushed')
    const sample = profiler.end()
    expect(sample?.counts).toEqual({ sessions: 4, pushed: 2 })
  })

  it('logs exactly one line per completed poll', () => {
    const lines: string[] = []
    const profiler = new PollProfiler({ enabled: true, log: (line) => lines.push(line) })
    profiler.begin()
    profiler.end()
    profiler.begin()
    profiler.end()
    expect(lines).toHaveLength(2)
  })

  it('ignores stages and counts recorded outside a poll', () => {
    const lines: string[] = []
    const profiler = new PollProfiler({ enabled: true, log: (line) => lines.push(line) })
    profiler.stage('stray', 5)
    profiler.count('stray')
    expect(profiler.end()).toBeNull()
    expect(lines).toEqual([])
  })

  it('drops a poll that was never closed rather than blending it into the next', () => {
    const clock = fakeClock()
    const profiler = new PollProfiler({ enabled: true, log: () => undefined, now: clock.now })
    profiler.begin()
    profiler.stage('abandoned', 99)
    profiler.begin()
    clock.advance(2)
    const sample = profiler.end()
    expect(sample?.stages).toEqual({})
    expect(sample?.totalMs).toBe(2)
  })
})

describe('formatPollSample', () => {
  it('prints the total, then the stages, then the counts', () => {
    expect(
      formatPollSample({
        totalMs: 12.44,
        stages: { claude: 9.06, codex: 3.01 },
        counts: { sessions: 4, dwarfs: 6 }
      })
    ).toBe('[perf] poll 12.4ms | claude 9.1 codex 3.0 | sessions 4 dwarfs 6')
  })

  it('prints a bare total when a poll measured nothing else', () => {
    expect(formatPollSample({ totalMs: 0.42, stages: {}, counts: {} })).toBe('[perf] poll 0.4ms')
  })
})
