import {
  addMaterialTokens,
  emptyMaterialTotals,
  materialForTier,
  sumMaterialTotals
} from './materials'
import { MATERIALS, type Material, type MaterialTotals, type Mine, type MineTier } from './types'

/**
 * The cumulative per-material vault, as pure state (see #22).
 *
 * The whole point of this module is that the vault is NOT recomputed from the
 * dwarfs visible right now — that is what made a departing dwarf's tokens
 * vanish and left nothing to survive a restart. Instead every poll contributes
 * a DELTA, sealed with the material in force at the moment it was observed,
 * and the sealed totals are never revisited. A copper mine that grows into a
 * silver one therefore keeps its copper forever with no migration step: the
 * new deltas simply land in a different bucket.
 *
 * Nothing here touches a clock or a disk; `now` is always passed in.
 */

/** Bumped only for a shape change a previous version could misread. */
export const LEDGER_VERSION = 1

/**
 * How long a session's last-seen counter is remembered after it was last
 * observed. Long enough to span an overnight break with a session still open,
 * short enough that the file cannot grow without bound over months of use.
 */
export const SESSION_MEMORY_MS = 30 * 24 * 60 * 60 * 1_000

/**
 * The last counter value seen for one session, and when.
 *
 * This is the entire anti-double-counting mechanism. Provider counters are
 * running lifetime totals, not deltas: Claude's is a monotonic runtime-lifetime
 * figure taken from the latest usage block in a bounded transcript tail, and
 * Codex mirrors its registry's tokens_used. Crediting such a value whole would
 * re-credit the same tokens on every single poll.
 */
export interface SessionMark {
  tokens: number
  seenAt: number
}

export interface LedgerState {
  version: number
  /** Cumulative tokens per material, keyed by mine id. */
  mines: Record<string, MaterialTotals>
  /** Last-seen counter per session key, for delta computation. */
  sessions: Record<string, SessionMark>
}

/** One session's counter as of this poll, sealed with its mine's material. */
export interface TokenObservation {
  mineId: string
  /**
   * Stable per-session identity — the dwarf id, which already encodes provider
   * and session (`claude:<sessionId>`, and `:<agentId>` for a subagent), so
   * two providers can never collide on one key.
   */
  sessionKey: string
  /**
   * The material this mine is yielding right now, or undefined while its tier
   * is still being computed (#41). Undefined is NOT a material: it means this
   * sighting may be remembered but must never be credited.
   */
  material: Material | undefined
  /** The provider's running counter, NOT a delta. */
  tokensObserved: number
}

/**
 * The tier a walk has actually measured for this mine, or undefined while it
 * is still running.
 *
 * Deliberately not `mine.tier`: that field is what the mine is DRAWN as, and
 * it reads bronze for every mine on the first frames after a start. Asking a
 * lookup for it forces every accrual path to name where its tier came from.
 */
export type ConfirmedTierLookup = (mine: Mine) => MineTier | undefined

export function emptyLedger(): LedgerState {
  return { version: LEDGER_VERSION, mines: {}, sessions: {} }
}

/** This mine's breakdown, or an empty one when it has never produced. */
export function mineTotals(state: LedgerState, mineId: string): MaterialTotals {
  return state.mines[mineId] ?? emptyMaterialTotals()
}

/**
 * This mine's breakdown exactly as persisted, or undefined when the ledger
 * has no row for it at all — never the zero-filled placeholder mineTotals()
 * returns for the same case (#90).
 *
 * Mirrors knownTierOf()'s undefined-means-unmeasured discipline (#41): a
 * project browse spans mines nobody has ever mined, and a caller answering it
 * must be able to tell "never produced" from "produced and happens to total
 * zero". In practice a row can never actually BE all zero — accrue() only
 * ever writes a positive delta — but the caller should not have to know that
 * invariant to stay honest, so this checks presence directly rather than
 * inferring it from the values.
 */
export function knownMineTotals(state: LedgerState, mineId: string): MaterialTotals | undefined {
  return state.mines[mineId]
}

/**
 * The whole vault: every mine the ledger has ever recorded, summed.
 *
 * Deliberately not limited to mines with a live crew — the coal backfill
 * credits projects whose sessions ended long ago, and those totals are exactly
 * what the global vault chip exists to show.
 */
