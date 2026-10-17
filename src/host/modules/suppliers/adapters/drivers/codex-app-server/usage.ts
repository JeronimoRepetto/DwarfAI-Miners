// Usage, limits, errors and turn ends of a Codex app-server session (15 §4.4 Keys, Usage / limits;
// ADR-006 items 4–6; ADR-021 item 5; HO-25, HR U1), as pure readers of the notification params.
//
// - Usage: `thread/tokenUsage/updated` carries the thread's lifetime `total` and the `last` model
//   call. A turn's unit (`unitKey` = turn id) is the last total inside the turn minus the total
//   before it started (the previous update's total, else `total − last` of the first one), sealed
//   at `turn/completed` (ADR-006 item 6). Normalized as the Codex observer does (L-05): `input`
//   includes `cached` and `output` includes `reasoning`, so `inputNet = input − cached` and
//   `output = output − reasoning`; `cacheWrite` is taken as reported.
// - Limits: `account/rateLimits/updated` with a `rateLimitReachedType` is `rate-limited` at the
//   reached window's reset instant; below the limit it adds nothing.
// - Errors: an `error` notification is `provider-error` with the provider's error code word
//   (`codexErrorInfo`), never its message text (ADR-026), and whether Codex retries; `unauthorized`
//   is the CLI reporting it is not logged in (`auth-required`, ADR-008 item 2).
// - Turn ends: `TurnStatus` `completed → concluded`, `interrupted → interrupted`, `failed →
//   errored`, any other value → `errored` with the raw word (ADR-021 item 5).
import type { TurnEndKind, UsageObservation } from '../../../../../kernel/domain/sharedContracts'
import type { DriverErrorCause } from '../../../ports/providerDriver'

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}

/** One `TokenUsageBreakdown` of the protocol. */
export interface TokenTotals {
  readonly input: number
  readonly cached: number
  readonly cacheWrite: number
  readonly output: number
  readonly reasoning: number
}

function totalsOf(value: unknown): TokenTotals | null {
  if (!isRecord(value)) return null
  return {
    input: count(value.inputTokens),
    cached: count(value.cachedInputTokens),
    cacheWrite: count(value.cacheWriteInputTokens),
    output: count(value.outputTokens),
    reasoning: count(value.reasoningOutputTokens)
  }
}

/** `a − b` per counter, or null when a counter went down (a reset, not usage). */
export function minus(a: TokenTotals, b: TokenTotals): TokenTotals | null {
  const d: TokenTotals = {
    input: a.input - b.input,
    cached: a.cached - b.cached,
    cacheWrite: a.cacheWrite - b.cacheWrite,
    output: a.output - b.output,
    reasoning: a.reasoning - b.reasoning
  }
  return Object.values(d).some((n) => n < 0) ? null : d
}

/** A `thread/tokenUsage/updated` notification's thread, turn and both breakdowns. */
export function readTokenUsage(
  params: unknown
): { threadId: string; turnId: string; total: TokenTotals; last: TokenTotals } | null {
  if (!isRecord(params) || !isRecord(params.tokenUsage)) return null
  const { threadId, turnId } = params
  const total = totalsOf(params.tokenUsage.total)
  const last = totalsOf(params.tokenUsage.last)
  if (typeof threadId !== 'string' || typeof turnId !== 'string') return null
  if (total === null || last === null) return null
  return { threadId, turnId, total, last }
}

/** The normalized tokens of one unit (L-05). */
export function unitTokens(d: TokenTotals): UsageObservation['tokens'] {
  return {
    inputNet: Math.max(0, d.input - d.cached),
    output: Math.max(0, d.output - d.reasoning),
    cacheRead: d.cached,
    cacheWrite: d.cacheWrite,
    reasoning: d.reasoning
  }
}

/** The reset instant of a reached limit (ms), `undefined` when unknown; `null`: not reached. */
export function rateLimitReached(params: unknown): { resetAt: number | undefined } | null {
  if (!isRecord(params) || !isRecord(params.rateLimits)) return null
  const limits = params.rateLimits
  if (typeof limits.rateLimitReachedType !== 'string') return null
  const windows = [limits.primary, limits.secondary].filter(isRecord)
  const reached =
    windows.find((window) => typeof window.usedPercent === 'number' && window.usedPercent >= 100) ??
    windows[0]
  const resetsAt = reached?.resetsAt
  return { resetAt: typeof resetsAt === 'number' ? resetsAt * 1000 : undefined }
}

/** The provider's error code word: a `codexErrorInfo` string, or the name of its variant. */
export function errorWord(error: unknown): string | null {
  if (!isRecord(error)) return null
  const info = error.codexErrorInfo
  if (typeof info === 'string' && info !== '') return info
  if (isRecord(info)) return Object.keys(info)[0] ?? null
  return null
}

/** An `error` notification as a driver error cause (HO-33: reported once per distinct cause). */
export function errorCause(params: unknown): DriverErrorCause {
  const p = isRecord(params) ? params : {}
  const word = errorWord(p.error) ?? 'error'
  if (word === 'unauthorized') return { kind: 'auth-required' }
  return { kind: 'provider-error', detail: word, retryable: p.willRetry === true }
}

/** ADR-021 item 5 for a `turn/completed` turn. */
export function turnEndOf(turn: Rec): { kind: TurnEndKind; detail?: string } {
  const status = turn.status
  if (status === 'completed') return { kind: 'concluded' }
  if (status === 'interrupted') return { kind: 'interrupted' }
  if (status === 'failed') return { kind: 'errored', detail: errorWord(turn.error) ?? 'failed' }
  return {
    kind: 'errored',
    detail: typeof status === 'string' && status !== '' ? status : 'unknown'
  }
}
