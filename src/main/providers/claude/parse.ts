import { toolActivityLine } from '../../domain/permissionSummary'
import { trimFeed } from '../feedWindow'
import {
  type DwarfAttendance,
  type FeedMessage,
  type SessionStatus,
  WAITING_ON_HUMAN_REASON,
  type WaitingReason
} from '../../domain/types'
import type { TextDeliveryTarget } from '../../textDelivery/port'

/**
 * Pure parsers for Claude Code on-disk session data. They take strings/objects
 * and return plain data — no filesystem or process access (see docs/provider-formats.md).
 */

/** One live session from ~/.claude/sessions/<pid>.json. */
export interface ClaudeSessionEntry {
  pid: number
  sessionId: string
  cwd: string
  status: SessionStatus
  /**
   * Whether the entry carried a `status` field at all — a different fact from
   * the folded value above, which reads its absence as `idle` (#191).
   *
   * Claude Code's REPL is what writes that field, so its presence is the
   * registry saying a REPL is running: an SDK-hosted session registers as
   * `kind: interactive` like a TUI and never writes a status, because it has no
   * REPL (observed live against 2.1.260, see ClaudeProviderOptions.isHeldSession).
   * A session with no REPL has no console for a human to type into however its
   * `kind` reads, which is why `kind` alone cannot answer whether a resting
   * session is still reachable (#255).
   */
  statusReported: boolean
  /**
   * What the session is blocked on while status is 'waiting' (e.g. "dialog
   * open"), copied verbatim from the registry. Structured evidence only —
   * never derived from assistant text (issue #34). Claude Code's own
   * vocabulary, kept unnormalized here; claudeWaitingReason below turns it
   * into the value that crosses the wire.
   */
  waitingFor?: string
  /**
   * Windows FILETIME process start value. The pid-reuse guard compares it
   * against the pid's real creation time (see ClaudeProvider.procStartVerdict)
   * so a registry file that outlived its process cannot make the recycled
   * pid's window a focus/Send/Kick target.
   */
  procStart?: string
  /**
   * How the session was started: 'interactive' for a TUI the user is looking
   * at, 'bg' for a headless background job. This is what decides whether a
   * typed message can be injected into a console or has to be relayed.
   */
  kind?: string
  name?: string
  startedAt?: number
  updatedAt?: number
  /**
   * When the registry's `status` was last written — the stamp on the very
   * write `statusReported` above reads the existence of (#313).
   *
   * A session that has never been prompted has no transcript, so nothing else
   * on disk can date its console. This is the closest fact there is: the REPL
   * wrote it, and the REPL is the console. Not `updatedAt`, which the entry
   * also moves for changes that say nothing about a prompt being open, and not
   * a guarantee — an older build may report a status and no stamp for it, so
   * the caller falls back to `startedAt` (ClaudeProvider.sitsAtAnOpenPrompt).
   */
  statusUpdatedAt?: number
}

/** A subagent launched with the Agent tool that has not completed yet. */
export interface ClaudeInFlightAgent {
  agentId: string
  description?: string
  resolvedModel?: string
}

/**
 * One answer an AskUserQuestion offers.
 *
 * The tool's own option carries a third field, `preview`, and it is dropped at
 * parse time on purpose: it can hold a whole code block, nothing downstream
 * needs it, and carrying arbitrary source across the wire to render 70 chars is
 * a cost with no buyer.
 */
export interface ClaudeQuestionOption {
  label: string
  description?: string
}

/**
 * A question the model asked the user through the AskUserQuestion tool and that
 * nothing in this tail has answered (issue #94).
 *
 * This is a `tool_use` block, not prose: the model declaring in schema that it
 * is asking, and enumerating the answers it will accept. That is why reading it
 * does not touch the prohibition on inferring a blocked state from assistant
 * text (see WaitingReason in contracts.ts) — nothing here is pattern-matched
 * out of a sentence, and a question asked as plain prose stays uncaught, which
 * is the correct outcome rather than a gap. It is on that footing, and no
 * broader one, that claudeWaitingReason lets an open ask name the condition a
 * blocked session left unnamed.
 *
 * `toolUseId` is what makes "answered" exact instead of inferred: the reply
 * arrives later as a `tool_result` naming the same id.
 */
export interface ClaudePendingQuestion {
  toolUseId: string
  question: string
  header?: string
  multiSelect: boolean
  options: ClaudeQuestionOption[]
  /** The asking line's own timestamp, when it carried one. */
  askedAt?: string
}

/**
 * A tool call the assistant wrote and that nothing in this tail has answered
 * (#203).
 *
 * The transcript half of an observed session's permission prompt. Claude
 * Code's `permission_prompt` hook says a dialog is OPEN for a session and
 * never what it asks; this says what the session asked to do and never
 * whether anybody was asked to approve it. Only the two together name a
 * request, and they only ever meet in the provider.
 *
 * Readable while the dialog stands, which is the one property that makes this
 * worth reading at all: the `tool_use` block is written BEFORE the CLI opens
 * its dialog, unlike an `AskUserQuestion`, whose block reaches the file only
 * when the picker resolves (docs/console-hosting.md §4, measured). That is
 * why `AskUserQuestion` is deliberately excluded here as well as carried by
 * `pendingQuestion`: it raises no permission dialog, and a card offering
 * Allow / Deny for a question the model wrote its own answers to would be the
 * invented-options failure DwarfQuestion exists to prevent.
 *
 * `input` is the tool's own input object, RAW. Summarising and redacting it
 * belongs at the provider boundary with every other string that crosses the
 * wire, not here — see domain/permissionSummary.
 */
