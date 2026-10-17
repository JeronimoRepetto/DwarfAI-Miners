// L1 table of the ACP `stopReason` → `TurnEndKind` mapping (ADR-021 item 5; 15 §4.10 Turns, §6 C-20).
import { describe, expect, it } from 'vitest'
import { turnEndOf } from './stopReason'

describe('ACP stopReason mapping', () => {
  it('[C-20] every ACP stopReason maps per ADR-021 item 5 and an unknown one maps to errored with detail', () => {
    // The five values of the pinned schema (`StopReason`, @agentclientprotocol/sdk 1.6.0).
    expect(turnEndOf('end_turn')).toEqual({ kind: 'concluded' })
    expect(turnEndOf('max_tokens')).toEqual({ kind: 'capped', detail: 'max_tokens' })
    expect(turnEndOf('max_turn_requests')).toEqual({ kind: 'capped', detail: 'max_turn_requests' })
    expect(turnEndOf('refusal')).toEqual({ kind: 'errored', detail: 'refusal' })
    expect(turnEndOf('cancelled')).toEqual({ kind: 'interrupted' })
    // Never dropped silently: the raw word is the detail (ADR-021 item 5, invariant §6a-11).
    expect(turnEndOf('paused_for_review')).toEqual({ kind: 'errored', detail: 'paused_for_review' })
    expect(turnEndOf('')).toEqual({ kind: 'errored', detail: 'stopReason without a value' })
  })
})
