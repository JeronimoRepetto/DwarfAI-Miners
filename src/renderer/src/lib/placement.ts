/**
 * Deterministic placement of mines onto the authored dig sites of the map.
 *
 * A mine's site is derived from a hash of its id, so positions stay stable
 * across data refreshes and app restarts without persisting anything.
 * Collisions are resolved by deterministic linear probing over the ids in
 * sorted order, which guarantees unique sites while mines fit on the map.
 *
 * This module owns only the *which mine goes where* question; the sites
 * themselves — and why their coordinates are what they are — live in
 * `mapSites.ts`, so the assignment logic never needs to know about the
 * painting it is placing mines on.
 */
import { MINE_SITES } from './map/mapSites'

/** FNV-1a 32-bit hash: tiny, deterministic, well spread for path-like ids. */
export function hashString(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * Assign each mine id an authored-site index, in two passes so positions stay
 * put: a mine whose hash-preferred site nobody else wants always keeps it (new
 * mines never displace it), then the contested rest probe forward from their
 * preferred site in sorted-id order (input order carries no meaning across
 * IPC refreshes). With more mines than sites, the overflow lands on its
 * preferred site and simply shares it.
 */
export function assignSlots(
  mineIds: readonly string[],
  slotCount: number = MINE_SITES.length
): Map<string, number> {
  const assigned = new Map<string, number>()
  if (slotCount <= 0) return assigned
  const sorted = [...mineIds].sort()
  const preferred = new Map(sorted.map((id) => [id, hashString(id) % slotCount]))
  const demand = new Map<number, number>()
  for (const slot of preferred.values()) demand.set(slot, (demand.get(slot) ?? 0) + 1)

  const taken = new Set<number>()
  const contested: string[] = []
  for (const id of sorted) {
    const want = preferred.get(id) as number
    if (demand.get(want) === 1) {
      assigned.set(id, want)
      taken.add(want)
    } else {
      contested.push(id)
    }
  }
  for (const id of contested) {
    const want = preferred.get(id) as number
    let slot = want
    for (let step = 0; step < slotCount; step++) {
      const candidate = (want + step) % slotCount
      if (!taken.has(candidate)) {
        slot = candidate
        break
      }
    }
    taken.add(slot)
    assigned.set(id, slot)
  }
  return assigned
}
