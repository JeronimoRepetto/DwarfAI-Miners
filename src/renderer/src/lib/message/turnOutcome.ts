import type { TurnOutcome, TurnOutcomeKind } from '../../types'

/*
 * How a finished turn ended, as the MessagePanel's outcome line opens (#510, #635; decision log,
 * Turn outcome line): read straight off `dwarf.lastTurn`, nothing this app infers.
 *
 * Deliberately silent about delivery and reaction: those are their own wire facts with their own
 * rows, and the `AGENTS.md` invariant they rest on — "delivered and reacted are different facts" —
 * applies here just as much. The word says only how the turn itself concluded.
 *
 * The provider's own `detail` and a concluded turn's closing `text` stay on the wire and off the
 * line (MESSAGE-QUESTIONS 7): the line is three parts the app observes, and the turn's words are
 * the conversation's to show.
 */
const WORD: Record<TurnOutcomeKind, string> = {
  concluded: 'Turn finished',
  // A limit the provider stopped on is not a conclusion, and neither is a failure: each replaces
  // "Turn finished" rather than qualifying it, so a failed turn never reads as a quiet success.
  capped: 'Turn stopped at a limit',
  errored: 'Turn failed',
  interrupted: 'Turn interrupted'
}

/**
 * The word for a turn that is over. With no `lastTurn` — a session the app only observes, which
 * reports no end-of-turn message — a resting dwarf's turn is still finished, and says only that.
 */
export function finishedTurnWord(lastTurn: TurnOutcome | undefined): string {
  return lastTurn === undefined ? WORD.concluded : WORD[lastTurn.kind]
}
