import type { DwarfQuestion } from '../domain/types'

/**
 * Which digits this app presses in somebody else's console to answer Claude
 * Code's `AskUserQuestion` picker (#362) — measured, per gesture, per CLI
 * build. The sibling of permissionKeys, and it holds its measurement the same
 * way: written down here with the build it was taken against, so changing what
 * is claimed costs a deliberate edit in one file.
 *
 * ## The picker is a selector, and its two gestures are not the same gesture
 *
 * Measured live by the maintainer on **Claude Code 2.1.267**, Windows Terminal,
 * 2026-09-10, with one question per call:
 *
 * - **Single-select**: pressing the option's DIGIT selects and submits by
 *   itself. No Enter, no confirmation screen — the shape #203's permission
 *   digit already had.
 * - **Multi-select**: each DIGIT toggles its option, and the cursor does not
 *   move. `End` does nothing; `PageDown` jumps to the free-text "Other" row.
 *   **Right arrow** shows a summary of what is toggled and **Enter** accepts
 *   it, which is the same act as arrowing down to the Submit row without having
 *   to count the rows.
 * - Digits number the options in the order the AGENT gave them, 1-based.
 *
 * Three earlier readings were wrong and are recorded so they are not
 * re-derived: Enter does not submit a multi-select (it toggles the row the
 * cursor is on), the Submit row carries no digit, and `PageDown` is not a jump
 * to it. See docs/console-hosting.md for the three measurement rounds.
 *
 * **Re-measured through the pid write on 2026-09-16, Claude Code 2.1.273, and
 * every gesture above held** — see `questionAnswerChunks` below and
 * `docs/console-hosting.md` §6. What changed is not the keys but where they
 * land: written into the session's own console rather than synthesized at a
 * window. One thing the 2.1.267 reading did not say and this build does: the
 * picker numbers its OWN rows after the agent's, so a "Type something" row takes
 * the digit immediately past the last option — which is why a digit beyond the
 * option count is a row nobody chose rather than a no-op.
 *
 * ## What this refuses, and why each refusal is not a gap
 *
 * A refusal is a typed reason rather than a null, because the runtime turns
 * each one into a sentence for the person — these are different facts about
 * their own session, not one failure with several causes.
 *
 * `several-questions` is the load-bearing one. A call that asked two things has
 * only its first question on the wire (both writers say so), so typing an
 * answer walks the picker on to a question the panel does not know exists and
 * leaves the call half answered in a TUI nothing here can read. That ask
 * belongs to its own terminal until the wire carries every question of it.
 *
 * `option-chosen-twice` exists because a digit TOGGLES: two identical digits
 * leave the option exactly as it started, so the answer sent would not be the
 * answer given. Deduplicating instead would send an answer nobody chose.
 *
 * ## Where these keys land, which stopped being a question at #402
 *
 * They used to be synthesized at whatever window held the foreground, so a
 * session sharing its terminal window with other tabs could not be answered at
 * all: a digit aimed at one picker would have chosen an option in another tab's,
 * and the port refused rather than guess (#329). They are written into the
 * console the session's own pid names now, exactly as a message has been since
 * #371 — no window is raised and the tab strip is never consulted, so the
 * refusal has nothing left to refuse. What is still open is the millisecond
 * after the runtime's re-read of the board.
 */

/** Why no keystroke could be derived — one reason per fact, never a bare null. */
export type QuestionKeystrokeRefusal =
  /** The call carried more than one question, and only its first is on the wire. */
  | 'several-questions'
  /** Nothing was chosen, and a bare confirmation would accept an empty answer. */
  | 'nothing-chosen'
  /** A label with no option behind it: nothing here may invent a row to press. */
  | 'label-not-offered'
  /** Several labels for an ask that said it takes one. */
  | 'wrong-arity'
  /** The same option twice, which a toggling digit would leave switched off. */
  | 'option-chosen-twice'
  /** More options than the picker numbers, so some row has no digit at all. */
  | 'more-options-than-digits'

/**
 * The keys that answer an ask, or the reason there are none.
 *
 * `digits` is ascending in the ask's own option order rather than in click
 * order: the sequence has to be deterministic from the picker's initial state,
 * and the order a person happened to click in is not part of that state.
 * `submit` is the multi-select confirmation — cursor-right, then Enter — and is
 * false for a single-select, which fires on its digit alone.
 */
