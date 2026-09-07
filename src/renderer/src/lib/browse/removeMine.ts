/**
 * Removing a mine, from the panel's side (#169).
 *
 * The sibling of addProject.ts and deliberately the same shape: main owns the
 * verdict, the panel names a mine id and never a path, and the only judgement
 * left here is what a refusal is worth saying out loud.
 */
import type { MineUndeclareResult } from '../../types'

/** Said when a refusal arrives with no reason at all, which the contract does not allow for. */
const UNSTATED_REFUSAL = 'That mine could not be removed.'

/**
 * What the panel should show about a finished removal, or null for nothing.
 *
 * Null for exactly ONE outcome, unlike the add half's two: the card
 * disappearing is the feedback for a removal, and there is no cancelled case to
 * be quiet about — closing the confirmation never reaches main at all.
 *
 * 'unchanged' speaks up rather than passing as a success. It means main is not
 * tracking that mine, so nothing was removed — and the card the user pressed is
 * still on screen, which without a word would read as the control being broken.
 */
export function removeFailureNotice(result: MineUndeclareResult): string | null {
  if (result.outcome === 'removed') return null
  return result.reason ?? UNSTATED_REFUSAL
}
