// The forward-only rule of a stream position (INV-35; ADR-006 item 3; 09 §4.2 trigger
// `source_cursors_never_regress`) and the stream id of a file that shrank or was replaced (FM-087).
// Pure: no I/O, no clock read (05 §2.2, R1).

/** The message every cursor store throws when a batch would move a cursor back (09 §4.2). */
export const CURSOR_REGRESSION = 'CURSOR_REGRESSION'

/** The fields the rule reads. */
export interface Position {
  kind: string
  value: number
}

/** `forward` or `same` may be written; `regression` aborts the batch (a lower value or a new kind). */
export function compareAdvance(
  current: Position | null,
  next: Position
): 'forward' | 'same' | 'regression' {
  if (current === null) return 'forward'
  if (next.kind !== current.kind || next.value < current.value) return 'regression'
  return next.value === current.value ? 'same' : 'forward'
}

/**
 * The stream id of generation `n` of a source (FM-087): generation 0 is the adapter's own id; a
 * file that shrank below its cursor or was replaced by another file continues as the next
 * generation, so the old cursor is never moved back. Deterministic, so a Host restart finds the
 * same generation again from the stored cursors.
 */
export function generationStreamId(baseStreamId: string, n: number): string {
  return n === 0 ? baseStreamId : `${baseStreamId}#${n}`
}

/** Whether a stored position no longer belongs to the file a source now is (FM-087). */
export function sourceRestarted(
  cursor: { value: number; fileIdentity: string | null },
  source: { size: number; fileIdentity: string }
): boolean {
  if (cursor.fileIdentity !== null && cursor.fileIdentity !== source.fileIdentity) return true
  return source.size < cursor.value
}
