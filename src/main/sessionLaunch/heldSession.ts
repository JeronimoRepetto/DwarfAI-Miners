import { permissionInputLine } from '../domain/permissionSummary'
import { redactSecrets } from '../domain/redactSecrets'
import {
  HELD_CONVERSATION_LIMIT,
  HELD_MESSAGE_MAX_CHARS,
  isMcpConnectionStatus,
  MAX_DWARF_TEXT_CHARS
} from '../domain/types'
import type {
  Dwarf,
  DwarfMcpServerStatus,
  DwarfPermissionRequest,
  DwarfQuestion,
  DwarfQuestionOption,
  FeedMessage,
  Mine,
  WaitingReason
} from '../domain/types'
import type { TextDeliveryTarget } from '../textDelivery/port'
import {
  heldCrewDwarfs,
  heldCrewTargets,
  heldRootRole,
  type HeldCrew,
  type HeldSessionSubagentSignal
} from './heldCrew'

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
 *
 * A second, smaller thing lives here since issue #96: the same held stream
 * carries model, MCP status and running cost on messages this app was already
 * reading for the ask loop above, and this module is where those get narrowed
 * onto the wire too — see HeldSessionTelemetryUpdate and stampHeldTelemetry.
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

/**
 * One tool call reaching `canUseTool` that is not `AskUserQuestion` — raw, as
 * the SDK hands it over (#203). `input` is the model's own tool input, and
 * `title`/`description` are the CLI's own rendering of the prompt when it
 * built one; nothing here is composed by this app.
 */
export interface HeldPermission {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  title?: string
  description?: string
}

/**
 * What the panel hands back for one permission prompt. Claude Code's own two
 * answers, and nothing else — see DwarfPermissionDecision for why "always
 * allow" is deliberately not one of them. `reason` is stated on every denial,
 * never left implicit, for the same reason an ask's denial always carries
 * one: the agent reads it in its own transcript.
 */
export type HeldPermissionAnswer = { decision: 'allow' } | { decision: 'deny'; reason: string }

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
  /**
   * Cut the running turn short, leaving the session open for the next one
   * (#210).
   *
   * A DIFFERENT act from `close`, and the difference is the whole reason this
   * exists: closing ends the session, interrupting ends the turn. The panel's
   * Kick means the second, so an implementation that can only do the first must
   * say which one it did rather than let the panel report the other.
   *
   * False when the interrupt did not happen. Async because the mechanism is a
   * control request to the agent, not a local flag: it is the one thing on this
   * handle that has to reach the child and be acknowledged.
   */
  interrupt(): Promise<boolean>
}

/**
 * One MCP server as a held session's own `init` message named it, before
 * validation against the closed status enum (issue #96) — the SDK types this
 * field's `status` as a plain `string`, so what arrives here is exactly that,
 * unvalidated. See `heldTelemetryToWire`, which is where it is checked.
 */
export interface HeldSessionMcpServer {
  name: string
  status: string
}

/**
 * The four token counts issue #96's spike actually exercised, off a `result`
 * message's `usage` field — not the full Anthropic Messages API `Usage` shape,
 * which also carries a cache-creation TTL breakdown, per-iteration entries,
 * fallback-credit and inference-geo detail no caller here needs. Narrower on
 * purpose: this is registry-only bookkeeping (see HeldSessionTelemetryUpdate),
 * never stamped to the wire, so there is nothing to keep it in step with.
 */
export interface HeldSessionUsage {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
}

/**
 * What a held session's own protocol messages reported about itself, as
 * sdkHeldSession.ts's message loop reads them off `init` and `result` (issue
 * #96) — never anything this app inferred or computed. Every field is
 * independently optional because `init` and `result` are two different
 * message types read at two different points of the same turn: an `init`
 * update carries `model`/`effort`/`mcpServers`/`claudeCodeVersion` and a
 * `result` update carries `totalCostUsd`/`usage`, and a field one update
 * omits leaves whatever the registry already recorded alone — the same
 * "arrives late, kept until then" reasoning `recordSessionId` already
 * follows for the session id itself.
 *
 * `totalCostUsd` and `usage` are the RUNNING TOTAL as of the latest message,
 * not a per-turn delta: the SDK's own doc comment on `total_cost_usd` says so
 * ("each result carries the running total so far, so read the latest result
 * rather than summing across results"), confirmed live by issue #96's spike.
 * So a later update REPLACES these two fields rather than adding to them —
 * which is also just what a plain merge already does, and is exactly why the
 * registry may not fold turns together by summing.
 */
