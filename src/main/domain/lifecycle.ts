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
  /**
   * Dwarfs retired by an observed kick (issue #46), against the moment the
   * provider itself stopped reporting them — undefined while it still is.
   */
  private retired = new Map<string, number | undefined>()

  constructor(options: DwarfLifecycleOptions) {
    this.graceMs = options.graceMs
    this.now = options.now ?? Date.now
  }

  /**
   * Take a dwarf off the board because its agent was OBSERVED to have stopped
   * after a kick (issue #46) — never because one was merely delivered.
   *
   * The provider did not make that observation and goes on reporting the
   * session until its own rules notice, so the decision has to be held here:
   * without it the very next poll would re-adopt the dwarf and it would
   * flicker back onto the rock. It departs rather than vanishes, because
   * 'leaving' and the grace clock below are already exactly that.
   */
  retire(dwarfId: string): void {
    this.retired.set(dwarfId, undefined)
    const context = this.lastReal.get(dwarfId)
    // No context means it was never real here (an unknown id, or one already
    // walking out) — the record still stands, there is just no walk to start.
    if (context !== undefined && !this.leaving.has(dwarfId)) {
      this.leaving.set(dwarfId, { ...context, missingSince: this.now() })
    }
  }

  /** Merge grace-period 'leaving' dwarfs into a fresh set of real mines. */
  apply(mines: Mine[]): Mine[] {
    const nowMs = this.now()
    const incomingIds = new Set<string>()
    const nextReal = new Map<string, RealDwarfContext>()
    /** Retired dwarfs this poll still carried, i.e. the ones being suppressed. */
    const suppressed = new Set<string>()
    for (const item of mines) {
      for (const dwarf of item.dwarfs) {
        // A retired dwarf is not real any more, whatever the provider says.
        if (this.retired.has(dwarf.id)) {
          suppressed.add(dwarf.id)
          continue
        }
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

    // A retirement only has to outlast the provider's own belief. Once the
    // provider has agreed the session is gone for a full grace window, the
    // record has nothing left to suppress and is dropped — so a session that
    // genuinely comes back under the same id is visible again, which matters
    // more than the record: an agent hidden while it runs is the very lie
    // this feature exists to prevent.
    for (const [id, absentSince] of this.retired) {
      if (suppressed.has(id)) this.retired.set(id, undefined)
      else if (absentSince === undefined) this.retired.set(id, nowMs)
      else if (nowMs - absentSince >= this.graceMs) this.retired.delete(id)
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
    if (this.leaving.size === 0 && suppressed.size === 0) return mines

    const output = mines.map((item) => ({
      ...item,
      dwarfs: item.dwarfs.filter((dwarf) => !suppressed.has(dwarf.id))
    }))
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
          tokensObserved: 0,
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
