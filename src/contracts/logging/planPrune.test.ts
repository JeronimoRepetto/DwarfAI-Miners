import { describe, expect, it } from 'vitest'
import { LOG_CAP_BYTES, LOG_SEGMENT_BYTES } from './logRecord'
import { planPrune, type SegmentInfo } from './planPrune'

const at = (minute: number): string => `2026-10-02T09:${String(minute).padStart(2, '0')}:00.000Z`

function remaining(segments: readonly SegmentInfo[], deleted: readonly string[]): number {
  return segments.filter((s) => !deleted.includes(s.name)).reduce((sum, s) => sum + s.bytes, 0)
}

/** `count` full host segments, one minute apart, oldest first. */
function hostSegments(count: number): SegmentInfo[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `host-${String(i + 1).padStart(6, '0')}.jsonl`,
    bytes: LOG_SEGMENT_BYTES,
    firstTs: at(i)
  }))
}

describe('planPrune (ADR-026 item 2)', () => {
  it('[ADR-026] total plus one segment of headroom never exceeds 100 000 000 bytes after the plan', () => {
    const cases: { what: string; segments: SegmentInfo[]; deleted: string[] }[] = [
      { what: 'empty folder', segments: [], deleted: [] },
      {
        what: 'exactly at cap with headroom (95 000 000 bytes)',
        segments: hostSegments(19),
        deleted: []
      },
      {
        what: 'one byte over',
        segments: [...hostSegments(19), { name: 'ui-000001.jsonl', bytes: 1, firstTs: at(30) }],
        deleted: ['host-000001.jsonl']
      },
      {
        what: 'far over: 30 full segments',
        segments: hostSegments(30),
        deleted: hostSegments(11).map((s) => s.name)
      }
    ]
    for (const { what, segments, deleted } of cases) {
      const plan = planPrune(segments, LOG_CAP_BYTES, LOG_SEGMENT_BYTES)
      expect(plan, what).toEqual(deleted)
      expect(remaining(segments, plan) + LOG_SEGMENT_BYTES, what).toBeLessThanOrEqual(100_000_000)
    }
  })

  it('[ADR-026] the oldest segment is deleted first across host-, ui- and shim- prefixes, ties by name', () => {
    const segments: SegmentInfo[] = [
      { name: 'host-000003.jsonl', bytes: 40_000_000, firstTs: at(30) },
      { name: 'ui-000001.jsonl', bytes: 40_000_000, firstTs: at(10) },
      { name: 'shim-000001.jsonl', bytes: 40_000_000, firstTs: at(10) },
      { name: 'host-000004.jsonl', bytes: 21_000_000, firstTs: at(40) }
    ]
    // 121 000 000 + 5 000 000 > cap: the two oldest (a tie at 09:10, broken by name) must go.
    expect(planPrune(segments, LOG_CAP_BYTES, LOG_SEGMENT_BYTES)).toEqual([
      'shim-000001.jsonl',
      'ui-000001.jsonl'
    ])
  })

  it("[ADR-026] two writers' segments interleaved in time are pruned as one folder", () => {
    const segments: SegmentInfo[] = Array.from({ length: 24 }, (_, i) => ({
      name:
        i % 2 === 0
          ? `host-${String(i / 2 + 1).padStart(6, '0')}.jsonl`
          : `ui-${String((i - 1) / 2 + 1).padStart(6, '0')}.jsonl`,
      bytes: LOG_SEGMENT_BYTES,
      firstTs: at(i)
    }))
    // 24 × 5 000 000 + 5 000 000 = 125 000 000: the 5 oldest go, whichever writer wrote them.
    const plan = planPrune([...segments].reverse(), LOG_CAP_BYTES, LOG_SEGMENT_BYTES)
    expect(plan).toEqual([
      'host-000001.jsonl',
      'ui-000001.jsonl',
      'host-000002.jsonl',
      'ui-000002.jsonl',
      'host-000003.jsonl'
    ])
    expect(remaining(segments, plan) + LOG_SEGMENT_BYTES).toBeLessThanOrEqual(LOG_CAP_BYTES)
  })
})