export interface HeldSessionTelemetryUpdate {
  model?: string
  effort?: string
  mcpServers?: HeldSessionMcpServer[]
  claudeCodeVersion?: string
  totalCostUsd?: number
  usage?: HeldSessionUsage
  /**
   * Which edge of a turn this update reports, when it reports one at all
   * (issue #245). `init` and `result` sit at OPPOSITE ends of the same turn —
   * `init` is re-emitted at its start ("the newest frame wins"), `result`
   * once at its end — but every field above is a plain merge, which is
   * exactly why none of them can serve as the edge itself: `totalCostUsd`
   * keeps its last reported value across turns, so its mere presence proves
   * nothing about whether the CURRENT turn has finished. This field is
   * carried for that one question and nothing else, and the registry reads
   * only its latest value, never sums or histories it — the same
   * running-total reasoning above, applied to a boundary instead of a count.
   */
  turn?: 'started' | 'ended'
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
   * The CLI's own `init`/`result` fields, forwarded live as the message loop
   * reads them (issue #96) — called once per message that carries any of
   * them, never batched or delayed.
   */
  onTelemetry: (update: HeldSessionTelemetryUpdate) => void
  /**
   * An `AskUserQuestion` reached the permission callback. The agent's tool call
   * stays BLOCKED until this resolves, which is the whole mechanism: there is
   * no deadline on it, because a human is on the other end.
   */
  onAsk: (toolUseId: string, input: Record<string, unknown>) => Promise<HeldAnswer>
  /**
   * Any other tool call reaching the permission callback (#203) — the CLI's
   * own approval prompt, parked exactly as an ask is. The agent's tool call
   * stays BLOCKED until this resolves, and there is no deadline on it either:
   * a human decides.
   */
  onPermission: (prompt: HeldPermission) => Promise<HeldPermissionAnswer>
  /**
   * Something in the stream bore on this session's own crew (#157) — a task
   * starting, a task ending, or a tool call made from inside one. Forwarded
   * RAW: the seam translates and decides nothing, so every rule about what
   * counts as a subagent lives where a test can reach it (see heldCrew.ts).
   */
  onSubagent: (signal: HeldSessionSubagentSignal) => void
  /**
   * One message the stream carried, as the loop reads it (#159) — the agent's
   * own words, or a user turn the stream echoed back. Text only, already
   * flattened out of whatever block shape the SDK wrapped it in, and never a
   * tool call or a tool result.
   *
   * No timestamp: the SDK attaches none to these, so the honest one is when
   * this host saw it, and the caller owns the clock — the same split
   * `askToWireQuestion`'s `askedAt` already draws.
   */
  onMessage: (role: FeedMessage['role'], text: string) => void
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

/**
 * The words in one message off a held session's stream, or `''` when it
 * carries none (#159).
 *
 * The SDK wraps a message's `content` as either a plain string or the
 * Anthropic block array, and only `text` blocks are words. A `tool_use` is the
 * agent reaching for a tool and a `tool_result` is what came back — neither is
 * something a person said or an agent wrote, so neither belongs in a
 * conversation the panel draws, and an empty answer is what keeps them out.
 *
 * `unknown` in, deliberately: this is fed straight from the SDK's own message
 * types, which are wider than the two shapes here and change with the
 * dependency. Narrowing it here means the loop above can stay a shape check
 * with no parsing in it, and this can be unit-tested without importing the SDK
 * at all — the seam the whole module keeps.
 */
export function heldMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(
      (block): block is { type: 'text'; text: string } =>
        isRecord(block) && block.type === 'text' && typeof block.text === 'string'
    )
    .map((block) => block.text)
    .join('\n')
}

/**
 * Append one message to the exchange this host has watched go by, bounded at
 * both ends (#159). Pure, so the retention rule is unit-tested rather than
 * eyeballed inside the registry.
 *
 * Redaction happens on the way IN rather than on the way out to the wire. The
 * kept list IS what the wire carries, so redacting later would mean a secret
 * living in this process's memory for the whole session against one future
 * caller remembering to strip it — the ordering `redactSecrets`'s own module
 * comment argues for, applied to a store rather than to a single string.
 *
 * A message with nothing in it once trimmed is not retained at all: an empty
 * bubble in the panel would be this app claiming somebody spoke.
 */
export function retainHeldMessage(
  kept: readonly FeedMessage[],
  message: FeedMessage
): FeedMessage[] {
  const text = redactSecrets(message.text.trim()).slice(0, HELD_MESSAGE_MAX_CHARS)
  if (text === '') return [...kept]
  return [...kept, { ...message, text }].slice(-HELD_CONVERSATION_LIMIT)
}

/**
 * What the panel is told about a session's open ask and open permission
 * prompt, once both have been redacted. The two travel together because a
 * held session can have either open, neither, or both at once (#203) — an
 * assistant message can carry several tool calls, and an ask is not any more
 * exclusive with a permission prompt than it is with another ask.
 */
export type HeldQuestionState =
  /** Not a session this panel holds: whatever the provider derived stands. */
  | { held: false }
  /** Held, and this is the whole truth about its open asks — including none. */
  | { held: true; question?: DwarfQuestion; permission?: DwarfPermissionRequest }

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
 * The permission prompt as the renderer sees it: summarised, capped,
 * redacted (#203).
 *
 * A SIBLING of askToWireQuestion, not a shared helper with it — the two
 * narrow different things. That one repeats the agent's own words; this one
 * redacts the CLI's own rendering of the prompt (`title`, `description`)
 * field by field, for the same reason askToWireQuestion never spreads the
 * parsed ask: a field added to HeldPermission later must not ride across
 * unredacted by being forgotten. The input line itself is
 * `domain/permissionSummary`'s, shared with the observed-session prompt so
 * one Bash call cannot read two ways depending on who is watching it (#203).
 *
 * `askedAt` is passed in rather than read from a clock here, for the same
 * reason it is for an ask: the SDK attaches no timestamp to the callback, so
 * the honest value is when this host received it.
 */
export function permissionToWire(prompt: HeldPermission, askedAt: string): DwarfPermissionRequest {
  const title = prompt.title === undefined ? undefined : redactSecrets(prompt.title)
  const description =
    prompt.description === undefined ? undefined : redactSecrets(prompt.description)
  return {
    toolUseId: prompt.toolUseId,
    toolName: prompt.toolName,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    input: permissionInputLine(prompt.input),
    // The panel HOLDS this session, so the decision goes back through the
    // stream rather than at a keyboard: see DwarfPermissionRequest.channel.
    channel: 'held',
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
      let stamped = dwarf
      if (state.question !== undefined) {
        stamped = { ...stamped, pendingQuestion: state.question }
      } else if (stamped.pendingQuestion !== undefined) {
        // Removed rather than set to undefined: the field's absence is what
        // the wire contract means by "nothing is being asked", and a key
        // carrying undefined survives structured cloning as a present key.
        stamped = { ...stamped }
        delete stamped.pendingQuestion
      }
      if (state.permission !== undefined) {
        stamped = { ...stamped, pendingPermission: state.permission }
      } else if (stamped.pendingPermission !== undefined) {
        // Same idiom, same reason: an open ask and an open permission prompt
        // clear independently, because either can be open without the other.
        stamped = { ...stamped }
        delete stamped.pendingPermission
      }
      return stamped
    })
  }))
}

