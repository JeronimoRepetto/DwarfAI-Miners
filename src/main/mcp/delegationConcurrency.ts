/**
 * Bounds how many delegated subtasks may be running at once (#511).
 *
 * Every acquired slot is a REAL agent CLI process this app is about to start
 * — not a request, a session that burns real tokens and real CPU. This
 * machine overheated to 90°C from a load test that started too many
 * concurrent processes at once (see the T3 safety rule this issue was built
 * under), so a single parent asking Jev to fan out unboundedly must refuse
 * cleanly rather than start a fifth, sixth, seventh session. The numbers are
 * deliberately conservative rather than tuned for throughput: this is a
 * safety rail, not a capacity plan.
 */
export const DEFAULT_MAX_DELEGATIONS_PER_PARENT = 2
export const DEFAULT_MAX_DELEGATIONS_GLOBAL = 4

export interface DelegationConcurrencyLimits {
  perParent: number
  global: number
}

/**
 * Pure in-memory counters — no I/O, no timers — so the cap can be proven with
 * plain tokens rather than real processes. The delegation service owns
 * calling `release` exactly once per `tryAcquire` that returned `true`, when
 * that delegation's own ticket settles (done or failed).
 */
export class DelegationConcurrencyGate {
  private readonly limits: DelegationConcurrencyLimits
  private readonly perParentCounts = new Map<string, number>()
  private globalCount = 0

  constructor(limits: DelegationConcurrencyLimits = defaultLimits()) {
    this.limits = limits
  }

  /** Reserves one slot for `token`, or refuses when either cap is already at its limit. */
  tryAcquire(token: string): boolean {
    const current = this.perParentCounts.get(token) ?? 0
    if (current >= this.limits.perParent) return false
    if (this.globalCount >= this.limits.global) return false
    this.perParentCounts.set(token, current + 1)
    this.globalCount += 1
    return true
  }

  /** Frees one slot for `token`. Safe to call more times than acquired — never goes negative. */
  release(token: string): void {
    const current = this.perParentCounts.get(token) ?? 0
    if (current <= 1) this.perParentCounts.delete(token)
    else this.perParentCounts.set(token, current - 1)
    this.globalCount = Math.max(0, this.globalCount - 1)
  }
}

function defaultLimits(): DelegationConcurrencyLimits {
  return { perParent: DEFAULT_MAX_DELEGATIONS_PER_PARENT, global: DEFAULT_MAX_DELEGATIONS_GLOBAL }
}
