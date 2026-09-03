import type { Dwarf, Mine } from '../../types'

/**
 * Which arriving dwarf is the one this panel just launched (#86).
 *
 * The launch verdict deliberately carries no dwarf id — the contract says so at
 * length, and means it: the session's id is not known at that moment, and the
 * dwarf arrives on an ordinary poll up to `pollIntervalMs` later, exactly as a
 * session somebody else started does. Claiming a dwarf in the verdict would be
 * the second observation path #86 refuses.
 *
 * So the panel recognises it instead of being told, and it recognises it by
 * EVIDENCE rather than by timing. "The dwarf that was not here a moment ago"
 * would adopt whatever happened to start next; what the launch actually leaves
 * behind is a receipt — `HeldSessionRegistry.launch` seeds the new session's
 * conversation with the exact prompt it sent, so a held exchange opening with
 * that prompt is this launch and no other session's.
 *
 * That the evidence is a HELD conversation is half the strength of it: only a
 * session this panel started and holds carries one at all, so an observed
 * session can never be mistaken for a launch however well its words match.
 *
 * Nothing here reads a role. The launched session's role is whatever main says
 * it is, and how that is derived is moving (#157) — a rule that recognised a
 * launch by its rank would break the moment rank did.
 */
export function launchedDwarfIn(mine: Mine | undefined, prompt: string): Dwarf | undefined {
  // A prompt of nothing was never sent, so nothing on the board is its receipt.
  if (mine === undefined || prompt === '') return undefined
  return (
    mine.dwarfs
      .filter((dwarf) => {
        const first = dwarf.conversation?.[0]
        return first !== undefined && first.role === 'user' && first.text === prompt
      })
      // Two launches with identical prompts are indistinguishable by their own
      // evidence. The tie breaks on id so the panel cannot change its mind about
      // which dwarf it opened on between two snapshots of the same board.
      .sort((left, right) => left.id.localeCompare(right.id))[0]
  )
}
