// The creditability rule of a usage unit (09 §5.3 step 2; ADR-006 items 4–9; 06 §13.2 INV-91…INV-97),
// as a pure decision over facts the application read in the crediting transaction. Pure: no I/O,
// no clock read (05 §2.2, R1).
//
// A sealed unit is credited exactly once (INV-91), from the best observation of the session's
// authoritative path (INV-92: one path per session while SP-06 is open), with the mine's known
// tier as its material (INV-94), never as coal (INV-95), never before the install moment
// (ADR-006 item 8) and never while a reset saga is unfinished (INV-97). Anything else is stored and
// waits (`'stored'`), or never credits.
import type { Instant } from '../../../kernel/domain/values'
import type { LiveMaterial } from './materials'
import { MATERIALS, unitsOf } from './materials'

const LIVE_MATERIALS: readonly LiveMaterial[] = MATERIALS.filter(
  (material): material is LiveMaterial => material !== 'coal'
)

/** 06 §13.1 `UnitKey`: the provider's smallest accounted usage unit (ADR-006 item 4). */
export type UnitKey = string

/** 06 §0.2 crew `UsagePath`, as the ledger reads it (`dwarfs.usage_path`, `usage_observations.path`). */
export type UsagePath = 'driver' | 'transcript'

/** The token kinds of one observation (ADR-006 item 4), normalized per provider by its adapter. */
export interface UsageTokens {
  inputNet: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
}

/**
 * The tokens a unit is credited with: every kind of its observation added together. Package gap:
 * 06 and 09 name `tokens` but not the kinds it counts; each adapter keeps the kinds disjoint
 * (`inputNet` is net of cache, `reasoning` is not also inside `output`, ADR-006 item 4 "normalized
 * per provider"), so their sum is the unit's spend, as today's counter sums Claude's input, output,
 * cache-write and cache-read tokens (`parse.ts` `usageTokens`).
 */
export function usageTokens(tokens: UsageTokens): number {
  return tokens.inputNet + tokens.output + tokens.cacheRead + tokens.cacheWrite + tokens.reasoning
}

/** 06 §13.1 `UsageUnit`, as the crediting transaction sees it. */
export interface UsageUnit {
  unitKey: UnitKey
  sealed: boolean
  /** The provider time of its sealing record (09 §5.3 step 1), null when the provider gave none. */
  providerTime: Instant | null
  firstObservedAt: Instant
  /** A `LedgerEntry` already exists for it (`ledger_entries.unit_key` UNIQUE). */
  credited: boolean
}

/** What 09 §5.3 step 2 reads, in the crediting transaction. */
export interface CreditFacts {
  unit: UsageUnit
  /** `install_moment.at`; null between a reset's `db` and `install-moment` steps (09 §5.5). */
  installMomentAt: Instant | null
  /** A `reset_journal` row has `step <> 'done'` (ADR-023 item 4). */
  resetInProgress: boolean
  /** The mine's confirmed tier (`mines.tier` once `has_been_measured = 1`), null before. */
  tier: LiveMaterial | null
  /**
   * The credited tokens of the unit's best observation (highest fidelity, ties to the earlier,
   * ADR-006 item 5) among those of the session's authoritative path, or null when that path has
   * not reported the unit.
   */
  authoritativeTokens: number | null
}

export type NotCreditableReason =
  | 'not-sealed'
  | 'already-credited'
  | 'no-install-moment'
  | 'before-install-moment'
  | 'reset-in-progress'
  | 'tier-unknown'
  | 'not-authoritative-path'

export type CreditDecision =
  | { creditable: true; material: LiveMaterial; tokens: number; units: number }
  | { creditable: false; reason: NotCreditableReason }

/** 09 §5.3 step 2: whether the unit is credited now, and with what. */
export function decideCredit(facts: CreditFacts): CreditDecision {
  const { unit, installMomentAt, tier, authoritativeTokens } = facts
  if (!unit.sealed) return notCreditable('not-sealed')
  if (unit.credited) return notCreditable('already-credited')
  if (installMomentAt === null) return notCreditable('no-install-moment')
  // ADR-006 item 8: a unit without a provider time counts as after the moment only if first
  // observed live after it.
  if ((unit.providerTime ?? unit.firstObservedAt) < installMomentAt) {
    return notCreditable('before-install-moment')
  }
  if (facts.resetInProgress) return notCreditable('reset-in-progress')
  // INV-94, INV-95: only a confirmed tier pays, and no tier is coal.
  if (tier === null || !isLiveMaterial(tier)) return notCreditable('tier-unknown')
  if (authoritativeTokens === null) return notCreditable('not-authoritative-path')
  return {
    creditable: true,
    material: tier,
    tokens: authoritativeTokens,
    units: unitsOf(authoritativeTokens, tier)
  }
}

function notCreditable(reason: NotCreditableReason): CreditDecision {
  return { creditable: false, reason }
}

function isLiveMaterial(material: string): material is LiveMaterial {
  return LIVE_MATERIALS.includes(material as LiveMaterial)
}
