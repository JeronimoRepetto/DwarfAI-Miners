// The "no longer open" answer of each ask row `LegacyAskRelay` serves (21 §3; ADR-010 stale drop): an answer naming a
// `legacy:` ask that is not the one open now on that dwarf is dropped before it reaches today's runtime, and the row
// answers exactly what today's runtime answers for the same fact. The shapes and texts are today's, taken from the
// found tree (read as reference only): `ASK_NO_LONGER_OPEN` of `src/shared/contracts.ts` (A-40) and
// `PROMPT_NO_LONGER_OPEN` of `src/main/runtime/runtime.ts` (A-41), both `DwarfQuestionAnswerResult`.
//
// Deleted with the relay at the end of cut 4 (later: ISSUE-241).
import { ASK_NO_LONGER_OPEN } from '../../shared/contracts'

/** Today's refusal text for a permission request that has since closed (`PROMPT_NO_LONGER_OPEN` of runtime.ts). */
export const PROMPT_NO_LONGER_OPEN = 'That permission request is no longer open.'

/** The "no longer open" answer of each ask row the relay serves, keyed by its today wire name. */
export const NOT_OPEN = {
  /** A-40 (`DwarfQuestionAnswerResult`). */
  'agent:answerQuestion': { answered: false, error: ASK_NO_LONGER_OPEN },
  /** A-41 (`DwarfQuestionAnswerResult`). */
  'agent:answerPermission': { answered: false, error: PROMPT_NO_LONGER_OPEN }
} as const

export type NotOpenRow = keyof typeof NOT_OPEN
