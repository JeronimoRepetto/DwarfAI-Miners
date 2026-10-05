import { describe, expect, it } from 'vitest'
import {
  classifyEntry,
  echoesTypedSend,
  TYPED_ECHO_SKEW_MS,
  TYPED_ECHO_WINDOW_MS,
  type EntryFlags,
  type TypedEchoEntry
} from './messages'

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

  it('[INV-68] a hand-off echo and a control-plane record are dropped with their key kept', () => {
    // The control-plane flag is the 2026-10-02 amendment to 15 §1.2 (ISSUE-098).
    expect(classifyEntry({ controlPlane: true }, isEchoWaiting)).toBe('drop-keep-key')
    expect(classifyEntry({ controlPlane: true, echoOf: WAITING }, isEchoWaiting)).toBe(
      'drop-keep-key'
    )
    const handoffEcho: EntryFlags = { handoffEcho: true }
    // A pushed hand-off writes no DwarfAI row (deliverInvisibly, INV-68), so even an echo
    // correlation that happens to match a waiting row never makes it a message.
    const correlatedHandoffEcho: EntryFlags = { handoffEcho: true, echoOf: WAITING }

    expect(classifyEntry(handoffEcho, isEchoWaiting)).toBe('drop-keep-key')
    expect(classifyEntry(correlatedHandoffEcho, isEchoWaiting)).toBe('drop-keep-key')
    expect(classifyEntry({ handoffEcho: false }, isEchoWaiting)).toBe('insert')
  })
})

// ISSUE-099: the transcript echo of a message DwarfAI typed into an observed terminal carries no
// correlation, so it is recognised by its exact text inside the waiting row's window (ADR-007
// item 3).
describe('echoesTypedSend', () => {
  const WRITTEN_AT = 1_790_000_000_000
  const row = { text: 'Dig the north seam', createdAt: WRITTEN_AT }
  const echo = (extra: Partial<TypedEchoEntry> = {}): TypedEchoEntry => ({
    role: 'person',
    text: 'Dig the north seam',
    providerTime: WRITTEN_AT + 1_000,
    ...extra
  })
  const at = (providerTime: number) => echoesTypedSend(echo({ providerTime }), 'transcript', row, 0)

  it('[INV-60, ADR-007] an observed person entry echoes a waiting row only with the exact text inside the typed-echo window', () => {
    expect(at(WRITTEN_AT + TYPED_ECHO_WINDOW_MS)).toBe(true)
    expect(at(WRITTEN_AT + TYPED_ECHO_WINDOW_MS + 1)).toBe(false)
    expect(at(WRITTEN_AT - TYPED_ECHO_SKEW_MS)).toBe(true)
    expect(at(WRITTEN_AT - TYPED_ECHO_SKEW_MS - 1)).toBe(false)
    // Exact text: one more space is another message.
    expect(echoesTypedSend(echo({ text: 'Dig the north seam ' }), 'transcript', row, 0)).toBe(false)
    // With no provider time, the instant it is read stands for it.
    const untimed = echo({ providerTime: null })
    expect(echoesTypedSend(untimed, 'transcript', row, WRITTEN_AT + 2_000)).toBe(true)
    expect(echoesTypedSend(untimed, 'transcript', row, WRITTEN_AT + TYPED_ECHO_WINDOW_MS + 1)).toBe(
      false
    )
  })

  it('[INV-60, INV-68] only an uncorrelated person entry a transcript observer read can be a typed echo', () => {
    expect(echoesTypedSend(echo(), 'transcript', row, 0)).toBe(true)
    // A live stream answers with the driver's own correlation (15 §4), never by text.
    expect(echoesTypedSend(echo(), 'live-stream', row, 0)).toBe(false)
    expect(echoesTypedSend(echo({ role: 'dwarf' }), 'transcript', row, 0)).toBe(false)
    expect(echoesTypedSend(echo({ echoOf: 'send-request-7' }), 'transcript', row, 0)).toBe(false)
    expect(echoesTypedSend(echo({ controlPlane: true }), 'transcript', row, 0)).toBe(false)
    expect(echoesTypedSend(echo({ handoffEcho: true }), 'transcript', row, 0)).toBe(false)
    // The rule's verdict is what classifyEntry merges on; a dropped record stays dropped.
    expect(classifyEntry({}, isEchoWaiting, true)).toBe('merge-echo')
    expect(classifyEntry({ controlPlane: true }, isEchoWaiting, true)).toBe('drop-keep-key')
  })
})
