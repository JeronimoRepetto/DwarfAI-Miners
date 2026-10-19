import { describe, expect, it } from 'vitest'
import { SequenceIdGenerator } from './SequenceIdGenerator'
import { runIdGeneratorContract } from '../testing/idGenerator.contract'

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('SequenceIdGenerator', () => {
  it('[ADR-005] the sequence generator is deterministic and yields valid version-7 shapes', () => {
    const a = new SequenceIdGenerator()
    const b = new SequenceIdGenerator()
    const fromA = [a.uuidv7(), a.uuidv7(), a.uuidv7()]
    const fromB = [b.uuidv7(), b.uuidv7(), b.uuidv7()]

    expect(fromA).toEqual(fromB)
    expect(fromA).toEqual([
      '00000000-0000-7000-8000-000000000001',
      '00000000-0000-7000-8000-000000000002',
      '00000000-0000-7000-8000-000000000003'
    ])
    for (const id of fromA) expect(id).toMatch(UUID_V7)
    expect([...fromA].sort()).toEqual(fromA)
  })
})

runIdGeneratorContract(() => new SequenceIdGenerator())
