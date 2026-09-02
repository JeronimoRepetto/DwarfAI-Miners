import { redactSecrets } from '../domain/redactSecrets'
import { MAX_DWARF_TEXT_CHARS } from '../domain/types'
import type { DwarfQuestion, DwarfQuestionOption, Mine } from '../domain/types'

/**
 * A session the panel STARTED and still HOLDS, as opposed to one it merely
 * discovered on disk (#86, #94).
 *
 * The whole point of holding one is the ask-answer loop. A session the panel
 * only observes writes its `AskUserQuestion` block to the transcript when the
 * menu RESOLVES, backdated — measured twice on 2026-09-02 — so while the menu
 * is open there is nothing on disk to read, and `Dwarf.pendingQuestion` derived
 * from the tail is strictly post-hoc for those sessions. A held session hands
 * the same ask to the host LIVE, through the Agent SDK's `canUseTool`, with the
 * question, the header, `multiSelect` and every option's label and description
 * already structured; the host answers programmatically and the tool call
 * proceeds. That is the one measured route from "an agent asked something" to a
 * button in this panel.
 *
 * This module is the part of that with no SDK in it: narrowing the tool input,
 * putting it on the wire, and turning an answer from the panel back into the
 * strings the agent itself wrote. The SDK lives behind HeldSessionPort, in
 * sdkHeldSession.ts, and nothing here imports it — the same seam the relay and
 * the launch runner keep, for the same reason: no unit test may spawn an agent.
 */

/** One question inside an ask, exactly as the agent worded it — never redacted. */
export interface HeldAskQuestion {
  question: string
  header?: string
  multiSelect: boolean
  options: DwarfQuestionOption[]
}

/**
 * One `AskUserQuestion` tool call, waiting on an answer.
 *
 * `toolUseId` is the SDK's own `toolUseID` for the call, and it is what makes
 * the round trip matched rather than inferred: an answer names the id it
 * answers, so a reply that arrives after the ask is gone is refused instead of
 * landing on whatever is open now.
 */
export interface HeldAsk {
  toolUseId: string
  /** Every question the call carried (the schema allows one to four), in order. */
  questions: HeldAskQuestion[]
}

/**
 * What the host hands back for one ask.
 *
 * `answered: false` is the honest shape for every way an ask can end without a
 * choice — the session finished, the panel quit, the answer was refused. It is
 * NOT an empty answers record: sending the tool `answers: {}` would be this app
 * telling an agent that its user chose nothing, which is a different claim from
 * "nobody ever got to choose". The adapter turns it into a denial with that
 * reason, so the transcript records a question that dissolved.
 */
export type HeldAnswer =
  { answered: true; answers: AnswerRecord } | { answered: false; reason: string }

/** A live held session, as the registry holds it — nothing about the SDK. */
export interface HeldSessionHandle {
  /**
   * End the session and let the child go. The transcript on disk survives and
   * is resumable by id (`claude --resume <id>`, or the SDK's own `resume`
   * option), so closing loses the in-flight turn and nothing else.
   */
  close(): void
  /**
   * Queue a user message onto the held stream. False when the stream will not
   * take it — a session already closing, above all.
   */
  send(text: string): boolean
}

/** What the port needs to start one held session. */
export interface HeldSessionStartRequest {
  /**
   * The CLI binary, as detection found it (#91) — never a path this app
   * constructed, and never left to the SDK's own bundled executable: that one
   * failed to launch from pnpm's deep store on Windows, measured 2026-09-02.
   */
  executablePath: string
  /** The mine's folder. This, and nothing else, is what puts the new dwarf in the right mine. */
  cwd: string
  /** The first prompt. Never logged, and never placed in a process argument. */
  prompt: string
  /** The model, or undefined to leave it to the CLI's own default. */
  model?: string
  /** A ceiling on agent turns, or undefined for the CLI's own default. */
  maxTurns?: number
  /** The CLI reporting the session id it chose, once it does. */
  onSessionId: (sessionId: string) => void
  /**
   * An `AskUserQuestion` reached the permission callback. The agent's tool call
   * stays BLOCKED until this resolves, which is the whole mechanism: there is
   * no deadline on it, because a human is on the other end.
   */
  onAsk: (toolUseId: string, input: Record<string, unknown>) => Promise<HeldAnswer>
  /** The session finished, one way or another. Always called exactly once. */
  onEnd: (reason: string) => void
}

/** The seam the Agent SDK sits behind. See sdkHeldSession.ts for the real one. */
export type HeldSessionPort = (request: HeldSessionStartRequest) => Promise<HeldSessionHandle>

/**
 * The prompt as it will reach the session: trimmed, and capped at the same
 * limit a delivered message gets, for the reason sendDwarfText caps its own
 * payload.
 *
 * The detached launch mode applies the same cap in its own module (#86's first
 * cut). When both modes are in the tree the two should collapse into one
 * helper; they are duplicated rather than shared across a merge nobody has
 * done yet.
 */