export interface ClaudeToolUse {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  /** The calling line's own timestamp, when it carried one. */
  askedAt?: string
}

/**
 * One `SendMessage` result in which Claude Code states that it RESTARTED a
 * background agent that had already stopped (issue #338).
 *
 * The record #179 said did not exist. A resume writes no second
 * `async_launched` line, so that issue had to infer one from the agent's own
 * transcript growing again — and inference cannot reach an agent whose ending
 * said `completed`, which is what the reported session's had. This is the
 * first-hand evidence instead: the harness answering the orchestrator's own
 * tool call with the id it resumed, in the same machine-readable position an
 * `async_launched` result occupies. The provider treats it as the launch
 * record it is.
 */
export interface ClaudeAgentResume {
  agentId: string
  /** The resuming line's own timestamp, when it carried one. */
  timestamp?: string
  /**
   * The payload's own one-line summary of the message that resumed the agent,
   * when it named one. A description of last resort, and never invented: the
   * launch record's own description is preferred wherever one is remembered.
   */
  summary?: string
  /**
   * Whether a `<task-notification>` for the same id follows this record in the
   * tail — the agent stopping AGAIN after the resume.
   *
   * The one discriminator there is. A second ending is byte-identical to the
   * first (docs/provider-formats.md §1.4), so nothing in the blob can say which
   * one it is; position can, and it is sound here for the reason a suffix read
   * is sound everywhere else in this file — a resume is written after the
   * ending it answers, so a tail that still shows that ending still shows the
   * resume too. Order within one window is therefore the whole question, and
   * this field is its answer.
   */
  endedSince: boolean
}

/** Everything the provider needs from the tail of a session transcript. */
export interface ClaudeTranscriptInfo {
  model?: string
  effort?: string
  lastAssistantText?: string
  inFlightAgents: ClaudeInFlightAgent[]
  /**
   * Every agent id seen reaching a terminal status in this tail, whether or not
   * its launch record is still in the window. The provider remembers these
   * across polls so a finished agent can never come back (see claudeProvider).
   */
  terminalAgentIds: string[]
  /**
   * The launch-time identity of every agent in this tail whose LATEST ending
   * said `failed` and whose `async_launched` record shares the window (issue
   * #179).
   *
   * Not a claim that any of them is running: they are terminal above and stay
   * terminal, and this list is what it would TAKE to draw one again. Every
   * notification carries Claude Code's own note that "the user can send it
   * another message and resume it, so the same task-id may notify more than
   * once", and a resume writes no second launch record — so an ending is
   * "stopped for now", and the only evidence separating a resumed agent from a
   * dead one is whether its own transcript is still being appended to. That is
   * a file, so the verdict belongs to the provider; this only hands it the
   * candidates.
   *
   * `completed` and `killed` are excluded on purpose. `killed` is the status
   * whose omission was the original ghost dwarf, and a `completed` agent's own
   * last write can legitimately land after its notification — neither has been
   * observed resuming, so neither buys the relaxation.
   */
  failedAgents: ClaudeInFlightAgent[]
  /**
   * The launch-time identity of every agent that BOTH ended in this tail and
   * had its `async_launched` record inside it (issue #338) — `failedAgents`
   * above is the subset of these whose latest ending said `failed`.
   *
   * Two lists rather than one with a status, because they answer to two rules
   * that must not be able to widen each other by accident. #179 reopens a
   * `failed` ending on inference, and its door stays exactly that narrow;
   * this one is what it TAKES to redraw any ended agent once a record proves
   * the harness restarted it, whatever the ending said. Neither is a claim
   * that anybody is running: both are terminal above and stay terminal.
   */
  endedLaunches: ClaudeInFlightAgent[]
  /**
   * The latest resume record this tail carries for each agent it names (issue
   * #338), in the order the agents were first resumed in the window.
   *
   * Only the latest per agent: an agent resumed, ended and resumed again is
   * described by its last record, exactly as `finished` keeps only the last
   * ending. The endings between them are what `endedSince` reports.
   */
  resumedAgents: ClaudeAgentResume[]
  pendingBackgroundAgentCount?: number
  /**
   * The latest usage block seen in this tail (input+output+cache tokens for
   * that one turn), used by the provider as a floor for its runtime-lifetime
   * counter — see ClaudeProvider. Not a sum across turns: Claude resends the
   * whole conversation each turn, so summing input_tokens across turns would
   * wildly over-count. "Latest observed" is the honest cheap approximation.
   */
  tokensObserved?: number
  /**
   * The latest AskUserQuestion in this tail that no `tool_result` resolved
   * (issue #94), or undefined when there is none.
   *
   * The truncation asymmetry is what makes this safe to publish. A tail is a
   * suffix of the file (readTextTail) and the result line is always written
   * after the ask, so "the ask is visible but its answer scrolled out" cannot
   * happen. A window that is too small can only HIDE a pending question — the
   * dwarf goes dark — never invent one. Misses are possible here; false claims
   * are not, which is the direction this codebase takes every time.
   */
  pendingQuestion?: ClaudePendingQuestion
  /**
   * Every tool call in this tail that no `tool_result` resolved, in ask order
   * — so the latest open one is last (#203). Empty rather than absent: "this
   * tail holds no open call" is a reading the parser always has, unlike
   * `pendingQuestion`, whose absence also covers an ask older than the window.
   *
   * A LIST rather than the latest one alone, because the count is what tells
   * a card it may name the request at all. One open call and a dialog on
   * screen is that call; several — the shape a parallel batch takes, since
   * Claude Code writes every result of a batch in one message and therefore
   * writes none of them while one of the batch is waiting on a person — could
   * be any of them, and a card naming the wrong sibling is how somebody
   * approves a command they did not read. The provider is where that count is
   * weighed.
   *
   * The same truncation asymmetry that makes `pendingQuestion` safe makes this
   * safe: a tail is a suffix and a result is always written after its call, so
   * "the call is visible but its result scrolled out" cannot happen. A window
   * too small can only hide an open call, never invent one.
   */
  unresolvedToolUses: ClaudeToolUse[]
}

