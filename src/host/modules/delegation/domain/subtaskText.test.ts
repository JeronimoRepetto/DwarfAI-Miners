import { describe, expect, it } from 'vitest'
import {
  MAX_DELEGATION_CONTEXT_CHARS,
  MAX_DELEGATION_TASK_CHARS,
  parseSubtask
} from './subtaskText'

// `SubtaskText` (06 §11.1): the task and its context are bounded separately (ADR-013 Context;
// 16 §5.4 `delegate_subtask`), and never past the `delegations` CHECKs (09 §4.6).

describe('subtaskText', () => {
  it('[ADR-013, C-26] a task of 4 000 characters and a context of 16 000 are accepted, one more character in either is refused, and an empty task is refused', () => {
    expect(MAX_DELEGATION_TASK_CHARS).toBe(4_000)
    expect(MAX_DELEGATION_CONTEXT_CHARS).toBe(16_000)

    const task = 't'.repeat(4_000)
    const context = 'c'.repeat(16_000)
    const accepted = parseSubtask({ task, context })
    expect(accepted).toEqual({ ok: true, value: { task, context } })
    expect(parseSubtask({ task })).toEqual({ ok: true, value: { task } })

    expect(parseSubtask({ task: task + 't', context })).toEqual({
      ok: false,
      error: 'task-too-long'
    })
    expect(parseSubtask({ task, context: context + 'c' })).toEqual({
      ok: false,
      error: 'context-too-long'
    })
    expect(parseSubtask({ task: '' })).toEqual({ ok: false, error: 'task-empty' })

    // Bounded separately: a short task does not lend its room to a long context, nor the reverse.
    expect(parseSubtask({ task: 'x', context: 'c'.repeat(16_001) })).toEqual({
      ok: false,
      error: 'context-too-long'
    })
    expect(parseSubtask({ task: 't'.repeat(4_001), context: '' })).toEqual({
      ok: false,
      error: 'task-too-long'
    })

    // Characters, as the `length()` of the 09 CHECK counts them: an astral character is one.
    expect(parseSubtask({ task: '\u{1F528}'.repeat(4_000) }).ok).toBe(true)
    expect(parseSubtask({ task: '\u{1F528}'.repeat(4_001) })).toEqual({
      ok: false,
      error: 'task-too-long'
    })
  })
})
