// layer: L2
// `AnswerRecords` (16 §4.6; ADR-010 items 4, 13; 09 §8.2): conversation's answers-record writes for
// asking, over the in-memory `MessageLog`. They join the caller's open transaction and never open one
// (no transaction → `HostInvariantError`), and publish nothing: asking publishes after its commit.
import { describe, expect, it } from 'vitest'
import { HostInvariantError } from '../../../kernel/domain/errors'
import type { AskId, DwarfId, MessageId } from '../../../kernel/domain/values'
import { FakeClock } from '../../../kernel/fakes/FakeClock'
import { SequenceIdGenerator } from '../../../kernel/fakes/SequenceIdGenerator'
import type { ConversationEntry } from '../../suppliers'
import { MESSAGES_PER_DWARF } from '../domain/retention'
import { InMemoryMessageLog } from '../testing/InMemoryMessageLog'
import { createAnswerRecords } from './answerRecords'

const T0 = 1_790_000_000_000
const DWARF = '00000000-0000-7000-8000-0000000000d1' as DwarfId
const ASK = '00000000-0000-7000-8000-0000000000a1' as AskId

function setUp() {
  let open = false
  const scope = { isInTransaction: () => open }
  const clock = new FakeClock(T0)
  const log = new InMemoryMessageLog({ scope, clock, ids: new SequenceIdGenerator() })
  const records = createAnswerRecords({ log, scope, clock })
  const inTransaction = <T>(work: () => T): T => {
    open = true
    try {
      return work()
    } finally {
      open = false
    }
  }
  return { log, records, clock, inTransaction }
}

describe('AnswerRecords', () => {
  it("[INV-65, ADR-010] write inserts the ask's answers-record with its delivery sending, stamped by the clock", () => {
    const { log, records, clock, inTransaction } = setUp()
    clock.advance(1_000)

    const id = inTransaction(() => records.write(DWARF, ASK, 'Answers:\n\n- Run it: **Allow**'))

    expect(log.page(DWARF, {})).toEqual([
      expect.objectContaining({
        id,
        role: 'answers-record',
        text: 'Answers:\n\n- Run it: **Allow**',
        askId: ASK,
        createdAt: T0 + 1_000,
        delivery: expect.objectContaining({ phase: 'sending', attempts: 1, phaseAt: T0 + 1_000 })
      })
    ])
  })

  it('[INV-65, ADR-010] write with the existing record updates it in place, sending again', () => {
    const { log, records, clock, inTransaction } = setUp()
    const first = inTransaction(() => records.write(DWARF, ASK, 'Answers:\n\n- Pick: **A**'))
    inTransaction(() =>
      records.settle(first, {
        phase: 'failed',
        failure: { kind: 'refused', reason: 'channel-rejected' }
      })
    )
    clock.advance(5_000)

    const again = inTransaction(() => records.write(DWARF, ASK, 'Answers:\n\n- Pick: **B**', first))

    expect(again).toBe(first)
    expect(log.page(DWARF, {})).toEqual([
      expect.objectContaining({
        id: first,
        text: 'Answers:\n\n- Pick: **B**',
        createdAt: T0 + 5_000,
        delivery: expect.objectContaining({ phase: 'sending', attempts: 2 })
      })
    ])
  })

  it('[ADR-022] settle marks the record delivered, or failed with its refusal reason', () => {
    const { log, records, clock, inTransaction } = setUp()
    const record = inTransaction(() => records.write(DWARF, ASK, 'Answers:'))
    clock.advance(2_000)

    inTransaction(() => records.settle(record, { phase: 'delivered' }))

    expect(log.page(DWARF, {})[0]?.delivery).toEqual({
      messageId: record,
      dwarfId: DWARF,
      kind: 'answers-record',
      phase: 'delivered',
      attempts: 1,
      phaseAt: T0 + 2_000
    })
  })

  it('[INV-61] a written record keeps the dwarf at most 50 stored rows and is never the one trimmed', () => {
    const { log, records, inTransaction } = setUp()
    const entries: ConversationEntry[] = Array.from({ length: MESSAGES_PER_DWARF }, (_, n) => ({
      sourceKey: `claude:claude:s:event-${n}`,
      role: 'dwarf',
      text: `line ${n}`,
      providerTime: T0 + 10 + n
    }))
    inTransaction(() => log.append(DWARF, entries, 'live-stream'))

    const record = inTransaction(() => records.write(DWARF, ASK, 'Answers:'))

    expect(log.rowCount(DWARF)).toBe(MESSAGES_PER_DWARF)
    expect(log.rowIds(DWARF)).toContain(record)
  })

  it('[INV-72] AnswerRecords called with no open transaction throws HostInvariantError and writes nothing', () => {
    // A log that would accept the write: the refusal is AnswerRecords' own (16 §4.6).
    const clock = new FakeClock(T0)
    const log = new InMemoryMessageLog({
      scope: { isInTransaction: () => true },
      clock,
      ids: new SequenceIdGenerator()
    })
    const records = createAnswerRecords({ log, scope: { isInTransaction: () => false }, clock })
    const written = log.writeAnswersRecord(DWARF, ASK, 'Answers:', T0)

    expect(() => records.write(DWARF, ASK, 'another', undefined)).toThrow(HostInvariantError)
    expect(() => records.write(DWARF, ASK, 'again', written as MessageId)).toThrow(
      HostInvariantError
    )
    expect(() => records.settle(written, { phase: 'delivered' })).toThrow(HostInvariantError)
    expect(log.page(DWARF, {})).toEqual([
      expect.objectContaining({
        id: written,
        text: 'Answers:',
        delivery: expect.objectContaining({ phase: 'sending' })
      })
    ])
  })
})
