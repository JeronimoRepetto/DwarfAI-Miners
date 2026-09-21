import type { TurnOutcome, TurnOutcomeKind } from '../../types'

/**
 * One line under the panel's header, for #510: how the dwarf's last turn
 * ended, read straight off `dwarf.lastTurn` — nothing this component infers.
 *
 * Deliberately silent about delivery and reaction: those are their own wire
 * facts with their own rows (`sendStatusLine`, `kickStatusLine`), and the
 * `AGENTS.md` invariant they rest on — "delivered and reacted are different
 * facts" — applies here just as much. This line says only how the turn
 * itself concluded, never that anything downstream saw or acted on it.
 */
export interface TurnOutcomeLine {
  kind: TurnOutcomeKind
  /** The one sentence every kind carries; capped/errored/interrupted embed the provider's own word. */
  headline: string
  /** Only a `concluded` turn's own text — never invented for the other three kinds. */
  text?: string
  /** Whether the wire itself cut `text` at its bound (`boundTurnText`), independent of the panel's own visual clamp. */
  trimmed: boolean
}

/**
 * `detail` is the provider's own word, carried verbatim per `TurnOutcome`'s
 * own contract — this reads it back exactly rather than reworking it into a
 * friendlier phrase this app invented, so a reader can trace the sentence
 * back to what the provider actually said.
 */
function withDetail(sentence: string, detail: string | undefined): string {
  return detail === undefined ? sentence : `${sentence} (${detail})`
}

export function turnOutcomeLine(lastTurn: TurnOutcome | undefined): TurnOutcomeLine | undefined {
  if (lastTurn === undefined) return undefined
  switch (lastTurn.kind) {
    case 'concluded':
      return {
        kind: 'concluded',
        headline: 'Last turn concluded',
        text: lastTurn.text,
        trimmed: lastTurn.truncated === true
      }
    case 'capped':
      return {
        kind: 'capped',
        headline: withDetail('Last turn stopped at a limit', lastTurn.detail),
        trimmed: false
      }
    case 'errored':
      return {
        kind: 'errored',
        headline: withDetail('Last turn failed', lastTurn.detail),
        trimmed: false
      }
    case 'interrupted':
      return {
        kind: 'interrupted',
        headline: withDetail('Last turn was interrupted', lastTurn.detail),
        trimmed: false
      }
    default: {
      // Exhaustive: TurnOutcomeKind has exactly four members today. A future
      // addition fails `pnpm typecheck` here rather than silently drawing
      // nothing for a turn outcome this function was never told the meaning of.
      const exhaustive: never = lastTurn.kind
      return exhaustive
    }
  }
}