type Rec = Record<string, unknown>

function isRecord(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * Encode a project cwd the way Claude Code names its projects/ directory:
 * every non-alphanumeric character becomes a dash. The encoding is lossy —
 * never decode it; real paths come from the `cwd` field inside transcripts.
 */
export function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

/** Parse one ~/.claude/sessions/<pid>.json registry entry; null when malformed. */
export function parseClaudeSessionEntry(json: unknown): ClaudeSessionEntry | null {
  if (!isRecord(json)) return null
  const pid = asNumber(json.pid)
  const sessionId = asString(json.sessionId)
  const cwd = asString(json.cwd)
  if (pid === undefined || sessionId === undefined || cwd === undefined) return null
  return {
    pid,
    sessionId,
    cwd,
    // The registry reports busy, idle or waiting — waiting means "alive but
    // blocked" (on user input, a dialog, a long tool), with waitingFor naming
    // the condition. That structured lifecycle signal is preserved (issue #34);
    // only unknown values normalize to idle, the conservative reading. The
    // main session dwarf is a foreman either way — status changes, rank does not.
    status: json.status === 'busy' ? 'busy' : json.status === 'waiting' ? 'waiting' : 'idle',
    // Read off the raw entry, because the fold above cannot be un-folded: an
    // absent status and an unrecognized one both arrive as 'idle' downstream,
    // and only one of them means "nothing was ever here to write it".
    statusReported: asString(json.status) !== undefined,
    waitingFor: asString(json.waitingFor),
    procStart: asString(json.procStart),
    kind: asString(json.kind),
    name: asString(json.name),
    startedAt: asNumber(json.startedAt),
    updatedAt: asNumber(json.updatedAt),
    statusUpdatedAt: asNumber(json.statusUpdatedAt)
  }
}

/**
 * Claude Code's own `waitingFor` vocabulary, normalized (issue #60).
 *
 * The registry does not invent this string per session: Claude Code derives it
 * from a fixed set of conditions, and the whole closed set was read out of the
 * shipped binary (v2.1.251) rather than guessed from what a parser hoped for —
 * an elicitation prompt yields `input needed`; the open dialog's own table
 * yields `input needed`, `sandbox request`, `goal proposal` or `dialog open`,
 * falling back to `permission prompt` for a dialog kind that table does not
 * name; a pending worker request yields `worker request`; a pending sandbox
 * request yields `sandbox request`; and a slash-command view showing over an
 * idle turn yields `dialog open`.
 *
 * Only `input needed` is mapped to 'user-input', because it is the only one of
 * the seven that names a question a human has to answer before the session can
 * move. That narrowness is the point: 'user-input' is the value that suspends
 * eviction, so it may only ever be set on proof.
 *
 * `dialog open` is deliberately NOT 'user-input', though it is by far the
 * commonest value. It says a modal is up, never what the modal wants: the same
 * string covers a startup model switch, a managed-settings review and an
 * offline-file-sync notice. That the session is blocked is already carried by
 * `status: 'waiting'` (issue #34); this table exists to say what it is blocked
 * on, and here the honest answer is that nothing proved it.
 *
 * The vocabulary is version-specific and has grown before, so anything absent
 * from this table lands on 'unknown' rather than being pattern-matched.
 */
const CLAUDE_WAITING_REASONS: Readonly<Record<string, WaitingReason>> = {
  'input needed': 'user-input',
  'permission prompt': 'approval',
  'sandbox request': 'approval',
  'goal proposal': 'approval',
  'worker request': 'unknown',
  'dialog open': 'unknown'
}

/**
 * What this session is blocked on, or undefined when it is not blocked.
 *
 * The registry's `waitingFor` decides, and it is the only thing that can make
 * this a value at all — never the transcript, never assistant text. A session
 * that is blocked with no condition recorded, or with one this version does not
 * know, is 'unknown': proof that it is waiting, no proof of what for.
 *
 * The condition, not the status, is what decides. `parseClaudeSessionEntry`
 * folds every status it does not recognize into `idle`, so a future spelling of
 * "blocked" would erase a live session's only proof of life; a recorded
 * condition survives that fold and is therefore the sounder thing to key on.
 *
 * `pendingQuestion` is the tail's unanswered AskUserQuestion, and it may only
 * REFINE (issue #94). The registry proves blocked; the tool block names what
 * the registry could not; neither source claims the other's fact. So exactly
 * one reading moves — 'unknown', which is "blocked, and the condition is not
 * one this table recognizes", the hole an ask fills exactly. A named condition
 * is the registry's own answer and is left alone even here, and `undefined`
 * stays absent: moving that would be the tool block ASSERTING a blocked state
 * from the transcript, which is the thing WaitingReason forbids. An ask in the
 * tail of a busy session is the model still working, not a human being waited
 * on.
 *
 * Omitting the argument is the same statement as an answered ask: no question
 * is outstanding as far as this caller can see. That is safe in the one
 * direction that matters, because the tail is a suffix of the file and a result
 * is always written after its ask — so a window too small to hold the ask can
 * only cost the refinement (the reason stays 'unknown', today's behaviour),
 * never invent one. This can under-claim; it cannot over-claim.
 */
export function claudeWaitingReason(
  session: {
    status: SessionStatus
    waitingFor?: string
  },
  pendingQuestion?: ClaudePendingQuestion
): WaitingReason | undefined {
  const proven =
    session.waitingFor !== undefined
      ? (CLAUDE_WAITING_REASONS[session.waitingFor] ?? 'unknown')
      : session.status === 'waiting'
        ? 'unknown'
        : undefined
  if (proven !== 'unknown' || pendingQuestion === undefined) return proven
  return WAITING_ON_HUMAN_REASON
}

/**
 * Which channel a Claude session can receive typed text through.
 *
 * A headless job ('bg') has no console to type into, but Claude Code keeps
 * every session on this machine addressable by the name in its registry entry,
 * so a relay turn can hand it the message. Anything else — including an older
 * entry that records no kind at all — is assumed to own a console: those
 * predate background sessions, so a console is the safe reading.
 *
 * Interactive sessions get names too, and that name is the exact same relay
 * address a bg session uses. It rides along on the terminal target so the
 * runtime can fall back to the relay when the console cannot be focused or
 * typed into, instead of losing the message entirely (issue #24).
 */
export function claudeSessionDeliveryTarget(session: {
  pid: number
  kind?: string
  name?: string
}): TextDeliveryTarget | null {
  if (session.kind === 'bg') {
    return session.name === undefined ? null : { kind: 'claude-relay', sessionName: session.name }
  }
  return session.name === undefined
    ? { kind: 'terminal', pid: session.pid }
    : { kind: 'terminal', pid: session.pid, sessionName: session.name }
}

/**
 * Every session kind Claude Code recognizes, and whether a human could be
 * typing into one (issue #68).
 *
 * The four keys are the closed set the shipped binary validates the registry
 * entry against — `kind: E.enum(["interactive","bg","daemon","daemon-worker"])`
 * in 2.1.251 — three of which were live in this machine's registry while this
 * was written. Only the first is a TUI somebody is looking at; the rest are
 * headless, and a headless session's silence is exactly as strong evidence as
 * a subagent's.
 *
 * Spelled out rather than written as `kind !== 'interactive'`, which is how
 * Claude Code's own code says it. That form cannot tell a headless kind apart
 * from a kind nobody has taught this table, and those two must not fall the
 * same way — see claudeSessionAttendance.
 */
const CLAUDE_SESSION_ATTENDANCE: Record<string, DwarfAttendance> = {
  interactive: 'attended',
  bg: 'unattended',
  daemon: 'unattended',
  'daemon-worker': 'unattended'
}

/**
 * Whether a human could be typing into this session, from the registry's own
 * `kind` and from nothing else (issue #68).
 *
 * A kind this table does not name — a fifth one a later Claude Code invents,
 * or an older entry that records none at all — is 'unknown' rather than
 * 'unattended'. The vocabulary has grown before, and reading an unrecognized
 * kind as headless would shorten the silence window on a session somebody is
 * sitting at, which is the one error direction the window exists to avoid.
 *
 * Note the deliberate difference from claudeSessionDeliveryTarget above, which
 * assumes a console for a kindless entry: guessing wrong there costs a fallback
 * channel, guessing wrong here costs a live dwarf.
 */
export function claudeSessionAttendance(session: { kind?: string }): DwarfAttendance {
  if (session.kind === undefined) return 'unknown'
  return CLAUDE_SESSION_ATTENDANCE[session.kind] ?? 'unknown'
}

/**
 * Parse JSONL text into objects, skipping lines that do not parse (this also
 * silently drops the first partial line a byte-offset tail read produces).
 */
function jsonlObjects(text: string): Rec[] {
  const objects: Rec[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (isRecord(parsed) && typeof parsed.type === 'string') objects.push(parsed)
    } catch {
      // partial or corrupt line — skip
    }
  }
  return objects
}

