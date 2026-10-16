// L1 cases of the stream-json reader (15 §1.2, §1.4; ADR-007 item 4, ADR-021 item 5) that the
// conformance fixtures do not reach on their own.
import { describe, expect, it } from 'vitest'
import { LineFramer, parseLine, toolSummary, turnEndOf } from './streamParser'

const redact = (text: string): string => text.replace(/sk-[A-Za-z0-9]+/g, '[redacted]')

describe('streamParser', () => {
  it('[C-05] an activity summary names the call subject, redacted, and never carries tool input as JSON', () => {
    expect(
      toolSummary('Bash', { command: 'curl -H "x: sk-abc123" host', description: 'Fetch' }, redact)
    ).toBe('curl -H "x: [redacted]" host')
    expect(toolSummary('Mystery', { payload: 'the whole file content' }, redact)).toBe('Mystery')
    expect(toolSummary('Bash', { command: 'a\n  b' }, redact)).toBe('a b')
    expect(toolSummary('Bash', { command: 'x'.repeat(500) }, redact)).toHaveLength(240)
  })

  it('[C-20] error_max_budget_usd is errored, not capped: only error_max_turns is capped (ADR-021 item 5)', () => {
    expect(turnEndOf('error_max_turns')).toEqual({ kind: 'capped', detail: 'error_max_turns' })
    expect(turnEndOf('error_max_budget_usd')).toEqual({
      kind: 'errored',
      detail: 'error_max_budget_usd'
    })
    expect(turnEndOf('')).toEqual({ kind: 'errored', detail: 'result without a subtype' })
  })

  it('[C-19] a last line without its terminator is read when the stream ends', () => {
    const framer = new LineFramer()
    expect(framer.push('{"type":"result","subtype":"success"}\r\n{"type":"sys')).toEqual([
      '{"type":"result","subtype":"success"}'
    ])
    expect(framer.push('tem","subtype":"init"}')).toEqual([])
    const last = framer.flush()
    expect(last === null ? null : parseLine(last)).toEqual({
      kind: 'system',
      subtype: 'init',
      sessionId: null
    })
    expect(framer.flush()).toBeNull()
  })

  it('[C-19] a record type that is not a plain name is never echoed into a drift detail', () => {
    expect(parseLine(JSON.stringify({ type: 'Invalid API key sk-abc123 please' }))).toEqual({
      kind: 'drift',
      detail: 'a record of an unreadable type'
    })
  })
})