export function ledgerTotals(state: LedgerState): MaterialTotals {
  return sumMaterialTotals(Object.values(state.mines))
}

/**
 * Turn one poll's mines into observations, sealing each dwarf with the tier
 * `confirmedTierOf` reports for its mine RIGHT NOW. Sealing at observation
 * time is what makes "no retroactive conversion" fall out for free instead of
 * needing a migration.
 *
 * The tier comes from the lookup and never from `mine.tier`, because the
 * stamped tier is a rendering value: the tier service serves a provisional
 * bronze until the first walk finishes, and sealing deltas with it credited
 * phantom bronze to mines that were never bronze (#41). A mine whose walk has
 * not finished yields observations with NO material — remembered by accrue,
 * credited by nothing.
 *
 * A dwarf whose provider reports no counter is skipped entirely rather than
 * read as zero: absent is not the same as zero, and treating it as zero would
 * look exactly like a counter reset and throw away a perfectly good baseline.
 */
export function observationsFrom(
  mines: readonly Mine[],
  confirmedTierOf: ConfirmedTierLookup
): TokenObservation[] {
  const observations: TokenObservation[] = []
  for (const mine of mines) {
    const confirmed = confirmedTierOf(mine)
    const material = confirmed === undefined ? undefined : materialForTier(confirmed)
    for (const dwarf of mine.dwarfs) {
      if (dwarf.tokensObserved === undefined) continue
      observations.push({
        mineId: mine.id,
        sessionKey: dwarf.id,
        material,
        tokensObserved: dwarf.tokensObserved
      })
    }
  }
  return observations
}

/**
 * Fold one poll's observations into the ledger.
 *
 * Four rules, each of which exists because the alternative credits garbage:
 *
 * 1. A session seen for the FIRST time credits nothing and only records a
 *    baseline. Its counter is a lifetime total, so crediting it whole would
 *    re-credit every token the session had already spent — once per app
 *    restart, forever. Tokens burned before the app ever saw the session are
 *    the historical backfill's job, not this one's.
 * 2. Growth credits the difference, and only the difference.
 * 3. A counter that DECREASED is evidence of a reset (a restarted runtime, a
 *    transcript tail that rolled past the last usage block), never of negative
 *    work. It credits nothing and rebaselines, so the tokens counted once
 *    before the reset are not counted a second time as it climbs back.
 * 4. An observation with NO material — its mine's tier is still being computed
 *    (#41) — credits nothing and leaves any existing baseline exactly where it
 *    was. No material is ever credited from a guess.
 *
 * Rule 4 waits rather than dropping the sighting, and that costs no extra
 * state: #41 offered a choice between discarding provisional observations and
 * holding them until the tier resolves, and the session mark IS the held
 * observation. Freezing it means the delta spanning the wait is credited once,
 * whole, to the tier the walk really found — while a session first seen during
 * the wait still gets its baseline here, so its tokens become creditable the
 * moment the walk lands instead of being forfeited. Discarding outright would
 * have turned phantom bronze into silently missing silver.
 *
 * Coal is refused outright. observationsFrom() cannot produce it, but the
 * invariant "coal is pre-install history and nothing else" is only worth
 * anything if it is enforced where it could actually be broken — a future
 * caller building observations by hand must not be able to inflate the
 * historical pile with live mining.
 */
export function accrue(
  state: LedgerState,
  observations: readonly TokenObservation[],
  now: number
): LedgerState {
  const sessions = { ...state.sessions }
  // Cloned only once something is actually credited, so a poll that changes no
  // total returns the SAME mines object. That identity is what lets a caller
  // tell "the vault moved" from "only the session marks moved", and it keeps
  // an idle machine from rewriting its ledger file forever for nothing.
  let mines: Record<string, MaterialTotals> | null = null

  for (const observation of observations) {
    const { sessionKey, mineId, material, tokensObserved } = observation
    if (!Number.isFinite(tokensObserved) || tokensObserved < 0) continue

    const previous = sessions[sessionKey]
    if (material === undefined) {
      // Rule 4. seenAt still moves so a session waiting on its mine's first
      // walk cannot be pruned out from under its own frozen baseline.
      sessions[sessionKey] =
        previous === undefined
          ? { tokens: tokensObserved, seenAt: now }
          : { tokens: previous.tokens, seenAt: now }
      continue
    }

    sessions[sessionKey] = { tokens: tokensObserved, seenAt: now }
    if (previous === undefined) continue

    const delta = tokensObserved - previous.tokens
    if (delta <= 0 || material === 'coal') continue
    mines ??= { ...state.mines }
    mines[mineId] = addMaterialTokens(mines[mineId] ?? emptyMaterialTotals(), material, delta)
  }

  return { version: state.version, mines: mines ?? state.mines, sessions }
}