function contentBlocks(message: unknown): Rec[] {
  if (!isRecord(message) || !Array.isArray(message.content)) return []
  return message.content.filter(isRecord)
}

/**
 * Sum of input+output+cache tokens on one assistant line's usage block, or
 * undefined when there is none (older transcripts, or a line the API never
 * attached usage to). Read cheaply from data the bounded tail already parses.
 */
function usageTokens(message: unknown): number | undefined {
  if (!isRecord(message) || !isRecord(message.usage)) return undefined
  const usage = message.usage
  const total =
    (asNumber(usage.input_tokens) ?? 0) +
    (asNumber(usage.output_tokens) ?? 0) +
    (asNumber(usage.cache_creation_input_tokens) ?? 0) +
    (asNumber(usage.cache_read_input_tokens) ?? 0)
  return total > 0 ? total : undefined
}

function assistantText(line: Rec): string | undefined {
  const texts = contentBlocks(line.message)
    .filter((block) => block.type === 'text')
    .map((block) => asString(block.text) ?? '')
    .filter((text) => text !== '')
  return texts.length > 0 ? texts.join('\n') : undefined
}

/**
 * One assistant line's content, walked block by block so a tool call
 * interleaves with the text either side of it in the order it actually
 * happened (#240) — the design's "between the bubbles", rather than every
 * text block on the line joined as if nothing ran in between.
 *
 * Consecutive text blocks still join with `\n` into one bubble, exactly as
 * `assistantText` reads them; only a `tool_use` block ends that run. A tool
 * `toolActivityLine` names no verb for contributes no line of its own, but
 * still ends the text run it interrupted — the model paused there to act,
 * whether or not this app draws that pause.
 */
