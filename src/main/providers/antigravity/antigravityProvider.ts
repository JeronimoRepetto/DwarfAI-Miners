import type { FsLike } from '../../adapters/fsLike'
import { redactSecrets } from '../../domain/redactSecrets'
import type { Dwarf, FeedMessage, ProviderSnapshot } from '../../domain/types'
import { pollProfiler } from '../../runtime/perf'
import { readFeedWindow } from '../feedWindow'
import { firstUserMessageIn, readFirstPrompt } from '../firstPrompt'
import type { Provider } from '../provider'
import {
  antigravityConversationIdsFromLocks,
  antigravityHistoryPath,
  antigravityPresenceDir,
  antigravityTranscriptPath,
  parseAntigravityHistory,
  type AntigravityWorkspace
} from './discovery'
import {
  extractAntigravityFeed,
  parseAntigravityTranscriptTail,
  type AntigravityTranscriptState
} from './parse'

/**
 * How much of one conversation's transcript the poll reads per scan.
 *
 * 256 KiB, and unusually this one is a measurement rather than slack.
 * `transcript.jsonl` is the CLI's own TRUNCATED view of its step log — long
 * fields are cut and named in the record's `truncated_fields`, with
 * `transcript_full.jsonl` beside it holding the whole thing — so a record has
 * a ceiling. Across 389 real records in three conversations on CLI 1.1.26 the
 * largest line was 4,844 bytes, so this window holds roughly the last fifty
 * steps: far more than the newest step's status and the newest planner reply
 * need, at one bounded read per conversation per tick.
 *
 * The truncated view is read on purpose. It is half the bytes of the full one,
 * and the only field it cuts that this app displays would be a reply longer
 * than the cap — which the panel truncates anyway.
 */
const TRANSCRIPT_TAIL_BYTES = 256 * 1024

/**
 * How much of `history.jsonl` one scan reads, from the END.
 *
 * The tail rather than the head, because the mapping that matters is the
 * NEWEST record for a conversation, and the file only grows. 1 MiB is
 * thousands of records — the captured machine's whole file was 3.1 KiB for
 * nine — so a conversation whose only record falls outside this window has
 * gone unmentioned for thousands of prompts, and a lock still on disk for it
 * is exactly the stale-lock case `staleLockWindowS` is about.
 */
const HISTORY_TAIL_BYTES = 1024 * 1024

export interface AntigravityProviderOptions {
  fs: FsLike
  /** The `~/.gemini/antigravity-cli` store root, already expanded. */
  storeRoot: string
  /** How recent a still-RUNNING step must be to count as an open turn, in seconds. */
  busyWindowS: number
  /** How long a conversation survives its presence lock disappearing, in seconds. */
  lockGraceS: number
  /** How silent a locked conversation may be before the lock is treated as stale, in seconds. */
  staleLockWindowS: number
  now?: () => number
}

/**
 * Observes Antigravity CLI (`agy`) conversations somebody else started.
 *
 * ## What it is, and what it deliberately is not
 *
 * This is the OBSERVER half of #237, plus the one extra fact step 4's
 * detached launch needs to be recognised (firstPrompt — see below): it is
 * still not a channel INTO a session. It reads the CLI's own private store
 * and publishes what is there: which conversations are running, which folder
 * each belongs to, whether a turn is open, and the words on both sides of the
 * exchange. It implements no `textDelivery`, so the runtime resolves the whole
 * capability matrix to null and the action bar disables send, kick and boost
 * with its own honest reason. It answers no question and no permission
 * prompt, guesses no pid, and mines no tokens.
 *
 * Every one of those absences is a fact about the evidence rather than a
 * missing feature, and the reasons are worth keeping together:
 *
 * - **No pid.** A running `agy.exe` cannot be tied to a conversation: its
 *   command line carries no conversation id, so with two sessions open any
 *   match is a coin flip. Focus falls back to tailing the transcript, which is
 *   what an unmatched session already gets.
 * - **No tokens.** The private transcript records no usage figure anywhere
 *   (verified on 1.1.26). A message count or a byte size wearing a token's
 *   name would corrupt the ledger permanently, so this dwarf mines nothing.
 * - **No `waiting`.** In this app a session `waiting` means a structured block
 *   a human can act on. This store carries no approval, elicitation or
 *   input-request record of any kind, so a quiet conversation is `idle` — the
 *   conservative rule of #34 and #60, which silence may never talk its way
 *   past.
 * - **No rank.** An Antigravity subagent gets its own conversation directory,
 *   and the parent edge lives in the parent's own subagent tool events. Until
 *   those are read, absence of spawn evidence is `worker`, never `foreman`.
 * - **No model or effort.** The one place a model name appears is prose inside
 *   a `<USER_SETTINGS_CHANGE>` block ("changed setting `Model Selection` from
 *   None to …"), which is a sentence and not a field. Reading it would be this
 *   app parsing prose for a fact, which is the failure #60 exists to prevent.
 *
 * ## How liveness works, and why it is not Codex's rule
 *
 * The CLI writes a 0-byte `presence/<conversation-id>.lock` while a
 * conversation is running. That is the CLI stating a session exists — stronger
 * evidence than any file's age, and the reason an open-but-quiet Antigravity
 * session stays on the board where Codex needs a global process probe to keep
 * one there. It is still not a contract: a crash leaves the lock behind, and
 * nothing documents when the CLI removes one. So it is bounded from both ends:
 *
 * - a lock that stops being listed keeps its conversation for `lockGraceS`,
 *   because a lock can be replaced between two reads and a dwarf that leaves
 *   on one missed listing makes the board flicker;
 * - a lock over a conversation silent for longer than `staleLockWindowS` is
 *   read as stale and its dwarf is not published at all.
 *
 * A conversation with no workspace record in `history.jsonl` is dropped rather
 * than placed: that file is the only thing that says which folder a
 * conversation belongs to, and a mine invented from a conversation id would be
 * the phantom-project failure of #166 by another route.
 */