/**
 * Turn what the registry accumulated off a held session's own `init`/`result`
 * messages into exactly the shape `Dwarf` admits (issue #96) — the same kind
 * of narrowing `askToWireQuestion` does for an ask, and for the same reason:
 * the SDK's own message types are wider than what this app puts on the wire.
 *
 * `usage` never appears in the result: it stays registry-only bookkeeping for
 * this slice (see HeldSessionTelemetryUpdate), and the minimal wire vocabulary
 * issue #96 draws has no field for it yet. An MCP entry whose status this
 * build's closed enum does not recognise is dropped rather than passed on —
 * the CLI's own `init` message types `status` as a plain string, so this is
 * the boundary-validation `isMineTier`/`isDwarfProvider` already hold, applied
 * to a field arriving from the same untrusted-shape direction.
 */
export function heldTelemetryToWire(telemetry: HeldSessionTelemetryUpdate): {
  model?: string
  effort?: string
  mcpServers?: DwarfMcpServerStatus[]
  totalCostUsd?: number
} {
  const mcpServers = telemetry.mcpServers?.filter((server): server is DwarfMcpServerStatus =>
    isMcpConnectionStatus(server.status)
  )
  return {
    ...(telemetry.model === undefined ? {} : { model: telemetry.model }),
    ...(telemetry.effort === undefined ? {} : { effort: telemetry.effort }),
    ...(mcpServers === undefined ? {} : { mcpServers }),
    ...(telemetry.totalCostUsd === undefined ? {} : { totalCostUsd: telemetry.totalCostUsd })
  }
}

