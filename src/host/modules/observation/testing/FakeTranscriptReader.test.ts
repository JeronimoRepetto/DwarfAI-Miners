// layer: L3
// L3 (17 §1.3): the TranscriptReader double pages like the adapter base's window read
// (`adapters/base/adapterBase.test.ts`, the real reader over fixture files).
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../../kernel/domain/values'
import { FakeTranscriptReader } from '../ports/fakes/FakeTranscriptReader'

const ref = { dwarfId: '00000000-0000-7000-8000-000000000070' as DwarfId, streamIds: ['s1'] }
const entry = (n: number) => ({
  sourceKey: `simulated:s1:m${n}`,
  role: 'dwarf' as const,
  text: `line ${n}`,
  providerTime: null
})

describe('FakeTranscriptReader', () => {
  it('[ADR-007] FakeTranscriptReader pages its scripted entries backwards by before and limit, and answers [] for an unreadable stream', async () => {
    const reader = new FakeTranscriptReader()
    reader.script(
      's1',
      Array.from({ length: 12 }, (_, n) => entry(n + 1))
    )

    expect((await reader.entries(ref, { limit: 3 })).map((e) => e.text)).toEqual([
      'line 10',
      'line 11',
      'line 12'
    ])
    expect(
      (await reader.entries(ref, { before: 'simulated:s1:m3', limit: 5 })).map((e) => e.text)
    ).toEqual(['line 1', 'line 2'])
    expect(await reader.entries({ ...ref, streamIds: ['unknown'] }, { limit: 3 })).toEqual([])
    reader.breakStream('s1')
    expect(await reader.entries(ref, { limit: 3 })).toEqual([])
  })
})