export class AntigravityProvider implements Provider {
  readonly kind = 'antigravity' as const

  private readonly fs: FsLike
  private readonly storeRoot: string
  private readonly busyWindowS: number
  private readonly lockGraceS: number
  private readonly staleLockWindowS: number
  private readonly now: () => number
  /**
   * conversationId -> the last time a presence lock for it was actually READ.
   *
   * The whole of the grace window's memory, and the reason it cannot be
   * fabricated: an id reaches this map only by a lock for it having been
   * listed, so a conversation this provider never saw locked is never granted
   * the benefit of the doubt. Pruned as the window expires, so a machine that
   * has run many sessions does not accumulate them.
   */
  private readonly lockSeenAtMs = new Map<string, number>()
  /**
   * Transcript path -> its size at the previous scan. Growth between two scans
   * is proof of writes happening right now, and the one liveness signal a
   * frozen Windows mtime cannot contradict (issue #1).
   */
  private readonly lastSeenSizes = new Map<string, number>()
  /**
   * Transcript path -> the parse at the size it was last read. A transcript
   * whose size has not changed has produced no new bytes to parse (the log is
   * append-only), so its previous verdict is still exactly correct and the
   * tail read is skipped. Pruned to this scan's conversations.
   */
  private readonly transcriptCache = new Map<
    string,
    { size: number; state: AntigravityTranscriptState }
  >()
  /**
   * dwarfId -> transcript path, for feed() and transcriptPath().
   *
   * Rebuilt into a SEPARATE map that replaces this reference in one assignment
   * at the end of a scan (issue #12): clearing and repopulating the live map
   * across awaits let a click landing mid-scan read a half-rebuilt map and
   * resolve to another dwarf's transcript.
   */
  private feedSources: ReadonlyMap<string, string> = new Map()

  constructor(options: AntigravityProviderOptions) {
    this.fs = options.fs
    this.storeRoot = options.storeRoot
    this.busyWindowS = options.busyWindowS
    this.lockGraceS = options.lockGraceS
    this.staleLockWindowS = options.staleLockWindowS
    this.now = options.now ?? Date.now
  }

