// layer: L7
import { describe, expect, it } from 'vitest'
import { frameTimeSummary } from './frameStats.mjs'

/**
 * L7 check of how a perf case turns the frame times it measured into the figures it records (ISSUE-298; `17` §1.11):
 * nearest-rank percentiles over the intervals between consecutive animation frames, in milliseconds.
 */

describe('a frame-time summary (17 §1.11)', () => {
  it('[S-034-1, NFR-PERF-10] the summary is the nearest-rank p50, p95 and p99, the maximum and the count of the frame times', () => {
    // 100 frames: 1 ms … 100 ms, given out of order.
    const frames = Array.from({ length: 100 }, (_, index) => ((index * 37) % 100) + 1)

    expect(frameTimeSummary(frames)).toEqual({ count: 100, p50: 50, p95: 95, p99: 99, max: 100 })
  })

  it('[S-034-1, NFR-PERF-10] one long frame among short ones shows in the maximum and not in the median', () => {
    expect(frameTimeSummary([16.7, 16.6, 16.7, 16.8, 120])).toEqual({
      count: 5,
      p50: 16.7,
      p95: 120,
      p99: 120,
      max: 120
    })
  })

  it('[S-034-1] a window with no frame fails the summary rather than recording zeros', () => {
    expect(() => frameTimeSummary([])).toThrow('no frame was measured')
  })
})