function assistantFeedEntries(line: Rec, timestamp: string): FeedMessage[] {
  const entries: FeedMessage[] = []
  let buffered: string[] = []
  const flushText = (): void => {
    const joined = buffered.filter((text) => text !== '').join('\n')
    if (joined !== '') entries.push({ role: 'assistant', text: joined, timestamp })
    buffered = []
  }
  for (const block of contentBlocks(line.message)) {
    if (block.type === 'text') {
      buffered.push(asString(block.text) ?? '')
      continue
    }
    if (block.type !== 'tool_use') continue
    flushText()
    const toolName = asString(block.name)
    if (toolName === undefined || !isRecord(block.input)) continue
    const activity = toolActivityLine(toolName, block.input)
    if (activity !== undefined) entries.push({ ...activity, timestamp })
  }
  flushText()
  return entries
}

/**
 * The options on one question, or undefined when `options` is not an array at
 * all.
 *
 * Two different failures, answered differently on purpose. A non-array where
 * the schema promises a list means the block is not the shape this parser
 * thinks it is, and nothing about it can be trusted — the caller refuses the
 * whole ask. A single entry inside a real list that carries no label is only
 * that one entry being unusable: a label is what a human would press and what
 * an answer would name, so it is dropped alone rather than costing the panel a
 * question it could otherwise show.
 */
function questionOptions(value: unknown): ClaudeQuestionOption[] | undefined {
  if (!Array.isArray(value)) return undefined
  const options: ClaudeQuestionOption[] = []
  for (const item of value) {
    if (!isRecord(item)) continue
    const label = asString(item.label)
    if (label === undefined) continue
    const description = asString(item.description)
    options.push({ label, ...(description === undefined ? {} : { description }) })
  }
  return options
}

/**
 * The ask on one content block, or undefined for any other tool and for an
 * input this parser cannot read a question out of.
 *
 * Nothing is repaired. A block with no `id` is refused outright even when the
 * question itself is perfectly readable: without an id no later `tool_result`
 * could ever mark it answered, so it would sit on the panel forever — a claim
 * with no way to retire it, which is worse than the miss.
 *
 * Only the first entry of `questions` is carried. The tool's input is an array
 * and this reads one question; a call that asked several would have the rest
 * dropped rather than misreported.
 */
function askedQuestion(block: Rec, askedAt: string | undefined): ClaudePendingQuestion | undefined {
  if (block.type !== 'tool_use' || block.name !== 'AskUserQuestion') return undefined
  const toolUseId = asString(block.id)
  if (toolUseId === undefined || !isRecord(block.input)) return undefined
  const questions = block.input.questions
  if (!Array.isArray(questions) || !isRecord(questions[0])) return undefined
  const first = questions[0]
  const question = asString(first.question)
  const options = questionOptions(first.options)
  if (question === undefined || options === undefined) return undefined
  const header = asString(first.header)
  return {
    toolUseId,
    question,
    ...(header === undefined ? {} : { header }),
    // Absent or non-boolean reads as single-select: the narrower promise is the
    // one a panel can honour without knowing what the tool would accept.
    multiSelect: first.multiSelect === true,
    options,
    ...(askedAt === undefined ? {} : { askedAt })
  }
}

/**
 * The tool call on one content block, or undefined for anything that is not
 * one this app may ever show as a permission request (#203).
 *
 * Refused rather than repaired, on the three grounds `askedQuestion` refuses
 * an ask: no `id` means no `tool_result` could ever mark it resolved, so it
 * would sit on the panel forever; no `name` means the card could not say what
 * the session wants to run, which is the whole content of the request; and an
 * `input` that is not an object is not a shape `permissionInputLine` can
 * summarise.
 *
 * `AskUserQuestion` is excluded here rather than filtered later, because it
 * is not a near miss — it is the one tool that asks instead of acting, raises
 * no permission dialog, and is already carried whole by `pendingQuestion`.
 */
function calledTool(block: Rec, askedAt: string | undefined): ClaudeToolUse | undefined {
  if (block.type !== 'tool_use' || block.name === 'AskUserQuestion') return undefined
  const toolUseId = asString(block.id)
  const toolName = asString(block.name)
  if (toolUseId === undefined || toolName === undefined || !isRecord(block.input)) return undefined
  return {
    toolUseId,
    toolName,
    input: block.input,
    ...(askedAt === undefined ? {} : { askedAt })
  }
}

/**
 * The tool_use ids this line answers.
 *
 * `is_error` is deliberately NOT consulted: a question the user escaped out of
 * is resolved, not still waiting on them. The panel must stop showing it either
 * way, and only the id says which ask it belongs to.
 */
function resolvedToolUseIds(line: Rec): string[] {
  const ids: string[] = []
  for (const block of contentBlocks(line.message)) {
    if (block.type !== 'tool_result') continue
    const id = asString(block.tool_use_id)
    if (id !== undefined) ids.push(id)
  }
  return ids
}

/**
 * Every string a message's content can hold, whether it is the content itself,
 * a bare string in a block array, or text nested one level down inside a block
 * object. `{type:'text', text}` and `{type:'tool_result', content}` both hide
 * the blob from a `typeof item === 'string'` filter, which is how a
 * notification could sit in the window and never be seen (issue #64).
 */
function messageStrings(content: unknown): string[] {
  if (typeof content === 'string') return [content]
  if (!Array.isArray(content)) return []
  const strings: string[] = []
  for (const item of content) {
    if (typeof item === 'string') strings.push(item)
    else if (isRecord(item))
      strings.push(...messageStrings(item.text), ...messageStrings(item.content))
  }
  return strings
}

