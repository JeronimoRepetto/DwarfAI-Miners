// Each row `LegacyDwarfIdBridge` serves answers its own "not found" (21 §3; 14 §5): when no legacy dwarf has the
// provider identity of the Host dwarf a row names, the row answers exactly what today's runtime answers for a dwarf id
// nothing on its board answers to, never a nearest match. The shapes are today's (`TODAY_SHAPES` of
// `src/contracts/ipc/todayShapes.ts`), taken from the found tree's handlers (read as reference only):
// `AgentRuntime.activateDwarf`, `sendDwarfText`, `kickDwarf`, `retireDwarf`, `answerDwarfQuestion` and
// `answerDwarfPermission` in `src/main/runtime/runtime.ts`.
//
// Deleted with the bridge at the end of cut 4 (later: ISSUE-241).

/** Today's refusal text for a dwarf id nothing answers to (`NO_SUCH_DWARF` of `src/main/runtime/runtime.ts`). */
export const NO_SUCH_DWARF = 'That dwarf has left the mine.'

/**
 * The "not found" answer of each row the bridge serves, keyed by its today wire name. A-27 is a `send` row: today's
 * runtime answers nothing and does nothing for an unknown id, so its not-found is to do nothing. A-40 and A-41 are
 * listed for the bridge's ask rows (under their qualifier, later: ISSUE-089).
 */
export const NOT_FOUND = {
  /** A-13 (`DwarfActivation`): nothing focused, no terminal opened, no feed. */
  'dwarf:activate': { focused: false, openedTerminal: false, feed: [] },
  /** A-23 (`DwarfTextResult`). */
  'dwarf:sendText': { delivered: false, via: 'none', error: NO_SUCH_DWARF },
  /** A-26 (`DwarfKickResult`). */
  'dwarf:kick': { delivered: false, via: 'none', error: NO_SUCH_DWARF },
  /** A-27: no answer and nothing done. */
  'dwarf:retire': undefined,
  /** A-40 (`DwarfQuestionAnswerResult`). */
  'agent:answerQuestion': { answered: false, error: NO_SUCH_DWARF },
  /** A-41 (`DwarfQuestionAnswerResult`). */
  'agent:answerPermission': { answered: false, error: NO_SUCH_DWARF }
} as const

export type NotFoundRow = keyof typeof NOT_FOUND
