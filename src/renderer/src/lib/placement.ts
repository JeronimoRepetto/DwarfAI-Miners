/**
 * Deterministic placement of mines on the isometric map.
 *
 * A mine's slot is derived from a hash of its id, so positions stay stable
 * across data refreshes and app restarts without persisting anything.
 * Collisions are resolved by deterministic linear probing over the ids in
 * sorted order, which guarantees unique slots while mines fit on the map.
 */

/** A named point on the isometric landscape, in percent of the scene box. */
export interface MapSlot {
  x: number
  y: number
}

/**
 * Hand-placed slots forming a loose diamond, ordered top (far) to bottom
 * (near) so painting in slot order keeps isometric depth correct.
 */
export const MAP_SLOTS: readonly MapSlot[] = [
  { x: 50, y: 16 },
  { x: 31, y: 24 },
  { x: 69, y: 24 },
  { x: 16, y: 36 },
  { x: 50, y: 34 },
  { x: 84, y: 36 },
  { x: 33, y: 47 },
  { x: 67, y: 47 },
  { x: 18, y: 60 },
  { x: 50, y: 58 },
  { x: 82, y: 60 },
  { x: 50, y: 74 }
]

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
 * Assign each mine id a slot index, in two passes so positions stay put:
 * a mine whose hash-preferred slot nobody else wants always keeps it (new
 * mines never displace it), then the contested rest probe forward from their
 * preferred slot in sorted-id order (input order carries no meaning across
 * IPC refreshes). With more mines than slots, the overflow lands on its
 * preferred slot and simply shares it.
 */
export function assignSlots(
  mineIds: readonly string[],
  slotCount: number = MAP_SLOTS.length
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
