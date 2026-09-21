import type { SDKResultSuccess } from '@anthropic-ai/claude-agent-sdk'
import { boundTurnText, type TurnOutcome, type TurnOutcomeKind } from '../domain/types'

type Assert<T extends true> = T

/**
 * Compile-time tripwire (#510). `ClaudeResultMessage` below keeps `result`
 * optional so a real error result is assignable to it, and that leniency has
 * one failure mode: an SDK release that renamed the success result's text
 * field would still compile, and every concluded turn would then be recorded
 * as an empty conclusion without a single test noticing — `sdkHeldSession.ts`
 * has no test through the live SDK stream. This alias fails `pnpm typecheck`
 * the moment `SDKResultSuccess['result']` stops being a string, which is the
 * only place that rename could be caught before it shipped.
 */
export type SuccessResultIsText = Assert<SDKResultSuccess['result'] extends string ? true : false>

/**
 * The slice of Claude's own `result` message this function reads — narrower
 * than the Agent SDK's own `SDKResultMessage` (#510), deliberately: every
 * subtype the SDK declares is structurally assignable to it (checked
 * against the installed `@anthropic-ai/claude-agent-sdk`'s own `sdk.d.ts`),
 * and a narrow parameter is what lets `resultTurnOutcome` be proven with a
 * hand-built fixture rather than the SDK's whole result shape —
 * `duration_ms`, `modelUsage`, `permission_denials` and the rest of it, none
 * of which this app reads.
 *
 * `result` is optional here for the same reason it is absent on
 * `SDKResultError` entirely: the installed SDK's own types carry it only on
 * `SDKResultSuccess`, so a caller passing a real error result simply has
 * nothing to hand over, and TypeScript accepts it structurally without this
 * function ever seeing the SDK's own union.
 */
export interface ClaudeResultMessage {
  subtype: string
  result?: string
}

/**
 * Claude's own `result` message, mapped onto this app's turn-outcome
 * vocabulary (#510) — read straight off `subtype`, and pure so it can be
 * proven without the Agent SDK's `query()` ever running: `sdkHeldSession.ts`
 * itself has no unit test (see its own module comment), so the decision this
 * function makes lives here instead — the same split `heldCrew.ts` already
 * draws for a task signal.
 *
 * `success` is a genuine conclusion, and its own `result` string is the
 * turn's final word, bounded like every other message this app draws (see
 * `boundTurnText`). `error_max_turns` and `error_max_budget_usd` are the SDK
 * stopping a turn on its OWN limit rather than finishing it — capped, not
 * failed. `error_during_execution` is an execution failure the SDK reported
 * as one. Every other error subtype — `error_max_structured_output_retries`
 * today, and whatever a future SDK adds — reads as `errored` too, carrying
 * the subtype verbatim as `detail` rather than this app inventing a word for
 * a shape it has not been told the meaning of.
 *
 * None of the error variants ever carries a `result` string (SDKResultError
 * declares no such field, on any subtype), so every branch but `success`
 * leaves `text` absent on purpose — never an empty string standing in for a
 * turn that did not conclude.
 */
export function resultTurnOutcome(message: ClaudeResultMessage, now: number): TurnOutcome {
  if (message.subtype === 'success') {
    const { text, truncated } = boundTurnText(message.result ?? '')
    return { kind: 'concluded', text, ...(truncated ? { truncated: true } : {}), endedAt: now }
  }
  const kind: TurnOutcomeKind =
    message.subtype === 'error_max_turns' || message.subtype === 'error_max_budget_usd'
      ? 'capped'
      : 'errored'
  return { kind, detail: message.subtype, endedAt: now }
}
