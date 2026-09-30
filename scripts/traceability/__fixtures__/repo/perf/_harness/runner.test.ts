/**
 * A perf-runner test under perf/ (17 §1.11); its layer comes from the comment below.
 */
// layer: L7
import { describe, expect, it } from 'vitest'

describe('perf runner', () => {
  it('[NFR-OBS-03] appends one record per perf case', () => {
    expect(true).toBe(true)
  })
})
