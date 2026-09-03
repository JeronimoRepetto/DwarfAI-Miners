/**
 * Adopting a folder as a mine, from the panel's side (#85, #127).
 *
 * The renderer never names a path: main opens the OS picker itself, so the
 * whole request is "ask", and the only judgement left here is what a refusal
 * is worth saying out loud.
 */
import type { MineDeclareResult } from '../../types'

/** Said when a refusal arrives with no reason at all, which the contract does not allow for. */
const UNSTATED_REFUSAL = 'That folder could not be added.'

/**
 * What the panel should show about a finished declare, or null for nothing.
 *
 * Null twice over, for two different reasons: a folder that WAS adopted needs
 * no notice because the list itself is the feedback, and a cancelled picker
 * needs none because backing out is a decision rather than a fault. `outcome`
 * says which is which directly now (#127) — there is no longer a sentence on
 * the wire to match, exactly or otherwise.
 */
export function declareFailureNotice(result: MineDeclareResult): string | null {
  if (result.outcome !== 'failed') return null
  return result.reason ?? UNSTATED_REFUSAL
}