  async scan(): Promise<ProviderSnapshot[]> {
    const nowMs = this.now()
    // Seeded from the previous generation rather than empty (#192): a
    // conversation that stops being live is still a file with the last turn in
    // it, and the panel reads once more while the runtime shows the dwarf
    // leaving.
    const feedSources = new Map<string, string>(this.feedSources)

    const candidates = await pollProfiler.measure('ag.locks', () => this.liveConversations(nowMs))
    pollProfiler.count('ag.candidates.n', candidates.length)
    const workspaces = await pollProfiler.measure('ag.history', () => this.readWorkspaces())

    const paths = candidates.map((id) => antigravityTranscriptPath(this.storeRoot, id))
    // One batch rather than one await at a time (#25): stat() has no side
    // effects and no decision below depends on the previous conversation's.
    const stats = await pollProfiler.measure('ag.stat', () =>
      Promise.all(paths.map((path) => this.fs.stat(path)))
    )

    const snapshots: ProviderSnapshot[] = []
    const sizesThisScan = new Map<string, number>()
    for (const [index, conversationId] of candidates.entries()) {
      const workspace = workspaces.get(conversationId)
      if (workspace === undefined) continue
      const path = paths[index]!
      const stat = stats[index] ?? null
      const size = stat?.size
      const previousSize = this.lastSeenSizes.get(path)
      if (size !== undefined) sizesThisScan.set(path, size)
      const grew = previousSize !== undefined && size !== undefined && size > previousSize
      const unchanged = previousSize !== undefined && size !== undefined && size === previousSize

      const state = stat === null ? {} : await this.readTranscript(path, { unchanged, size, grew })
      // Every clock this app can honestly read for the conversation, and the
      // newest of them wins. The step's own `created_at` is inside the file, so
      // a frozen mtime cannot hide it; the history record is a real human turn;
      // growth means right now.
      const activityMs = Math.max(
        state.latestStep?.createdAtMs ?? 0,
        workspace.timestampMs,
        stat?.mtimeMs ?? 0,
        grew ? nowMs : 0
      )
      if (nowMs - activityMs > this.staleLockWindowS * 1_000) continue

      const busy = grew || this.hasOpenTurn(state, nowMs)
      const dwarfId = `antigravity:${conversationId}`
      // Only a transcript that EXISTS answers a feed or a terminal tail. A
      // conversation whose first record has not been flushed is still a real
      // session, and it is published without one rather than dropped.
      if (stat !== null) feedSources.set(dwarfId, path)
      snapshots.push(
        this.snapshotConversation({ conversationId, dwarfId, workspace, state, busy, activityMs })
      )
    }

    this.lastSeenSizes.clear()
    for (const [path, size] of sizesThisScan) this.lastSeenSizes.set(path, size)
    for (const path of [...this.transcriptCache.keys()]) {
      if (!sizesThisScan.has(path)) this.transcriptCache.delete(path)
    }
    // Only reached on success: a throwing scan leaves the previous generation
    // in place rather than stripping it.
    this.feedSources = feedSources
    return snapshots
  }

  /**
   * The conversations this scan considers: every one the CLI currently locks,
   * plus every one whose lock has been gone for less than the grace window.
   *
   * Sorted, so two scans of an unchanged store publish the same order.
   */
  private async liveConversations(nowMs: number): Promise<string[]> {
    const entries = await this.fs.listDir(antigravityPresenceDir(this.storeRoot))
    for (const id of antigravityConversationIdsFromLocks(entries)) {
      this.lockSeenAtMs.set(id, nowMs)
    }
    const live: string[] = []
    for (const [id, seenAtMs] of this.lockSeenAtMs) {
      if (nowMs - seenAtMs > this.lockGraceS * 1_000) {
        this.lockSeenAtMs.delete(id)
        continue
      }
      live.push(id)
    }
    return live.sort()
  }

  /**
   * The workspace behind every conversation the store's prompt log names.
   *
   * A store with no `history.jsonl` at all — a machine with the CLI installed
   * and never run — degrades to an empty map rather than failing the tick, the
   * same fail-safe every read here is under.
   */
  private async readWorkspaces(): Promise<Map<string, AntigravityWorkspace>> {
    try {
      const text = await this.fs.readTextTail(
        antigravityHistoryPath(this.storeRoot),
        HISTORY_TAIL_BYTES
      )
      return parseAntigravityHistory(text)
    } catch {
      return new Map()
    }
  }

  /**
   * Parse one conversation's transcript tail, reusing the previous verdict when
   * the file has not grown.
   *
   * A transcript the CLI retired between the stat and the read degrades to "no
   * transcript data" rather than failing the tick.
   */
  private async readTranscript(
    path: string,
    cache: { unchanged: boolean; size: number | undefined; grew: boolean }
  ): Promise<AntigravityTranscriptState> {
    if (cache.unchanged && cache.size !== undefined) {
      const cached = this.transcriptCache.get(path)
      if (cached !== undefined && cached.size === cache.size) return cached.state
    }
    let text: string
    try {
      text = await this.fs.readTextTail(path, TRANSCRIPT_TAIL_BYTES)
    } catch {
      return {}
    }
    const state = parseAntigravityTranscriptTail(text)
    if (cache.size !== undefined) this.transcriptCache.set(path, { size: cache.size, state })
    return state
  }

