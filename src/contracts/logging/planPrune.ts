/** One file of the `logs/` folder as the directory listing reports it (`05` §3.13 `LogDirectory`). */
export interface SegmentInfo {
  readonly name: string
  readonly bytes: number
  readonly firstTs: string
}

/**
 * The prune plan every writer runs (ADR-026 item 2): the names to delete, oldest first by first-record
 * timestamp across every prefix (ties by name), until the remaining total plus `headroomBytes` is at
 * most `capBytes`. A segment whose `firstTs` cannot be read (an empty, just-opened segment) sorts as the
 * youngest, so a writer never deletes another writer's fresh segment ahead of a full old one.
 */
export function planPrune(
  segments: readonly SegmentInfo[],
  capBytes: number,
  headroomBytes: number
): string[] {
  let total = segments.reduce((sum, s) => sum + s.bytes, 0)
  const plan: string[] = []
  for (const segment of [...segments].sort(oldestFirst)) {
    if (total + headroomBytes <= capBytes) break
    plan.push(segment.name)
    total -= segment.bytes
  }
  return plan
}

function oldestFirst(a: SegmentInfo, b: SegmentInfo): number {
  const ta = timeOf(a)
  const tb = timeOf(b)
  if (ta !== tb) return ta < tb ? -1 : 1
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
}

function timeOf(s: SegmentInfo): number {
  const ms = Date.parse(s.firstTs)
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms
}
