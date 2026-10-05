// OS lane (17 §1.8) for the S-032-1 analyzer, which runs on the maintainer's machines over a recorded transcript.
// Synthetic records only; no provider CLI runs here (17 §5.5).
import { describe, expect, it } from 'vitest'
import { turnGaps } from './turnGaps.mjs'

const T0 = Date.UTC(2026, 9, 5, 10, 0, 0)
const at = (ms) => new Date(T0 + ms).toISOString()
const claudeAssistant = (ms, id, block, stopReason) => ({
  type: 'assistant',
  timestamp: at(ms),
  message: { id, content: [block], stop_reason: stopReason }
})
const codexItem = (ms, type, payload) => ({ timestamp: at(ms), type, payload })

describe('S-032-1 analyzer (OS lane, synthetic input)', () => {
  it('[S-032-1, ADR-032] the gap analyzer reports the longest silence inside a turn and a tool call still waiting at the end of a capture', () => {
    const claude = [
      { type: 'user', timestamp: at(0), message: { role: 'user', content: 'one' } },
      claudeAssistant(2_000, 'm1', { type: 'tool_use', id: 't1', name: 'Bash' }, 'tool_use'),
      {
        type: 'user',
        timestamp: at(14_000),
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] }
      },
      claudeAssistant(20_000, 'm2', { type: 'text', text: 'ok' }, 'end_turn'),
      { type: 'user', timestamp: at(60_000), message: { role: 'user', content: 'two' } },
      claudeAssistant(63_000, 'm3', { type: 'tool_use', id: 't2', name: 'Write' }, 'tool_use')
    ]
    expect(turnGaps('claude', claude)).toEqual({
      turns: [
        { records: 4, durationMs: 20_000, maxGapMs: 12_000 },
        { records: 2, durationMs: 3_000, maxGapMs: 3_000 }
      ],
      maxGapMs: 12_000,
      endsOn: { kind: 'tool-call-waiting', tool: 'Write' }
    })
    expect(turnGaps('claude', claude.slice(0, 4)).endsOn).toEqual({
      kind: 'assistant-message',
      tool: null
    })

    const codex = [
      codexItem(0, 'session_meta', { cwd: '/work' }),
      codexItem(100, 'event_msg', { type: 'task_started' }),
      codexItem(200, 'response_item', { type: 'message', role: 'user' }),
      codexItem(5_000, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c1' }),
      codexItem(30_000, 'response_item', { type: 'function_call_output', call_id: 'c1' }),
      codexItem(31_000, 'response_item', { type: 'message', role: 'assistant' }),
      codexItem(31_100, 'event_msg', { type: 'task_complete' }),
      codexItem(100_000, 'event_msg', { type: 'task_started' }),
      codexItem(102_000, 'response_item', { type: 'function_call', name: 'shell', call_id: 'c2' })
    ]
    expect(turnGaps('codex', codex)).toEqual({
      turns: [
        { records: 6, durationMs: 31_000, maxGapMs: 25_000 },
        { records: 2, durationMs: 2_000, maxGapMs: 2_000 }
      ],
      maxGapMs: 25_000,
      endsOn: { kind: 'tool-call-waiting', tool: 'shell' }
    })
  })
})