/**
 * The strings on one line that Claude Code itself wrote a `<task-notification>`
 * into, and so the only ones an ending may be read from.
 *
 * Two things are going on here, and both were measured against real transcripts
 * rather than reasoned about (366 files, ~373 MB, 191 launched agents, on
 * 2026-08-30; the tabulated shapes are in docs/provider-formats.md §1.4).
 *
 * **Where the notification is.** Most of them never touch `message.content`:
 * `queue-operation` and `attachment` records have no `message` key at all, and
 * they carry the great majority of endings. Rooting the search at
 * `message.content` found 117 of 188 real endings in that corpus, and 2 of 10
 * in the session issue #64 was reported from. Reading these three envelopes
 * finds all 188.
 *
 * **Where it merely appears.** A transcript quotes notifications constantly — a
 * Bash result that printed one, an assistant discussing one, a hook echoing the
 * prompt it was handed, an `async_launched` record whose own prompt pasted one.
 * Scanning every string on the line would have retired 32 more ids in that
 * corpus on nothing but a quotation, and `terminalAgentIds` is remembered for
 * the life of the process across every session — so a quote in one session
 * evicts a live dwarf in another. That is #60's failure, and it is worse than
 * the ghost it would fix: an agent waiting on a human writes nothing, and the
 * only thing keeping it visible is that nobody claimed it ended.
 *
 * So the test is *who wrote the string*, never what the string looks like: the
 * harness delivering a message to the session counts, a model or a tool
 * reproducing one does not. Nothing is lost by it — no ending in that corpus
 * reaches a quote envelope without also reaching a delivery one.
 */
function notificationStrings(line: Rec): string[] {
  // The harness's own message queue. `enqueue` writes the blob when the agent
  // stops; the `remove` that follows once the turn absorbs it repeats it.
  if (line.type === 'queue-operation') {
    const content = asString(line.content)
    return content === undefined ? [] : [content]
  }
  // A queued message materialised into a turn. `hook_success` attachments are a
  // hook's captured stdout, so their content and stdout are deliberately unread.
  if (line.type === 'attachment') {
    const attachment = line.attachment
    if (!isRecord(attachment) || attachment.type !== 'queued_command') return []
    const prompt = asString(attachment.prompt)
    return prompt === undefined ? [] : [prompt]
  }
  if (line.type !== 'user') return []
  // A user line carrying toolUseResult is a tool response, not a message: its
  // content is whatever the tool printed, including a whole transcript.
  if (line.toolUseResult !== undefined || !isRecord(line.message)) return []
  return messageStrings(line.message.content)
}

/**
 * The key Claude Code names a resumed agent with, and the cheap gate that keeps
 * `JSON.parse` off every tool result in the poll's hot path (issue #338).
 */
const RESUMED_AGENT_KEY = 'resumedAgentId'

/**
 * The agent one tool-result PAYLOAD says was resumed, or undefined when it says
 * nothing of the kind (issue #338).
 *
 * A top-level key of a parsed object, never a substring of anything. That is
 * the same "who wrote it, not what it looks like" test `notificationStrings`
 * applies to an ending, for the same reason: a transcript quotes tool output
 * constantly, and adopting an agent out of a Bash result that happened to print
 * a resume payload would put a dwarf on the board on a quotation. Reading the
 * key off the payload keeps a printed one nested inside `stdout`, where it
 * cannot be mistaken for the harness's own answer.
 *
 * `success: false` is refused: a resume the harness says did not happen is not
 * one. An ABSENT `success` is accepted, because the field is the payload's
 * report of its own outcome and a later shape that stops writing it must not
 * silently cost the redraw.
 */
function resumeIn(payload: unknown): { agentId: string; summary?: string } | undefined {
  if (!isRecord(payload)) return undefined
  const agentId = asString(payload.resumedAgentId)
  if (agentId === undefined || payload.success === false) return undefined
  const summary = asString(payload.summary)
  return { agentId, ...(summary === undefined ? {} : { summary }) }
}

/**
 * The agent Claude Code says it resumed on this line (issue #338).
 *
 * Both shapes one tool result is written in, because the launch record's own
 * §1.4 note says the line carries both: `toolUseResult` is the machine-readable
 * copy, and `message.content[].tool_result` the one the model reads, whose text
 * is the same payload as JSON. Either is the harness answering the
 * orchestrator's `SendMessage` call, so either will do, and a line that is not
 * a tool result at all reaches neither.
 */
function resumedAgentIn(line: Rec): { agentId: string; summary?: string } | undefined {
  const direct = resumeIn(line.toolUseResult)
  if (direct !== undefined) return direct
  for (const block of contentBlocks(line.message)) {
    if (block.type !== 'tool_result') continue
    for (const text of messageStrings(block.content)) {
      if (!text.includes(RESUMED_AGENT_KEY)) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        // Text that merely mentions the key: a tool printing a payload rather
        // than the harness returning one.
        continue
      }
      const resumed = resumeIn(parsed)
      if (resumed !== undefined) return resumed
    }
  }
  return undefined
}

/**
 * Terminal statuses a `<task-notification>` can report. `killed` is the one an
 * accidental stop writes — leaving it out was the ghost-dwarf bug: the agent
 * never notified as completed, so it mined forever (see docs/provider-formats.md).
 */
const TASK_NOTIFICATION_RE =
  /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(completed|failed|killed)<\/status>/g

/**
 * Extract model/effort, the latest assistant text and the set of in-flight
 * subagents from the tail of a session (or subagent) transcript.
 *
 * An agent is in flight when a `toolUseResult.status == "async_launched"` line
 * exists with no task-notification for the same task-id in this tail.
 */
