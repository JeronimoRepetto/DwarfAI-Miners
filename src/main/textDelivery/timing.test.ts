import { describe, expect, it } from 'vitest'
import { createStageTimer, formatStageTimings, type StageTimings } from './timing'

/**
 * A clock that hands out the given readings in order, so a test asserts real
 * numbers instead of sleeping. Running past the end repeats the last reading.
 */
function clockOf(...readings: number[]): () => number {
  let index = 0
  return () => readings[Math.min(index++, readings.length - 1)] ?? 0
}

describe('createStageTimer', () => {
  it('records how long a stage took, from the injected clock', async () => {
    const timer = createStageTimer(clockOf(1_000, 1_012))

    await expect(timer.measure('focus', async () => 'ok')).resolves.toBe('ok')
    expect(timer.timings()).toEqual({ focusMs: 12 })
  })

  it('times every stage of one attempt separately', async () => {
    const timer = createStageTimer(clockOf(0, 12, 12, 15, 15, 5_210))

    await timer.measure('focus', async () => undefined)
    await timer.measure('spawn', async () => undefined)
    await timer.measure('relay', async () => undefined)

    expect(timer.timings()).toEqual({ focusMs: 12, spawnMs: 3, relayMs: 5_195 })
  })

  it('still records a stage that threw — a failed attempt is the one worth timing', async () => {
    const timer = createStageTimer(clockOf(100, 180))

    await expect(
      timer.measure('spawn', () => Promise.reject(new Error('powershell.exe is missing')))
    ).rejects.toThrow('powershell.exe is missing')
    expect(timer.timings()).toEqual({ spawnMs: 80 })
  })

  it('never reports a negative duration when the clock steps backwards', async () => {
    const timer = createStageTimer(clockOf(500, 400))

    await timer.measure('relay', async () => undefined)
    expect(timer.timings()).toEqual({ relayMs: 0 })
  })

  it('records a duration measured elsewhere', () => {
    const timer = createStageTimer(clockOf(0))
    timer.record('total', 42)
    expect(timer.timings()).toEqual({ totalMs: 42 })
  })

  it('absorbs the stages a nested port already measured', async () => {
    const timer = createStageTimer(clockOf(0, 900))

    await timer.measure('total', async () => undefined)
    timer.absorb({ focusMs: 11, spawnMs: 7 })

    expect(timer.timings()).toEqual({ totalMs: 900, focusMs: 11, spawnMs: 7 })
  })

  it('keeps its own reading when a nested port reports the same stage', () => {
    const timer = createStageTimer(clockOf(0))
    timer.record('relay', 5_000)
    timer.absorb({ relayMs: 1 })
    expect(timer.timings()).toEqual({ relayMs: 5_000 })
  })

  it('absorbing nothing is a no-op, so an unmeasured port costs no special case', () => {
    const timer = createStageTimer(clockOf(0))
    timer.record('total', 5)
    timer.absorb(undefined)
    expect(timer.timings()).toEqual({ totalMs: 5 })
  })

  it('hands out a copy, so a caller cannot mutate the recorded stages', () => {
    const timer = createStageTimer(clockOf(0))
    timer.record('focus', 3)

    const snapshot = timer.timings()
    snapshot.focusMs = 999

    expect(timer.timings()).toEqual({ focusMs: 3 })
  })

  it('defaults to the real clock when none is injected', async () => {
    const timer = createStageTimer()
    await timer.measure('focus', async () => undefined)
    expect(timer.timings().focusMs).toBeGreaterThanOrEqual(0)
  })
})

describe('formatStageTimings', () => {
  it('prints the stages in the order a delivery walks through them', () => {
    const timings: StageTimings = { totalMs: 5_240, relayMs: 5_210, focusMs: 12, spawnMs: 4 }
    expect(formatStageTimings(timings)).toBe('focus=12ms spawn=4ms relay=5210ms total=5240ms')
  })

  it('omits the stages this attempt never walked through', () => {
    expect(formatStageTimings({ focusMs: 12, totalMs: 20 })).toBe('focus=12ms total=20ms')
  })

  it('reports nothing at all when no stage was measured', () => {
    expect(formatStageTimings({})).toBe('')
  })

  it('rounds to whole milliseconds so the log stays readable', () => {
    expect(formatStageTimings({ focusMs: 12.6 })).toBe('focus=13ms')
  })
})
