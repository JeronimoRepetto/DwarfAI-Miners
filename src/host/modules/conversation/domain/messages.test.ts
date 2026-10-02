import { describe, expect, it } from 'vitest'
import { classifyEntry, type EntryFlags } from './messages'

// L1 (17 §1.1): what one ingested entry does to the log (09 §5.2 steps 1–2, "Dropped records").
// The waiting DwarfAI rows are passed in as a lookup, so the rule stays pure (R1).
const WAITING = 'send-request-7'
const isEchoWaiting = (correlation: string): boolean => correlation === WAITING

describe('classifyEntry', () => {
  it('[INV-60] an entry whose echoOf matches a waiting DwarfAI row is merged, never inserted', () => {
    const echo: EntryFlags = { echoOf: WAITING }
    const unmatched: EntryFlags = { echoOf: 'send-request-8' }
    const plain: EntryFlags = {}

    expect(classifyEntry(echo, isEchoWaiting)).toBe('merge-echo')
    expect(classifyEntry(unmatched, isEchoWaiting)).toBe('insert')
    expect(classifyEntry(plain, isEchoWaiting)).toBe('insert')
  })

  it('[INV-68] a hand-off echo is dropped with its key kept', () => {
    const handoffEcho: EntryFlags = { handoffEcho: true }
    // A pushed hand-off writes no DwarfAI row (deliverInvisibly, INV-68), so even an echo
    // correlation that happens to match a waiting row never makes it a message.
    const correlatedHandoffEcho: EntryFlags = { handoffEcho: true, echoOf: WAITING }

    expect(classifyEntry(handoffEcho, isEchoWaiting)).toBe('drop-keep-key')
    expect(classifyEntry(correlatedHandoffEcho, isEchoWaiting)).toBe('drop-keep-key')
    expect(classifyEntry({ handoffEcho: false }, isEchoWaiting)).toBe('insert')
  })
})
