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
    waitingFor: asString(json.waitingFor),
    procStart: asString(json.procStart),
    kind: asString(json.kind),
    name: asString(json.name),
    startedAt: asNumber(json.startedAt),
    updatedAt: asNumber(json.updatedAt)
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
  const finished = new Set<string>()
  // The same asked-then-resolved bookkeeping the launches above use, on the
  // tool's own ids. Insertion order is ask order, so the last survivor is the
  // latest open question (issue #94).
  const asked = new Map<string, ClaudePendingQuestion>()
  const answered = new Set<string>()

  for (const line of jsonlObjects(tailText)) {
    // Runs for every line, not inside the `user` branch: the envelopes that
    // carry most endings are not user lines at all (issue #64).
    for (const text of notificationStrings(line)) {
      for (const match of text.matchAll(TASK_NOTIFICATION_RE)) {
        const taskId = match[1]
        if (taskId !== undefined) finished.add(taskId)
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
    terminalAgentIds: [...finished],
    pendingBackgroundAgentCount,
    tokensObserved,
    // Matched by id over the whole tail rather than by line order: a suffix read
    // cannot show a result before its ask, and the rule must not depend on that.
    pendingQuestion: [...asked.values()].filter((ask) => !answered.has(ask.toolUseId)).at(-1)
  }
}

/**
 * The last `limit` human-readable messages of a transcript tail: typed user
 * prompts and assistant text replies. Tool results, task notifications and
 * meta lines are skipped.
 */
export function extractClaudeFeed(tailText: string, limit: number): FeedMessage[] {
  const feed: FeedMessage[] = []
  for (const line of jsonlObjects(tailText)) {
    const timestamp = asString(line.timestamp) ?? ''
    if (line.type === 'user' && line.isMeta !== true && isRecord(line.message)) {
      const content = line.message.content
      if (typeof content === 'string' && !content.startsWith('<')) {
        feed.push({ role: 'user', text: content, timestamp })
      }
      continue
    }
    if (line.type === 'assistant') {
      const text = assistantText(line)
      if (text !== undefined) feed.push({ role: 'assistant', text, timestamp })
    }
  }
  return feed.slice(-limit)
}
