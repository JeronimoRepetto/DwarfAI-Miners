/**
 * Deterministic pseudo-randomness for the simulated valley (issue #42).
 *
 * A simulation is only worth running if a layout bug found in one can be
 * reproduced exactly. So nothing here is random: every choice the world makes —
 * a mine's name, a dwarf's shift, which rock it stands at — is a pure function
 * of a string key that includes the run's seed. Same seed, same valley, on any
 * machine and at any hour.
 *
 * The hash is FNV-1a 32, byte-for-byte the one the renderer's
 * `lib/placement.ts` uses to pin mines to map sites. It is deliberately
 * REIMPLEMENTED here rather than imported: main and renderer are separate
 * bundles either side of the Electron process boundary, and reaching across it
 * for eight lines of arithmetic would buy a shared import at the cost of the
 * boundary that keeps the main process free of renderer code. The vectors in
 * `rng.test.ts` come from the algorithm itself, so the two copies are pinned to
 * the same function rather than merely to each other.
 */

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
 * `key` hashed into `[0, bound)`.
 *
 * A non-positive bound answers 0 rather than NaN: every caller is choosing an
 * index into something, and an empty something must yield a harmless index
 * instead of poisoning a coordinate the renderer will later try to draw.
 */
export function hashInt(key: string, bound: number): number {
  if (!Number.isFinite(bound) || bound <= 0) return 0
  return hashString(key) % Math.floor(bound)
}

/** The member of `options` that `key` deterministically selects. */
export function hashPick<T>(key: string, options: readonly T[]): T {
  return options[hashInt(key, options.length)] as T
}
