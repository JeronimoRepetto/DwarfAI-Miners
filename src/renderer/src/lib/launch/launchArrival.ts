import type { Dwarf, Mine } from '../../types'

/**
 * Which arriving dwarf is the one this panel just launched (#86, #191).
 *
 * The launch verdict deliberately carries no dwarf id — the contract says so at
 * length, and means it: the session's id is not known at that moment, and the
 * dwarf arrives on an ordinary poll up to `pollIntervalMs` later, exactly as a
 * session somebody else started does. Claiming a dwarf in the verdict would be
 * the second observation path #86 refuses.
 *
 * So the panel recognises it instead of being told, and it recognises it by
 * EVIDENCE rather than by timing. "The dwarf that was not here a moment ago"
 * would adopt whatever happened to start next.
 *
 * ## Two receipts, and a launch carries exactly one
 *
 * A HELD launch leaves its evidence on the board directly:
 * `HeldSessionRegistry.launch` seeds the new session's conversation with the
 * exact prompt it sent, so a held exchange opening with that prompt is this
 * launch and no other session's. That the evidence is a HELD conversation is
 * half the strength of it — only a session this panel started and holds
 * carries one at all, so an observed session can never be mistaken for a
 * launch however well its words match. A hosted process (#194) is recognised
 * the same way, because main seeds its conversation identically.
 *
 * A DETACHED launch leaves no conversation, and until #191 that left the panel
 * with nothing: it stopped at "the session started" and never handed over,
 * while its dwarf appeared, replied and walked out. Its evidence is the
 * session's own transcript, whose first human turn is the prompt that was sent
 * — the SAME match, against the observed store instead of a held stream. That
 * match runs in main, where both strings are raw and neither has to survive
 * the wire's redaction, and what arrives here is main's verdict: the receipt
 * it opened for this launch, stamped on the dwarf it proved (Dwarf.launchId).
 *
 * A launch holds one or the other, never both, so `launchId` decides which
 * question is asked. Words are not evidence for a detached launch — nothing on
 * the wire carries a detached session's opening turn — and a receipt is not
 * evidence for a held one, because main opens none for it.
 *
 * Nothing here reads a role. The launched session's role is whatever main says
 * it is, and how that is derived is moving (#157) — a rule that recognised a
 * launch by its rank would break the moment rank did.
 */
export function launchedDwarfIn(
  mine: Mine | undefined,
  prompt: string,
  launchId: string | null = null
): Dwarf | undefined {
  if (mine === undefined) return undefined
  // A prompt of nothing was never sent, so no held exchange on the board is
  // its receipt. It says nothing about a detached launch, whose receipt main
  // issued and which is not made of the prompt at all.
  if (launchId === null && prompt === '') return undefined
  const carriesTheReceipt =
    launchId === null
      ? (dwarf: Dwarf): boolean => {
          const first = dwarf.conversation?.[0]
          return first !== undefined && first.role === 'user' && first.text === prompt
        }
      : (dwarf: Dwarf): boolean => dwarf.launchId === launchId
  return (
    mine.dwarfs
      .filter(carriesTheReceipt)
      // Two launches with identical prompts are indistinguishable by their own
      // evidence. The tie breaks on id so the panel cannot change its mind about
      // which dwarf it opened on between two snapshots of the same board.
      .sort((left, right) => left.id.localeCompare(right.id))[0]
  )
}
