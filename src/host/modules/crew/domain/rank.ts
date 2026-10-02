// A dwarf's rank (06 §5.1 `DwarfRank`, INV-27; PO #21). Pure: no I/O, no clock read (R1).

/** The three rank names; a deeper level never grows a fourth one (US-OBS-008.AC04). */
export type DwarfRank = 'foreman' | 'worker' | 'worker2'

/**
 * The rank of a dwarf `depth` levels below its root session, fixed at arrival (INV-27): the root
 * is `foreman` from its arrival whether or not it ever spawns a subagent, its subagents are
 * `worker`, and every deeper level is `worker2`. The rank comes from depth alone, so the order in
 * which the sessions are seen never changes it; today's latched `heldRootRole` is not
 * transplanted (06 §5.1). An unknown depth (`null`) reads as `worker`.
 */
export function rankForDepth(depth: number | null): DwarfRank {
  if (depth === null) return 'worker'
  if (depth <= 0) return 'foreman'
  return depth === 1 ? 'worker' : 'worker2'
}
