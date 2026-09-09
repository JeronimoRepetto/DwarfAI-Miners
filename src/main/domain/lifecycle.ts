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
 * Whether this snapshot of `dwarf` shows its session moving since `sinceMs` —
 * the one thing that lifts a dismissal (#293).
 *
 * Two pieces of evidence, and both are facts about THIS dwarf. A status of
 * `'working'` is the provider stating that a turn is open right now, so it is
 * newer than any earlier dismissal without needing a timestamp at all; it is
 * the signal every provider writes, and it is what a Codex thread flips to the
 * moment somebody types into its TUI. `transcriptUpdatedAt` is the raw mtime of
 * this dwarf's own transcript, which moves for ANY writer — a human turn typed
 * into a console included — so it catches a session that has been written to
 * before the status has caught up.
 *
 * What is deliberately NOT the evidence, each for a reason:
 *
 * - **The mine's `updatedAt`.** A mine is a FOLDER, and several sessions and
 *   several dwarfs share one. A neighbour digging would resurrect a dwarf
 *   nobody touched, which makes the dismissal useless in exactly the busy mine
 *   where somebody would reach for it.
 * - **`silentForMs`.** It is `now - mtime`, so it changes on every poll purely
 *   because the clock advances — the trap `transcriptUpdatedAt`'s own doc
 *   comment in contracts.ts was added to avoid.
 * - **`lastMessage`.** Only the ASSISTANT's side of the transcript, so a human
 *   turn leaves it untouched — and a human returning to the session is the very
 *   case that has to bring the dwarf back.
 *
 * A dwarf that was already `'working'` when it was dismissed therefore comes
 * back on the next poll. That is the intended direction and not a hole:
 * #46's record exists so the board never hides an agent that is running, and a
 * dismissal is the person's act, never a finding that the session stopped.
 */
function showsActivitySince(dwarf: Dwarf, sinceMs: number): boolean {
  if (dwarf.status === 'working') return true
  return dwarf.transcriptUpdatedAt !== undefined && dwarf.transcriptUpdatedAt > sinceMs
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
  /**
   * When each DISMISSED dwarf was sent off (#293) — the instant the activity
   * rule below measures against. Only a dismissal is keyed here; a retirement
   * from #46 never is, which is what keeps the two suppressions apart.
   */
  private dismissedAt = new Map<string, number>()

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
   *
   * Two callers make that observation now, and the second is why the rule is
   * "observed" rather than "watched": a kick on a terminal session ENDS its
   * process and the platform reports the tree gone (#329), which is this
   * process observing the stop rather than inferring it from a settled status.
   * `dismiss` below cannot serve that case — its suppression lifts on a
   * `'working'` status, which is precisely what a session kicked mid-turn was
   * last reported as.
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

  /**
   * Take a dwarf off the board because the PERSON asked for it (#293) — a kick
   * on a session nothing here can interrupt, or on one that has already ended.
   *
   * Not a claim about the session, which is the whole difference from `retire`
   * above: nothing has been observed stopping, and usually nothing has stopped
   * at all. So the suppression is conditional — `showsActivitySince` below
   * lifts it the moment the provider reports the session moving again — where a
   * retirement's only has to outlast the provider's own belief.
   *
   * A dwarf already walking out goes NOW rather than finishing its grace: what
   * somebody pressing Kick on a finished worker is asking to be rid of is
   * precisely that walk.
   */
  dismiss(dwarfId: string): void {
    const walkingOut = this.leaving.has(dwarfId)
    this.retire(dwarfId)
    this.dismissedAt.set(dwarfId, this.now())
    if (walkingOut) this.leaving.delete(dwarfId)
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
        // A retired dwarf is not real any more, whatever the provider says —
        // unless it was DISMISSED and this snapshot shows it moving since
        // (#293), in which case the person's decision is over and the dwarf is
        // real again.
        if (this.retired.has(dwarf.id)) {
          const dismissedAt = this.dismissedAt.get(dwarf.id)
          if (dismissedAt === undefined || !showsActivitySince(dwarf, dismissedAt)) {
            suppressed.add(dwarf.id)
            continue
          }
          this.retired.delete(dwarf.id)
          this.dismissedAt.delete(dwarf.id)
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
      else if (nowMs - absentSince >= this.graceMs) {
        this.retired.delete(id)
        this.dismissedAt.delete(id)
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