export type QuestionKeystrokes =
  { ok: true; digits: string[]; submit: boolean } | { ok: false; reason: QuestionKeystrokeRefusal }

/** The nine rows the picker numbers. A tenth option has no key to press. */
const MAX_NUMBERED_OPTIONS = 9

/**
 * The digits that answer `question` with `chosenLabels`, or the reason they
 * cannot be derived.
 *
 * Labels are matched EXACTLY against the options the ask carries — the same
 * discipline `resolveAnswers` holds on the held channel, for the same reason:
 * an answer may only ever repeat the agent's own words back, and a label
 * matched loosely would press a row nobody chose.
 *
 * The arity check runs in ONE direction: a single-select ask refuses several
 * labels, while a multi-select ask takes one — a lone toggle is a legitimate
 * answer to "choose any", and it still needs the confirmation returned for it.
 * The other direction, a single-select ask answered through the multi-select
 * gesture, cannot be expressed at all, because `submit` is derived from the ask
 * here rather than passed in by a caller that could get it wrong.
 */
export function questionKeystrokesFor(
  question: DwarfQuestion,
  chosenLabels: readonly string[]
): QuestionKeystrokes {
  if (question.questionCount > 1) return { ok: false, reason: 'several-questions' }
  if (question.options.length > MAX_NUMBERED_OPTIONS) {
    return { ok: false, reason: 'more-options-than-digits' }
  }
  if (chosenLabels.length === 0) return { ok: false, reason: 'nothing-chosen' }
  if (!question.multiSelect && chosenLabels.length > 1) return { ok: false, reason: 'wrong-arity' }
  if (new Set(chosenLabels).size !== chosenLabels.length) {
    return { ok: false, reason: 'option-chosen-twice' }
  }

  const positions: number[] = []
  for (const label of chosenLabels) {
    const index = question.options.findIndex((option) => option.label === label)
    if (index === -1) return { ok: false, reason: 'label-not-offered' }
    positions.push(index + 1)
  }
  return {
    ok: true,
    digits: positions.sort((left, right) => left - right).map(String),
    submit: question.multiSelect
  }
}

/**
 * The VT "cursor right" sequence — `ESC`, `[`, `C` — which is what a multi-select
 * picker's confirmation turned out to be (#402).
 *
 * Three ORDINARY CHARACTERS, and that is the whole finding. #362 spelled this
 * key as SendKeys' `{RIGHT}` and #371 left the picker on the keystroke path
 * because a virtual key carrying no character is not a record anything had
 * measured. It never needed to be one: ConPTY hands the hosted process VT input,
 * so the arrow the picker reads is these three code units, written as text
 * records like any other. Measured live 2026-09-16 against a real multi-select
 * picker — the summary opened and the toggles were the ones chosen
 * [docs/console-hosting.md §6].
 */
const CURSOR_RIGHT = '\u001b[C'

/** The carriage return that accepts the summary cursor-right opens. */
const ACCEPT = '\r'

/** The nine digits the picker numbers, and the only payload this path may carry. */
const ANSWER_DIGIT = /^[1-9]$/

/**
 * The chunks that answer a picker, one per `WriteConsoleInputW` call, or null
 * for digits nothing here may press.
 *
 * A LIST rather than a string, because a chunk arriving inside another chunk's
 * call is read by a live TUI as pasted content rather than as a keystroke —
 * #404's rule for Enter, which #402 measured holds for every key of an answer.
 * The list is what `buildConsoleInputSequenceCommand` turns into calls.
 *
 * The digit guard is this function's whole safety, and it moved here from
 * `buildQuestionAnswerCommand` when #402 deleted that builder: a digit is the
 * entire payload, so anything that is not one of the nine must stop here rather
 * than reach somebody else's console as characters.
 *
 * Null rather than a throw, and for the two reasons the one caller states to the
 * person: nothing was chosen — a confirmation with no toggle in front of it
 * would accept an empty answer — or more rows than the picker numbers.
 */
export function questionAnswerChunks(digits: readonly string[], submit: boolean): string[] | null {
  if (digits.length === 0 || digits.length > MAX_NUMBERED_OPTIONS) return null
  if (digits.some((digit) => !ANSWER_DIGIT.test(digit))) return null
  return submit ? [...digits, CURSOR_RIGHT, ACCEPT] : [...digits]
}