export function parseClaudeTranscriptTail(tailText: string): ClaudeTranscriptInfo {
  let model: string | undefined
  let effort: string | undefined
  let lastAssistantText: string | undefined
  let pendingBackgroundAgentCount: number | undefined
  let tokensObserved: number | undefined
  const launched = new Map<string, ClaudeInFlightAgent>()
  // agentId -> the status of the LAST ending this tail carries for it. A
  // retried agent notifies once per attempt (three `failed` blobs each in the
  // session #179 was reported from), so only the last one describes the agent
  // as this window leaves it; membership alone is what makes it terminal.
  const finished = new Map<string, string>()
  // Where in this window each agent's last ending and last resume record sit
  // (issue #338). A second ending is byte-identical to the first, so ORDER is
  // the only thing that can say whether a resume is still the agent's latest
  // word — see ClaudeAgentResume.endedSince for why a suffix read may be
  // trusted with that question.
  const finishedAt = new Map<string, number>()
  const resumed = new Map<string, { record: Omit<ClaudeAgentResume, 'endedSince'>; at: number }>()
  let position = 0
  // The same asked-then-resolved bookkeeping the launches above use, on the
  // tool's own ids. Insertion order is ask order, so the last survivor is the
  // latest open question (issue #94).
  const asked = new Map<string, ClaudePendingQuestion>()
  const answered = new Set<string>()
  // The same bookkeeping again, over every OTHER tool (#203). Its own map
  // rather than a filter over one shared with `asked`, because the two are
  // read for opposite purposes: an ask is a question the panel repeats, and a
  // call is an act somebody may have to approve. Insertion order is ask order,
  // which is what makes "the latest open call" a position rather than a guess.
  const called = new Map<string, ClaudeToolUse>()

  for (const line of jsonlObjects(tailText)) {
    position++
    // Runs for every line, not inside the `user` branch: the envelopes that
    // carry most endings are not user lines at all (issue #64).
    for (const text of notificationStrings(line)) {
      for (const match of text.matchAll(TASK_NOTIFICATION_RE)) {
        const taskId = match[1]
        const status = match[2]
        if (taskId !== undefined && status !== undefined) {
          finished.set(taskId, status)
          finishedAt.set(taskId, position)
        }
      }
    }
    if (line.type === 'assistant') {
      if (isRecord(line.message)) model = asString(line.message.model) ?? model
      effort = asString(line.effort) ?? effort
      lastAssistantText = assistantText(line) ?? lastAssistantText
      tokensObserved = usageTokens(line.message) ?? tokensObserved
      for (const block of contentBlocks(line.message)) {
        const question = askedQuestion(block, asString(line.timestamp))
        if (question !== undefined) asked.set(question.toolUseId, question)
        const call = calledTool(block, asString(line.timestamp))
        if (call !== undefined) called.set(call.toolUseId, call)
      }
      continue
    }
    if (line.type === 'user') {
      for (const id of resolvedToolUseIds(line)) answered.add(id)
      const result = line.toolUseResult
      if (isRecord(result) && result.status === 'async_launched') {
        const agentId = asString(result.agentId)
        if (agentId !== undefined) {
          launched.set(agentId, {
            agentId,
            description: asString(result.description),
            resolvedModel: asString(result.resolvedModel)
          })
        }
      }
      // The other record that starts an agent (issue #338). Same envelope as
      // the launch above — a tool result on a `user` line — because it IS one:
      // the harness answering a `SendMessage` call with the id it restarted.
      const restarted = resumedAgentIn(line)
      if (restarted !== undefined) {
        const timestamp = asString(line.timestamp)
        resumed.set(restarted.agentId, {
          record: { ...restarted, ...(timestamp === undefined ? {} : { timestamp }) },
          at: position
        })
      }
      continue
    }
    if (line.type === 'system' && line.subtype === 'turn_duration') {
      pendingBackgroundAgentCount =
        asNumber(line.pendingBackgroundAgentCount) ?? pendingBackgroundAgentCount
    }
  }

  return {
    model,
    effort,
    lastAssistantText,
    inFlightAgents: [...launched.values()].filter((agent) => !finished.has(agent.agentId)),
    terminalAgentIds: [...finished.keys()],
    failedAgents: [...launched.values()].filter(
      (agent) => finished.get(agent.agentId) === 'failed'
    ),
    endedLaunches: [...launched.values()].filter((agent) => finished.has(agent.agentId)),
    resumedAgents: [...resumed.values()].map(({ record, at }) => ({
      ...record,
      endedSince: (finishedAt.get(record.agentId) ?? -1) > at
    })),
    pendingBackgroundAgentCount,
    tokensObserved,
    // Matched by id over the whole tail rather than by line order: a suffix read
    // cannot show a result before its ask, and the rule must not depend on that.
    pendingQuestion: [...asked.values()].filter((ask) => !answered.has(ask.toolUseId)).at(-1),
    // Matched by id over the whole tail for the same reason, and kept in ask
    // order (#203).
    unresolvedToolUses: [...called.values()].filter((call) => !answered.has(call.toolUseId))
  }
}

/**
 * The element Claude Code wraps a cross-session message in, and the only part
 * of that line a person wrote (issue #180).
 *
 * A message typed into the panel and delivered through the relay tier (issue
 * #24) reaches the target session as a meta user line: Claude Code's own
 * framing sentence, this element, and a trailing note explaining where it came
 * from. All three are the harness's words except what is inside the element.
 */
const CROSS_SESSION_MESSAGE_RE = /<cross-session-message[^>]*>([\s\S]*?)<\/cross-session-message>/