/**
 * Credit a material directly, bypassing delta tracking. This is how the coal
 * backfill pays in: it reports a total it computed from history, not a
 * counter to be differenced.
 */
export function creditMaterial(
  state: LedgerState,
  mineId: string,
  material: Material,
  tokens: number
): LedgerState {
  return {
    version: state.version,
    mines: {
      ...state.mines,
      [mineId]: addMaterialTokens(state.mines[mineId] ?? emptyMaterialTotals(), material, tokens)
    },
    sessions: state.sessions
  }
}

/**
 * Forget sessions not seen for longer than the memory window, so the file
 * cannot grow forever on a machine that opens thousands of sessions.
 *
 * Only the delta bookkeeping is dropped — never accrued material. Forgetting a
 * session that later reappears costs at worst the tokens it burned while
 * forgotten (it rebaselines on first sight, per accrue's rule 1), which
 * under-credits rather than double-credits. That is the right direction to err.
 */
export function pruneSessions(
  state: LedgerState,
  now: number,
  retentionMs: number = SESSION_MEMORY_MS
): LedgerState {
  const sessions: Record<string, SessionMark> = {}
  for (const [key, mark] of Object.entries(state.sessions)) {
    if (now - mark.seenAt <= retentionMs) sessions[key] = mark
  }
  return { version: state.version, mines: state.mines, sessions }
}

export function serializeLedger(state: LedgerState): string {
  return `${JSON.stringify(state)}\n`
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** A stored count is only honored when it is a real, non-negative, finite number. */
function asCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function parseTotals(value: unknown): MaterialTotals | null {
  const record = asRecord(value)
  if (record === null) return null
  const totals = emptyMaterialTotals()
  for (const material of MATERIALS) {
    // Unknown keys are ignored and unusable values read as zero, so one junk
    // entry costs that one number rather than the whole mine.
    totals[material] = asCount(record[material]) ?? 0
  }
  return totals
}

function parseMark(value: unknown): SessionMark | null {
  const record = asRecord(value)
  if (record === null) return null
  const tokens = asCount(record.tokens)
  const seenAt = asCount(record.seenAt)
  // A mark missing either half cannot compute a delta, and a made-up value
  // would credit garbage on the next poll. Dropping it just rebaselines.
  if (tokens === null || seenAt === null) return null
  return { tokens, seenAt }
}

/**
 * Pure: stored bytes -> ledger.
 *
 * Follows the same rule as every other userData file in this app (see
 * src/main/pinPreference.ts): a broken document must behave like a missing one
 * and never block startup. The fallback is an empty vault, which costs the
 * user their accrued totals but leaves the app working — and, because accrue()
 * rebaselines every session it has not seen, cannot double-count afterwards.
 *
 * A document from a FUTURE version is discarded whole rather than half-read:
 * guessing at a shape this code does not know would put wrong numbers in front
 * of the user, which is worse than starting over.
 */
export function parseLedger(raw: string): LedgerState {
  try {
    const record = asRecord(JSON.parse(raw))
    if (record === null) return emptyLedger()
    if (record.version !== LEDGER_VERSION) return emptyLedger()

    const storedMines = asRecord(record.mines)
    const storedSessions = asRecord(record.sessions)
    if (storedMines === null || storedSessions === null) return emptyLedger()

    const mines: Record<string, MaterialTotals> = {}
    for (const [mineId, value] of Object.entries(storedMines)) {
      const totals = parseTotals(value)
      if (totals !== null) mines[mineId] = totals
    }

    const sessions: Record<string, SessionMark> = {}
    for (const [key, value] of Object.entries(storedSessions)) {
      const mark = parseMark(value)
      if (mark !== null) sessions[key] = mark
    }

    return { version: LEDGER_VERSION, mines, sessions }
  } catch {
    return emptyLedger()
  }
}
