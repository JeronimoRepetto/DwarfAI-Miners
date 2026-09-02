/**
 * Adopting a folder as a mine, from the panel's side (#85).
 *
 * The renderer never names a path: main opens the OS picker itself, so the
 * whole request is "ask", and the only judgement left here is what a refusal
 * is worth saying out loud.
 */
import type { MineDeclareResult } from '../../types'

/**
 * What main sends back when the user closed the picker without choosing.
 *
 * MineDeclareResult carries no cancelled/failed flag — only `declared` and a
 * sentence — so a user who changed their mind and a projects database that
 * refused arrive in exactly the same shape, and the only thing separating them
 * is this string. It is matched EXACTLY on purpose: a loose match would
 * eventually swallow a real failure, and a silent Add button is the one
 * outcome main states every refusal to avoid. If main rewords this, a cancel
 * starts showing as a notice — noisy, and the safe direction to be wrong in.
 *
 * The structural fix belongs on the wire, where MineUndeclareResult already
 * has it: a discriminated outcome instead of prose.
 */
export const PICKER_CANCELLED_REASON = 'No folder was chosen.'

/** Said when a refusal arrives with no reason at all, which the contract does not allow for. */
const UNSTATED_REFUSAL = 'That folder could not be added.'

/**
 * What the panel should show about a finished declare, or null for nothing.
 *
 * Null twice over, for two different reasons: a folder that WAS adopted needs
 * no notice because the list itself is the feedback, and a cancelled picker
 * needs none because backing out is a decision rather than a fault.
 */
export function declareFailureNotice(result: MineDeclareResult): string | null {
  if (result.declared) return null
  if (result.reason === PICKER_CANCELLED_REASON) return null
  return result.reason ?? UNSTATED_REFUSAL
}