export function prepareHeldPrompt(text: string): string {
  return text.trim().slice(0, MAX_DWARF_TEXT_CHARS)
}

/** What the panel is told about a session's open ask, once it has been redacted. */
export type HeldQuestionState =
  /** Not a session this panel holds: whatever the provider derived stands. */
  | { held: false }
  /** Held, and this is the whole truth about its open asks — including none. */
  | { held: true; question?: DwarfQuestion }

/** The answers record as the tool takes it: keyed by question TEXT, valued by option LABEL. */
export type AnswerRecord = Record<string, string>

export type AnswerResolution = { ok: true; answers: AnswerRecord } | { ok: false; reason: string }

/** Refusals for an answer that cannot be sent as-is, phrased for the panel. */
const NOTHING_ANSWERED = 'No answer was chosen.'
const TOO_MANY_ANSWERS = 'That is more answers than the agent asked for.'
const UNKNOWN_QUESTION = 'The agent did not ask that question.'
const AMBIGUOUS_QUESTION = 'Two of the questions read the same, so that answer cannot be matched.'
const UNKNOWN_OPTION = 'The agent did not offer that option.'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * One option, or undefined when it carries no label.
 *
 * `preview` is dropped here rather than travelling: it is mockup content for a
 * picker that renders it, and the panel has no such surface — carrying it would
 * put arbitrary agent-authored payload on the wire for nothing.
 *
 * A label is the whole answer, so an entry without one could never be chosen
 * and is not an offer. It is dropped ALONE, while a question that is not the
 * shape the schema promises takes the whole ask down (see below): the same
 * split the transcript-derived parse drew (#94 phase 1).
 */
function parseOption(value: unknown): DwarfQuestionOption | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.label !== 'string' || value.label === '') return undefined
  return {
    label: value.label,
    ...(typeof value.description === 'string' && value.description !== ''
      ? { description: value.description }
      : {})
  }
}

/** One question, or undefined when the block is not the shape the schema promises. */
function parseQuestion(value: unknown): HeldAskQuestion | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.question !== 'string' || value.question === '') return undefined
  // A non-array where the schema promises a list means this is not the block
  // this parser thinks it is, so nothing is salvaged from it.
  if (!Array.isArray(value.options)) return undefined
  const options = value.options
    .map(parseOption)
    .filter((option): option is DwarfQuestionOption => option !== undefined)
  // Nothing could answer a question with no readable option, and an ask the
  // panel cannot answer is worse than one it never showed.
  if (options.length === 0) return undefined
  return {
    question: value.question,
    ...(typeof value.header === 'string' && value.header !== '' ? { header: value.header } : {}),
    // Absent or the wrong type reads as single-select: the conservative half,
    // since a panel that offered one choice where several were wanted asks
    // again, and one that offered several where one was wanted cannot be undone.
    multiSelect: value.multiSelect === true,
    options
  }
}

/**
 * Narrow one `AskUserQuestion` tool input into an ask, or null when it is not
 * one this app can put in front of a user.
 *
 * The SDK types the input as `Record<string, unknown>` at the `canUseTool`
 * boundary and the shape is the model's own output, so it is validated here
 * exactly as a payload arriving over IPC is: a malformed ask becomes a refusal
 * the port can state, never a main-process throw inside a permission callback
 * the agent is blocked on.
 */
export function parseAskUserQuestion(
  toolUseId: string,
  input: Record<string, unknown>
): HeldAsk | null {
  if (!isRecord(input) || !Array.isArray(input.questions)) return null
  const questions = input.questions
    .map(parseQuestion)
    .filter((question): question is HeldAskQuestion => question !== undefined)
  if (questions.length === 0) return null
  return { toolUseId, questions }
}

/**
 * The ask as the renderer sees it: redacted, and singular.
 *
 * Redacted field by field rather than by spreading the parsed ask, so a field
 * added to HeldAskQuestion later cannot ride across unredacted by being
 * forgotten — the discipline claudeProvider's pendingQuestionField holds, and
 * for the same reason: labels go through it too, because a leak the user has to
 * press is no better than one they only read (#59).
 *
 * Only the FIRST question travels, because `DwarfQuestion` is singular (#94
 * phase 1 took that decision and this does not reopen it). The consequence is
 * stated rather than hidden: a call that asked two things has its second
 * question dropped from the panel, and `resolveAnswers` therefore accepts a
 * partial answers record. Nothing is invented for the questions nobody saw.
 *
 * `askedAt` is passed in rather than read from a clock here: the SDK attaches
 * no timestamp to the callback, so the honest value is when this host received
 * it, and the caller owns the clock.
 */
