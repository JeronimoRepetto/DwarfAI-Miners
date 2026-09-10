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
 * ## Where these digits may be pressed, which is not this file's question
 *
 * A keystroke lands wherever the foreground is, so a session sharing its
 * terminal window with other tabs must never be typed into: a digit aimed at
 * one picker would choose an option in another tab's. That is the port's
 * shared-window refusal (#329), and #371 is what made it fire on the right
 * fact — a probed console handle can be a phantom OWNED by a Windows Terminal
 * window, and only an owner proven to draw one console is this session's. So a
 * shared tab strip is refused here rather than answered blind, and what is left
 * open is the millisecond after the runtime's re-read of the board.
 */

/** Why no keystroke could be derived — one reason per fact, never a bare null. */
export type QuestionKeystrokeRefusal =
  /** The call carried more than one question, and only its first is on the wire. */
  | 'several-questions'
  /** Nothing was chosen, and `{RIGHT}{ENTER}` alone would accept an empty answer. */
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
 * `submit` is the multi-select confirmation — `{RIGHT}` then `{ENTER}` — and is
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