/**
 * What the panel is told about a held session's own self-reported telemetry
 * (issue #96) — the same `{held}`-discriminated shape HeldQuestionState uses,
 * for the same reason: `held: false` leaves whatever a session's own provider
 * derived untouched, and `held: true` is this panel's own complete word on it.
 *
 * Unlike a question, there is no "held true, but clear it" case here: a held
 * session's self-reports only ever accumulate (a later `model` supersedes an
 * earlier one; nothing un-reports a model once the CLI has named one), so
 * `held: true` with every field absent is simply "nothing has arrived yet",
 * not a fact to stamp over what a session's own provider already read.
 */
export type HeldTelemetryState =
  { held: false } | ({ held: true } & ReturnType<typeof heldTelemetryToWire>)

export type HeldTelemetryLookup = (sessionId: string) => HeldTelemetryState

/**
 * What the panel knows about a held session's own crew (#157) — the same
 * `{held}`-discriminated shape the two states above use, and for the same
 * reason: `held: false` is a session this panel does not hold, where whatever
 * its provider derived from disk stands untouched.
 */
export type HeldCrewState = { held: false } | { held: true; crew: HeldCrew }

export type HeldCrewLookup = (sessionId: string) => HeldCrewState

/**
 * Is this the dwarf that IS a session, or one of its subagents?
 *
 * Every provider that reports subagents names them after the session's own
 * dwarf — `<session dwarf id>:<agent id>` in claudeProvider, and the held crew
 * follows it — so a dwarf whose id extends another's is a subagent of it. This
 * is the test that keeps one session's crew from being hung off every subagent
 * that shares its session id, the trap stampHeldQuestions names.
 */
function isSubagentDwarf(dwarf: Dwarf, crewOfMine: readonly Dwarf[]): boolean {
  return crewOfMine.some((other) => other.id !== dwarf.id && dwarf.id.startsWith(`${other.id}:`))
}

/**
 * Copy `mines` with each held session's own subagents ADDED beside it, and the
 * routes they can be written through (#157).
 *
 * This is the join the issue turned out to need. A held session is discovered
 * on disk by the ordinary poll exactly like any other, so its own dwarf is
 * already here — but its subagents are not, and cannot be: they run in the
 * foreground, which writes no `async_launched` record for the transcript parse
 * to find (see heldCrew.ts for the measurement). The stream is where they are,
 * and this is where the two meet.
 *
 * Added rather than substituted. A held session can ALSO have background agents
 * that the transcript path did see, and those are its provider's finding — this
 * only contributes what the provider had no way to know.
 *
 * Called before the lifecycle runs, deliberately, so a crew member that has
 * finished gets the same leaving grace every other dwarf gets and walks out to
 * a spawn point instead of blinking off the board.
 */
