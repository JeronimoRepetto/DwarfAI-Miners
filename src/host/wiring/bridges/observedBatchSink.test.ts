// layer: L3
// The `ObservedBatchSink` bridge (bridges/observedBatchSink.ts; 16 §4.3, AMENDMENT-10) over a
// recording transaction runner: which sink observation gets while a half is missing, and when the
// halves' held events are published or dropped.
import { describe, expect, it } from 'vitest'
import type { DwarfId } from '../../kernel/domain/values'
import type { TransactionRunner } from '../../kernel/ports/transactionRunner'
import type { TransactionScope } from '../../kernel/ports/transactionScope'
import { noObservedBatchSinkYet } from '../routes/observation'
import {
  composeObservedBatchSink,
  type ObservedBatch,
  type ObservedBatchHalf
} from './observedBatchSink'

/** A runner that records its commits and rollbacks; a nested call joins the open transaction. */
class RecordingRunner implements TransactionRunner, TransactionScope {
  private open = false
  constructor(private readonly trace: string[]) {}

  isInTransaction(): boolean {
    return this.open
  }

  inTransaction<T>(work: () => T): T {
    if (this.open) return work()
    this.open = true
    try {
      const result = work()
      this.trace.push('commit')
      return result
    } catch (error) {
      this.trace.push('rollback')
      throw error
    } finally {
      this.open = false
    }
  }
}

function half(name: string, trace: string[], runner: TransactionScope): ObservedBatchHalf {
  return {
    apply: () => trace.push(`${name}:apply:${runner.isInTransaction() ? 'in-tx' : 'no-tx'}`),
    joinedEvents: {
      publish: () => trace.push(`${name}:publish`),
      discard: () => trace.push(`${name}:discard`)
    }
  }
}

const BATCH: ObservedBatch = { dwarfId: 'dwarf-1' as DwarfId, entries: [], usage: [] }

describe('the ObservedBatchSink bridge (ISSUE-096)', () => {
  it('[INV-98] without its conversation half the bridge hands observation the placeholder sink, which observation never starts over', () => {
    const trace: string[] = []
    const runner = new RecordingRunner(trace)
    const bridge = composeObservedBatchSink({
      transactions: runner,
      ledger: half('ledger', trace, runner),
      conversation: null
    })

    expect(bridge.sink).toBe(noObservedBatchSinkYet)
  })

  it('[ADR-006] the halves write inside the batch transaction and their held events are published after its commit, or dropped after its rollback', () => {
    const trace: string[] = []
    const runner = new RecordingRunner(trace)
    const bridge = composeObservedBatchSink({
      transactions: runner,
      ledger: half('ledger', trace, runner),
      conversation: half('conversation', trace, runner)
    })

    bridge.transactions.inTransaction(() => bridge.sink.apply(BATCH))
    expect(trace.splice(0)).toEqual([
      'conversation:apply:in-tx',
      'ledger:apply:in-tx',
      'commit',
      'conversation:publish',
      'ledger:publish'
    ])

    expect(() =>
      bridge.transactions.inTransaction(() => {
        bridge.sink.apply(BATCH)
        throw new Error('the cursor advance failed')
      })
    ).toThrow('the cursor advance failed')
    expect(trace.splice(0)).toEqual([
      'conversation:apply:in-tx',
      'ledger:apply:in-tx',
      'rollback',
      'conversation:discard',
      'ledger:discard'
    ])

    // A call inside an open transaction joins it; the call that opened it publishes.
    runner.inTransaction(() => bridge.transactions.inTransaction(() => bridge.sink.apply(BATCH)))
    expect(trace).toEqual(['conversation:apply:in-tx', 'ledger:apply:in-tx', 'commit'])
  })
})
