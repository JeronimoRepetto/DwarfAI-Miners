// `SubtaskText` (06 §11.1, §0 VO table): the `delegate_subtask` input, `task` 1..4 000 and
// `context` ≤ 16 000 characters, bounded separately (ADR-013 Context and item 1; 16 §5.4; C-26).
// The bounds are the target values of ADR-013; the same names at `0bfd108`
// (`mcp/delegationProtocol.ts:76-81`) are evidence only.
//
// A character is a Unicode code point, as SQLite's `length()` counts it in the `delegations`
// CHECKs (09 §4.6: `length(task_text) <= 4000`, `length(context_text) <= 16000`), so a parsed
// subtask never violates them. Nothing is trimmed or rewritten: the text is stored as given while
// the delegation is in flight. Pure: no I/O (05 §2.2, R1).
import type { Result } from '../../../kernel/domain/values'

/** Bound on `delegate_subtask`'s `task`, in characters (ADR-013; 09 §4.6). */
export const MAX_DELEGATION_TASK_CHARS = 4_000
/** Bound on `delegate_subtask`'s `context`, in characters, separate from the task's (ADR-013). */
export const MAX_DELEGATION_CONTEXT_CHARS = 16_000

/** A task or a context that passed its bound (06 `SubtaskText`). */
export type SubtaskText = string & { readonly __brand: 'SubtaskText' }

/** A parsed `delegate_subtask` input. */
export interface Subtask {
  readonly task: SubtaskText
  readonly context?: SubtaskText
}

/** Why a subtask input is refused. */
export type SubtaskTextRefusal = 'task-empty' | 'task-too-long' | 'context-too-long'

/** Parses the tool input: the task 1..4 000 characters, the context at most 16 000. */
export function parseSubtask(input: {
  task: string
  context?: string
}): Result<Subtask, SubtaskTextRefusal> {
  const taskChars = characterCount(input.task)
  if (taskChars === 0) return { ok: false, error: 'task-empty' }
  if (taskChars > MAX_DELEGATION_TASK_CHARS) return { ok: false, error: 'task-too-long' }
  const task = input.task as SubtaskText
  if (input.context === undefined) return { ok: true, value: { task } }
  if (characterCount(input.context) > MAX_DELEGATION_CONTEXT_CHARS) {
    return { ok: false, error: 'context-too-long' }
  }
  return { ok: true, value: { task, context: input.context as SubtaskText } }
}

/** Code points, not UTF-16 code units (09 §4.6 `length()`). */
function characterCount(text: string): number {
  return Array.from(text).length
}