export function stampHeldCrew(
  mines: Mine[],
  stateOf: HeldCrewLookup
): { mines: Mine[]; targets: Map<string, TextDeliveryTarget> } {
  const targets = new Map<string, TextDeliveryTarget>()
  const stamped = mines.map((mine) => {
    const added: Dwarf[] = []
    for (const dwarf of mine.dwarfs) {
      if (isSubagentDwarf(dwarf, mine.dwarfs)) continue
      const state = stateOf(dwarf.sessionId)
      if (!state.held) continue
      added.push(...heldCrewDwarfs(dwarf, state.crew))
      for (const [id, target] of heldCrewTargets(dwarf, state.crew)) targets.set(id, target)
    }
    return added.length === 0 ? mine : { ...mine, dwarfs: [...mine.dwarfs, ...added] }
  })
  return { mines: stamped, targets }
}

/**
 * Copy `mines` with each held session's own dwarf ranked by what it has
 * actually done (#157).
 *
 * Role is topology, and for a session this panel holds the stream is the
 * topology: a launched agent digs alone until it coordinates something, and is
 * the foreman from the moment it has a crew out. See heldRootRole for why the
 * promotion latches rather than reversing when the crew finishes.
 *
 * Only the session's own dwarf, never a subagent sharing its id — which here is
 * `role === 'foreman'`, because this runs LAST in the pipeline, after every
 * other stamp, and the provider ranks a session's own dwarf a foreman and its
 * subagents workers. Running it last is what lets the two stamps above keep
 * reading that same rank to find the same dwarf.
 */
export function stampHeldRank(mines: Mine[], stateOf: HeldCrewLookup): Mine[] {
  return mines.map((mine) => ({
    ...mine,
    dwarfs: mine.dwarfs.map((dwarf) => {
      if (dwarf.role !== 'foreman') return dwarf
      const state = stateOf(dwarf.sessionId)
      if (!state.held) return dwarf
      return { ...dwarf, role: heldRootRole(state.crew) }
    })
  }))
}

/**
 * Copy `mines` with each held session's own self-reported telemetry stamped
 * onto its foreman (issue #96) — the same shape `stampHeldQuestions` follows,
 * for the same reasons: only a session this panel HOLDS has any of this to
 * report, and only the foreman, never a worker sharing its session id (a
 * Claude worker carries its foreman's `sessionId`, so keying on the id alone
 * would copy one session's telemetry onto every subagent in it).
 *
 * Each field is stamped independently, superseding whatever a tail-derived
 * read already put there (an observed Claude session's `model` comes from its
 * transcript tail too) — but only when the held state actually carries a
 * value: an absent field here is "not reported yet", never "unset", so it
 * leaves the dwarf's existing value alone rather than clearing it.
 */
export function stampHeldTelemetry(mines: Mine[], stateOf: HeldTelemetryLookup): Mine[] {
  return mines.map((mine) => ({
    ...mine,
    dwarfs: mine.dwarfs.map((dwarf) => {
      if (dwarf.role !== 'foreman') return dwarf
      const state = stateOf(dwarf.sessionId)
      if (!state.held) return dwarf
      return {
        ...dwarf,
        ...(state.model === undefined ? {} : { model: state.model }),
        ...(state.effort === undefined ? {} : { effort: state.effort }),
        ...(state.mcpServers === undefined ? {} : { mcpServers: state.mcpServers }),
        ...(state.totalCostUsd === undefined ? {} : { totalCostUsd: state.totalCostUsd })
      }
    })
  }))
}

/**
 * What the panel is told about the exchange a held session's stream carried
 * (#159) — the same `{held}`-discriminated shape the two lookups above use.
 *
 * `held: false` is the only reading for a session this panel does not hold,
 * and it leaves the dwarf without a conversation at all rather than with an
 * empty one: the words of an observed session are read from its transcript, on
 * its own channel, and are a different claim (see DwarfFeedResult).
 */
export type HeldConversationState = { held: false } | { held: true; conversation: FeedMessage[] }

