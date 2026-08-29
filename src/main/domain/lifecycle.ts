import type { Dwarf, Mine, MineTier } from './types'

export interface DwarfLifecycleOptions {
  /** How long a disappeared dwarf stays visible with status 'leaving' before being dropped. */
  graceMs: number
  now?: () => number
}

interface RealDwarfContext {
  dwarf: Dwarf
  mineId: string
  minePath: string
  mineName: string
  mineTier: MineTier
}

interface LeavingEntry extends RealDwarfContext {
  /** When this dwarf was first observed missing; never reset while it stays missing. */
  missingSince: number
}

/**
 * Tracks dwarfs across runtime ticks so a session that finishes/disappears
 * doesn't just vanish: it stays visible with status 'leaving' for a grace
 * period. Stateful by design (poller ticks only carry the latest snapshot,
 * so "what was here a moment ago" has to live somewhere) — one instance per
 * AgentRuntime, fed the raw provider-aggregated mines on every tick.
 */
export class DwarfLifecycleTracker {
  private readonly graceMs: number
  private readonly now: () => number
  private lastReal = new Map<string, RealDwarfContext>()
  private leaving = new Map<string, LeavingEntry>()

  constructor(options: DwarfLifecycleOptions) {
    this.graceMs = options.graceMs
    this.now = options.now ?? Date.now
  }

  /** Merge grace-period 'leaving' dwarfs into a fresh set of real mines. */
  apply(mines: Mine[]): Mine[] {
    const nowMs = this.now()
    const incomingIds = new Set<string>()
    const nextReal = new Map<string, RealDwarfContext>()
    for (const item of mines) {
      for (const dwarf of item.dwarfs) {
        incomingIds.add(dwarf.id)
        nextReal.set(dwarf.id, {
          dwarf,
          mineId: item.id,
          minePath: item.path,
          mineName: item.name,
          mineTier: item.tier
        })
      }
    }

    // Newly missing: real last tick, absent now. missingSince is set once and
    // never touched again while it stays missing (no reset on repeated ticks).
    for (const [id, context] of this.lastReal) {
      if (!incomingIds.has(id) && !this.leaving.has(id)) {
        this.leaving.set(id, { ...context, missingSince: nowMs })
      }
    }
    // Reappeared: it's real again, not leaving. A later disappearance starts a fresh clock.
    for (const id of incomingIds) {
      this.leaving.delete(id)
    }
    // Expired: grace period elapsed, drop for good.
    for (const [id, entry] of this.leaving) {
      if (nowMs - entry.missingSince >= this.graceMs) {
        this.leaving.delete(id)
      }
    }

    this.lastReal = nextReal
    if (this.leaving.size === 0) return mines

    const output = mines.map((item) => ({ ...item, dwarfs: [...item.dwarfs] }))
    const byMineId = new Map(output.map((item) => [item.id, item]))
    for (const entry of this.leaving.values()) {
      const leavingDwarf: Dwarf = { ...entry.dwarf, status: 'leaving' }
      let target = byMineId.get(entry.mineId)
      if (target === undefined) {
        // The whole mine (session) disappeared too; keep a synthetic mine
        // around just long enough to show its leaving dwarf(s).
        target = {
          id: entry.mineId,
          path: entry.minePath,
          name: entry.mineName,
          tier: entry.mineTier,
          dwarfs: [],
          updatedAt: entry.missingSince
        }
        byMineId.set(entry.mineId, target)
        output.push(target)
      }
      target.dwarfs.push(leavingDwarf)
    }
    return output
  }
}
