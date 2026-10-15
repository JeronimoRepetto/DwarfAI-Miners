// ADR-028 item 1: the effort ceiling, replacing the found tree's `narrowEffort` (which took the
// NEAREST allowed level and so could pick one above the level Jev worked out). Pure: no I/O, no
// clock read (05 §2.2, R1).

/** ADR-028 item 1, verbatim. */
export type CappedEffort =
  | { kind: 'level'; effort: string } // index(effort) <= index(mapped)
  | { kind: 'omit' } // model declares no effort levels ([]): effort not sent
  | { kind: 'none' } // every allowed level is above the ceiling

/**
 * ADR-028 item 1: the highest `allowed` level whose index on `fullLadder` is at or below the index
 * of `mapped`.
 *
 * - `allowed === 'all'` → `mapped` itself;
 * - `allowed` empty → `omit` (the model takes no effort flag);
 * - `mapped` not on `fullLadder` → `none`, never "the first allowed level": a programming error the
 *   caller reports (the domain holds no logger; the `warn` record of ADR-028 item 1 is the
 *   application's, ISSUE-192);
 * - no allowed level at or below `mapped` → `none` (the candidate is ineligible, ADR-028 item 2).
 *
 * The order of `allowed` does not matter: the ladder decides.
 */
export function capEffort(
  fullLadder: readonly string[],
  allowed: readonly string[] | 'all',
  mapped: string
): CappedEffort {
  if (allowed === 'all') return { kind: 'level', effort: mapped }
  if (allowed.length === 0) return { kind: 'omit' }
  const ceiling = fullLadder.indexOf(mapped)
  if (ceiling === -1) return { kind: 'none' }
  let best: { effort: string; index: number } | undefined
  for (const level of allowed) {
    const index = fullLadder.indexOf(level)
    if (index === -1 || index > ceiling) continue
    if (best === undefined || index > best.index) best = { effort: level, index }
  }
  return best === undefined ? { kind: 'none' } : { kind: 'level', effort: best.effort }
}