  /**
   * Whether a turn is open, from the transcript alone.
   *
   * Two conditions, and both are needed. The newest step must say `RUNNING` —
   * an older one saying so proves nothing, because `status` is written once
   * when a step is appended and is never rewritten (verified on 1.1.26, where
   * a RUNNING background-task step is followed by fourteen DONE steps and
   * still reads RUNNING today). And that word must be recent, because a
   * crashed turn leaves its RUNNING record on disk forever and this dwarf
   * would otherwise mine for eternity.
   *
   * A step with no readable clock claims nothing: absence is not freshness.
   */
  private hasOpenTurn(state: AntigravityTranscriptState, nowMs: number): boolean {
    const step = state.latestStep
    if (step === undefined || !step.running || step.createdAtMs === undefined) return false
    return nowMs - step.createdAtMs <= this.busyWindowS * 1_000
  }

  private snapshotConversation(context: {
    conversationId: string
    dwarfId: string
    workspace: AntigravityWorkspace
    state: AntigravityTranscriptState
    busy: boolean
    activityMs: number
  }): ProviderSnapshot {
    const dwarf: Dwarf = {
      id: context.dwarfId,
      provider: 'antigravity',
      // Absence of spawn evidence, never a verdict about a crew — see the
      // class comment on why no rank is read in this slice.
      role: 'worker',
      // The executable's own name, because the panel already shows the
      // provider identity beside it (see observerLabel) and saying
      // "antigravity" twice in one label helps nobody. `agy` is what a person
      // types to start one of these, so it is what they recognise.
      name: `agy-${context.conversationId.slice(0, 8)}`,
      // The resting DwarfStatus, which is a different claim from a session
      // being blocked: `waitingReason` and `pendingQuestion` stay absent
      // because this store proves neither.
      status: context.busy ? 'working' : 'waiting',
      // Redacted BEFORE the renderer's bubble truncation can slice it: a
      // truncated prefix can still contain a whole key. The parse cache keeps
      // the raw text; only what leaves the provider is scrubbed.
      lastMessage: redactSecrets(context.state.lastMessage),
      sessionId: context.conversationId
    }
    return {
      provider: 'antigravity',
      sessionId: context.conversationId,
      cwd: context.workspace.workspace,
      // Whether a TURN is open, which is a different fact from whether the
      // SESSION is alive — the lock answers the second one, and conflating the
      // two is what #202 was.
      status: context.busy ? 'busy' : 'idle',
      dwarfs: [dwarf],
      updatedAt: context.activityMs
    }
  }

  async feed(dwarfId: string, limit: number): Promise<FeedMessage[] | null> {
    const path = this.feedSources.get(dwarfId)
    if (path === undefined) return null
    if (!(await this.fs.exists(path))) return []
    // Bounded by the COUNT asked for rather than by a fixed byte window, the
    // same walk ClaudeProvider and CodexProvider take (#215, #228): this store
    // is mostly tool output too, so a fixed narrow tail would hold a few
    // messages or none. On demand only — the poll reads
    // TRANSCRIPT_TAIL_BYTES and never calls feed().
    const messages = await readFeedWindow(this.fs, path, limit, extractAntigravityFeed)
    return messages.map((message) => ({ ...message, text: redactSecrets(message.text) }))
  }

  /**
   * The prompt this conversation opened with (#237, step 4; see #191's
   * design) — the head of the same transcript feed() reads the tail of, and
   * never redacted: see firstPrompt.ts.
   *
   * This is what lets a detached `agy -p` launch be recognised on the board
   * at all: the launcher writes its prompt to the child's stdin and nothing
   * else identifies the session it becomes, so the Add Panel's own receipt
   * (LaunchReceiptRegistry) reads this and matches it against the exact text
   * it sent. `firstUserMessageIn(extractAntigravityFeed)` reuses the observer
   * slice's own envelope-stripping (`antigravityUserRequestText`) rather than
   * a second reading of `<USER_REQUEST>`: the same rule that turns a step
   * into a feed message is what turns one into a receipt.
   */
  async firstPrompt(dwarfId: string): Promise<string | undefined> {
    const path = this.feedSources.get(dwarfId)
    if (path === undefined) return undefined
    return readFirstPrompt(this.fs, path, firstUserMessageIn(extractAntigravityFeed))
  }

  /**
   * The file backing feed(), so a terminal can tail the conversation live for
   * a session no window can be focused for — which, for an externally started
   * `agy`, is every one of them.
   */
  transcriptPath(dwarfId: string): string | undefined {
    return this.feedSources.get(dwarfId)
  }
}
