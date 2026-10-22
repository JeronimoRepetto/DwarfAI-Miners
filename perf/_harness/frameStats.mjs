/**
 * The frame-time figures a perf case records (ISSUE-298; S-034-1; `17` §1.11): from the intervals between consecutive
 * animation frames, in milliseconds, the nearest-rank p50, p95 and p99, the maximum and how many frames were measured.
 *
 * Nearest rank (the smallest value at or above the given share of the sorted frames) keeps every figure a frame that
 * was really measured, never an interpolation between two. A window with no frame throws: zeros would be recorded as
 * evidence of a fluid window that was never measured.
 */
export function frameTimeSummary(frames) {
  if (frames.length === 0) throw new Error('no frame was measured in the window')
  const sorted = [...frames].sort((a, b) => a - b)
  const rank = (share) => sorted[Math.max(0, Math.ceil(share * sorted.length) - 1)]
  return {
    count: sorted.length,
    p50: rank(0.5),
    p95: rank(0.95),
    p99: rank(0.99),
    max: sorted[sorted.length - 1]
  }
}
