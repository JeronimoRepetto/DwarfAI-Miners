import { describe, expect, it } from 'vitest'
import { nextSeq, parseSegmentName, segmentName } from './segments'

describe('log segment names (ADR-026 item 1, 19 §2)', () => {
  it('[ADR-026] segment names are <prefix><6-digit seq>.jsonl and a writer continues after the highest seq of its prefix', () => {
    expect(segmentName('host-', 42)).toBe('host-000042.jsonl')
    expect(segmentName('ui-', 1)).toBe('ui-000001.jsonl')
    expect(segmentName('shim-', 999_999)).toBe('shim-999999.jsonl')

    expect(parseSegmentName('host-000042.jsonl')).toEqual({ prefix: 'host-', seq: 42 })
    expect(parseSegmentName('shim-000007.jsonl')).toEqual({ prefix: 'shim-', seq: 7 })
    for (const foreign of ['host-42.jsonl', 'host-000042.log', 'other-000001.jsonl', 'notes.txt']) {
      expect(parseSegmentName(foreign), foreign).toBeNull()
    }

    const folder = [
      'host-000041.jsonl',
      'host-000042.jsonl',
      'ui-000099.jsonl',
      'shim-000003.jsonl',
      'notes.txt'
    ]
    expect(nextSeq(folder, 'host-')).toBe(43)
    expect(nextSeq(folder, 'ui-')).toBe(100)
    expect(nextSeq(folder, 'shim-')).toBe(4)
    expect(nextSeq(['host-000005.jsonl'], 'ui-')).toBe(1)
    expect(nextSeq([], 'host-')).toBe(1)
  })
})