export function askToWireQuestion(ask: HeldAsk, askedAt: string): DwarfQuestion {
  const first = ask.questions[0]!
  const header = first.header === undefined ? undefined : redactSecrets(first.header)
  return {
    toolUseId: ask.toolUseId,
    question: redactSecrets(first.question),
    ...(header === undefined ? {} : { header }),
    multiSelect: first.multiSelect,
    options: first.options.map((option) => ({
      label: redactSecrets(option.label),
      ...(option.description === undefined
        ? {}
        : { description: redactSecrets(option.description) })
    })),
    askedAt
  }
}

/**
 * Turn the panel's answer into the record the tool takes, or refuse it.
 *
 * Two properties make this safe to hand to a live agent:
 *
 * 1. **Nothing in it is free text.** Every key must be a question the call
 *    actually asked and every value a label it actually offered, so an answer
 *    can only ever repeat the agent's own words back. The SDK's schema notes
 *    that a picker adds an "Other" choice of its own; this channel does not
 *    offer one, because a free-text answer is a payload the panel would be
 *    putting in the user's mouth.
 * 2. **The redacted spellings map back.** The panel was only ever shown the
 *    redacted question and labels (see above), and the agent's tool would not
 *    recognise those — so the match is made against the redacted forms and what
 *    is sent is the original. Where two questions redact to the same text the
 *    answer is refused instead of guessed.
 *
 * A single label per question, even where the ask was multi-select: how a
 * picker joins several is unmeasured, and inventing a separator is exactly the
 * kind of guess that would make the agent read an answer nobody gave.
 */
export function resolveAnswers(ask: HeldAsk, answers: unknown): AnswerResolution {
  if (!isRecord(answers)) return { ok: false, reason: NOTHING_ANSWERED }
  const given = Object.entries(answers)
  if (given.length === 0) return { ok: false, reason: NOTHING_ANSWERED }
  // A record longer than the ask cannot be an answer to it, whatever the keys
  // say. Checked before the keys so a flood is refused at its size.
  if (given.length > ask.questions.length) return { ok: false, reason: TOO_MANY_ANSWERS }

  const byRedactedQuestion = new Map<string, HeldAskQuestion | 'ambiguous'>()
  for (const question of ask.questions) {
    const key = redactSecrets(question.question)
    byRedactedQuestion.set(key, byRedactedQuestion.has(key) ? 'ambiguous' : question)
  }

  const resolved: AnswerRecord = {}
  for (const [questionText, label] of given) {
    const question = byRedactedQuestion.get(questionText)
    if (question === undefined) return { ok: false, reason: UNKNOWN_QUESTION }
    if (question === 'ambiguous') return { ok: false, reason: AMBIGUOUS_QUESTION }
    if (typeof label !== 'string') return { ok: false, reason: UNKNOWN_OPTION }
    const option = question.options.find((entry) => redactSecrets(entry.label) === label)
    if (option === undefined) return { ok: false, reason: UNKNOWN_OPTION }
    resolved[question.question] = option.label
  }
  return { ok: true, answers: resolved }
}

export type HeldQuestionLookup = (sessionId: string) => HeldQuestionState

/**
 * Copy `mines` with each held session's LIVE ask stamped onto its foreman,
 * superseding whatever the transcript tail derived.
 *
 * Superseding includes CLEARING. For a session this panel holds, `canUseTool`
 * sees every ask the moment it is made and every answer the moment it is given,
 * so the held state is the complete truth about that session's open asks — and
 * the tail's version is the post-hoc one that would otherwise resurrect a
 * question already answered. A session the panel does NOT hold is untouched:
 * there the tail is the only evidence there is.
 *
 * Only the foreman. A Claude worker dwarf carries its foreman's session id
 * (claudeProvider stamps `session.sessionId` on both), so keying on the id
 * alone would copy one ask onto every subagent in the session. A launched
 * session is a foreman by construction — a run with no parent is a root (#86) —
 * so the foreman is exactly the dwarf the panel holds. An ask raised inside a
 * subagent arrives on the same callback with an `agentID`, and it surfaces here
 * too, on the foreman: the panel holds the session, not the subagent, and the
 * two id spaces have never been matched up.
 */
export function stampHeldQuestions(mines: Mine[], stateOf: HeldQuestionLookup): Mine[] {
  return mines.map((mine) => ({
    ...mine,
    dwarfs: mine.dwarfs.map((dwarf) => {
      if (dwarf.role !== 'foreman') return dwarf
      const state = stateOf(dwarf.sessionId)
      if (!state.held) return dwarf
      if (state.question !== undefined) return { ...dwarf, pendingQuestion: state.question }
      if (dwarf.pendingQuestion === undefined) return dwarf
      // Removed rather than set to undefined: the field's absence is what the
      // wire contract means by "nothing is being asked", and a key carrying
      // undefined survives structured cloning as a present key.
      const cleared = { ...dwarf }
      delete cleared.pendingQuestion
      return cleared
    })
  }))
}