export type HeldConversationLookup = (sessionId: string) => HeldConversationState

/**
 * Copy `mines` with each held session's own exchange stamped onto its foreman
 * (#159) — the same shape and the same two rules `stampHeldTelemetry` follows.
 *
 * Only the foreman, because a Claude worker carries its foreman's `sessionId`
 * and keying on the id alone would copy one session's conversation onto every
 * subagent in it. And an empty exchange stamps NOTHING: absence is what the
 * wire means by "no conversation to show", so a held session that has yet to
 * say a word leaves the field off rather than handing the panel an empty list
 * to render as a conversation with nothing in it.
 */
export function stampHeldConversation(mines: Mine[], stateOf: HeldConversationLookup): Mine[] {
  return mines.map((mine) => ({
    ...mine,
    dwarfs: mine.dwarfs.map((dwarf) => {
      if (dwarf.role !== 'foreman') return dwarf
      const state = stateOf(dwarf.sessionId)
      if (!state.held || state.conversation.length === 0) return dwarf
      return { ...dwarf, conversation: state.conversation }
    })
  }))
}

/**
 * What the panel is told about a held session's own status, live (issue
 * #245) — the same `{held}`-discriminated shape the states above use, and for
 * the same reason: only a session this panel HOLDS has any of this to report.
 *
 * `held: false` leaves the provider's own reading alone. That reading is
 * wrong for every held session without this: an SDK-hosted registry entry
 * never carries a `status` at all (the REPL writes that, and a held session
 * has no REPL — see `HeldSessionRegistry.holds`), so a provider that finds no
 * status reads the session as idle. `held: true` is this panel's own complete
 * word on it, and it is never a partial one — unlike telemetry, which only
 * ever accumulates, a session's activity changes shape entirely from one poll
 * to the next, so there is no "nothing to stamp" case here.
 *
 * `status` is narrower than `DwarfStatus`: this only ever speaks to `working`
 * or `waiting`, and never to `leaving` — that is the lifecycle's own verdict,
 * decided earlier in the pipeline than this stamp runs, and it stands exactly
 * as it was for a session that has actually ended (which this then reports
 * `held: false` for, since the registry no longer holds it).
 */
export type HeldActivityState =
  { held: false } | { held: true; status: 'working' | 'waiting'; waitingReason?: WaitingReason }

export type HeldActivityLookup = (sessionId: string) => HeldActivityState

/**
 * Copy `mines` with each held session's own status stamped onto its foreman,
 * superseding whatever the provider's idle reading put there — the same
 * supersession stampHeldQuestions already draws, and for the same reason: a
 * held session's stream is the complete truth about what it is doing, and the
 * provider's is the post-hoc guess that would otherwise leave every held
 * dwarf reading `waiting` with nothing to say why.
 *
 * `waitingReason` is removed rather than set to undefined when the state
 * carries none — the same idiom `stampHeldQuestions` uses, and for the same
 * wire reason: the field's absence is what the contract means by "not
 * blocked on anything named", and a key carrying `undefined` survives
 * structured cloning as a present key.
 *
 * Only the foreman, never a worker sharing its session id — the same trap
 * `stampHeldQuestions` names, for the same reason: a Claude worker carries
 * its foreman's `sessionId`, so keying on the id alone would stamp one
 * session's status onto every subagent in it.
 */
export function stampHeldStatus(mines: Mine[], stateOf: HeldActivityLookup): Mine[] {
  return mines.map((mine) => ({
    ...mine,
    dwarfs: mine.dwarfs.map((dwarf) => {
      if (dwarf.role !== 'foreman') return dwarf
      const state = stateOf(dwarf.sessionId)
      if (!state.held) return dwarf
      let stamped: Dwarf = { ...dwarf, status: state.status }
      if (state.waitingReason !== undefined) {
        stamped = { ...stamped, waitingReason: state.waitingReason }
      } else if (stamped.waitingReason !== undefined) {
        stamped = { ...stamped }
        delete stamped.waitingReason
      }
      return stamped
    })
  }))
}