/**
 * The words on one `user` line's content, whichever of its two shapes it took,
 * or undefined when it carries none (issue #216).
 *
 * A string is the shape a prompt typed at a turn boundary takes, and a block
 * array is the other one Claude Code writes for the same thing. Reading only
 * the string dropped every prompt written the other way — measured over every
 * transcript on one machine (519 files, 537 MiB, 35 870 `user` lines): 1746
 * strings, 103 text-block arrays, 14 arrays mixing text with a tool result.
 *
 * Only a block's own `text` is read, never a `tool_result`'s nested content:
 * 33 976 of those arrays in the same corpus are tool output, which can be a
 * whole transcript, and publishing one as something a person typed is the
 * failure this shape was hiding behind. A mixed array therefore keeps its text
 * blocks and drops the rest. Blocks are joined the way assistantText joins
 * them, so one prompt stays one message.
 */
function userContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return undefined
  const texts = content
    .filter(isRecord)
    .filter((block) => block.type === 'text')
    .map((block) => asString(block.text) ?? '')
    .filter((text) => text !== '')
  return texts.length > 0 ? texts.join('\n') : undefined
}

/**
 * What one `user` line publishes to the feed, or undefined when it is not
 * somebody speaking.
 *
 * The two skips it keeps — meta lines, and content that opens with a tag — are
 * what keep the harness's own prompts out, and they apply to both content
 * shapes alike: 57 of the 103 text-block arrays measured were `isMeta`. The
 * relay envelope trips both, so it has to be recognized before them, and only
 * from a line no tool wrote: tool output can print a whole transcript,
 * envelopes and all, which is the same reason an ending is only ever read from
 * the record Claude Code delivered it in (see notificationStrings).
 *
 * A third skip sits ahead of all of it (issue #188). When Claude Code compacts
 * it writes a `user` line whose content is the whole multi-kilobyte summary
 * ("This session is being continued from a previous conversation…"), flagged
 * `isCompactSummary` and `isVisibleInTranscriptOnly`; the panel drew it as a
 * message the person typed. Both flags name a line written for the transcript
 * rather than sent by anybody, so either one on its own is enough — and it is
 * the FLAG that decides, never the content shape, so the block array #216
 * added cannot become a way back in.
 */
function userMessageText(line: Rec): string | undefined {
  if (line.isCompactSummary === true || line.isVisibleInTranscriptOnly === true) return undefined
  if (!isRecord(line.message)) return undefined
  const content = userContentText(line.message.content)
  if (content === undefined) return undefined
  if (line.toolUseResult === undefined) {
    const relayed = content.match(CROSS_SESSION_MESSAGE_RE)?.[1]?.trim()
    if (relayed !== undefined) return relayed === '' ? undefined : relayed
  }
  if (line.isMeta === true || content.startsWith('<')) return undefined
  return content
}

/**
 * The message a person sent into a turn that was already running, or undefined
 * for every other attachment (issue #180).
 *
 * Such a message is never written as a `user` line at all: it is enqueued,
 * materialised into the running turn as this `queued_command` attachment, and
 * then removed as `absorbed_mid_turn`. Only the middle record is read, so one
 * message cannot reach the panel three times.
 *
 * `origin.kind` is what separates a person from the harness, and exactly two
 * of its values are somebody speaking. `human` is the message typed into this
 * session's own TUI, and its prompt is the words themselves. `peer` is one
 * relayed in from another session (issue #24) — the same envelope the meta
 * user line above carries, only landing mid-turn — and the origin quotes the
 * message on its own in `body`, with the envelope in the prompt saying it a
 * second time. The body is preferred because it is the direct evidence;
 * unwrapping the prompt is the fallback for an origin whose keys a later
 * Claude Code spells differently. Every other kind — a task-notification's own
 * queued prompt above all — stays out.
 */
function typedMidTurnPrompt(line: Rec): string | undefined {
  const attachment = line.attachment
  if (!isRecord(attachment) || attachment.type !== 'queued_command') return undefined
  const origin = attachment.origin
  if (!isRecord(origin)) return undefined
  const prompt = asString(attachment.prompt)
  if (origin.kind === 'human') {
    const typed = prompt?.trim()
    return typed === '' ? undefined : typed
  }
  if (origin.kind !== 'peer') return undefined
  const body = asString(origin.body)?.trim()
  if (body !== undefined && body !== '') return body
  const relayed = prompt?.match(CROSS_SESSION_MESSAGE_RE)?.[1]?.trim()
  return relayed === undefined || relayed === '' ? undefined : relayed
}

/**
 * The last `limit` things SAID in a transcript tail: everything a person
 * typed, however it was delivered, assistant text replies, and one line per
 * tool call the design's four verbs name (#240), interleaved between the text
 * in call order. Tool results, task notifications and the harness's own meta
 * lines are skipped, and so is a tool call `toolActivityLine` names no verb
 * for.
 *
 * `limit` counts the texts and never the activity lines (`trimFeed`, #359):
 * twelve tool calls after the agent's last reply used to be the whole answer,
 * and the panel drew a folded run with nothing said above it.
 *
 * `activityLimit` is forwarded rather than defaulted so a PAGE read can ask for
 * the window whole (#364); see `FeedExtractor`.
 */
export function extractClaudeFeed(
  tailText: string,
  limit: number,
  activityLimit?: number
): FeedMessage[] {
  const feed: FeedMessage[] = []
  for (const line of jsonlObjects(tailText)) {
    const timestamp = asString(line.timestamp) ?? ''
    if (line.type === 'attachment') {
      const typed = typedMidTurnPrompt(line)
      if (typed !== undefined) feed.push({ role: 'user', text: typed, timestamp })
      continue
    }
    if (line.type === 'user') {
      const text = userMessageText(line)
      if (text !== undefined) feed.push({ role: 'user', text, timestamp })
      continue
    }
    if (line.type === 'assistant') {
      feed.push(...assistantFeedEntries(line, timestamp))
    }
  }
  return trimFeed(feed, limit, activityLimit)
}
