/**
 * Data crossing the Electron process boundary. Keep this module free from
 * Electron and Node imports so it can be shared by main, preload and renderer.
 */

import type { ShortcutPlatform } from './accelerator'

export type { ShortcutPlatform }

export type MineTier = 'bronze' | 'copper' | 'silver' | 'gold' | 'uranium'

/**
 * A raw material in the vault (see #22).
 *
 * The five tier materials are spelled exactly like the tiers that produce
 * them, because a mine yields the raw material of the tier it is on right now.
 * 'coal' is the one material no mine tier produces: it is the material of every
 * token burned BEFORE this app was installed, credited once by the historical
 * backfill and never accrued from live polling.
 */
export type Material = MineTier | 'coal'

/** Every material, poorest first — also the order a breakdown should be shown in. */
export const MATERIALS: readonly Material[] = [
  'coal',
  'bronze',
  'copper',
  'silver',
  'gold',
  'uranium'
]

/**
 * Every tier a mine can actually BE, poorest first — the materials minus the
 * one no mine produces.
 *
 * Derived rather than written out a second time, so a tier added to the vault
 * cannot be silently missing from the places that check one: the projects store
 * reads a tier back off disk against this list, and #92's boundary validation
 * checks a tier filter against it before it reaches SQL. Both would otherwise
 * keep their own copy and drift.
 */
export const MINE_TIERS: readonly MineTier[] = MATERIALS.filter(
  (material): material is MineTier => material !== 'coal'
)

/**
 * Whether an unknown value names a tier.
 *
 * Both callers are reading something they did not produce — a row off the
 * user's disk, and a filter off the IPC boundary — and both must treat an
 * unrecognised value as "no tier" rather than passing it on. Neither can use
 * the type system for it, which is why this is a value and not a cast.
 */
export function isMineTier(value: unknown): value is MineTier {
  return typeof value === 'string' && (MINE_TIERS as readonly string[]).includes(value)
}

/**
 * How many tokens ONE drawn nugget of each material stands for.
 *
 * This is a per-material grain size, NOT an exchange rate. Materials never
 * convert into one another: coal stays coal and silver stays silver for the
 * life of the vault, a mine that changes tier keeps every unit it already
 * produced, and nothing anywhere trades a cheap pile for an expensive one.
 * Each material owns an independent counter (see MaterialTotals) and this
 * table only decides how coarsely that one counter is drawn.
 *
 * So the numbers say how common an ore is, not what it is worth against
 * another: coal is cheap and plentiful, so a modest burn already shows a
 * visible heap, while a single uranium nugget stands for a hundred times the
 * work of a coal one. It is an idle-game metaphor, never billing.
 *
 * Calibration: bronze is pinned to the renderer's existing TOKENS_PER_ORE
 * (10_000, src/renderer/src/lib/economy.ts), the single rate the app shipped
 * with — so a fresh mine, which starts on the bronze tier, reads exactly as it
 * did before the vault gained materials. Tuning the whole economy means
 * editing this table and nothing else.
 */
export const MATERIAL_TOKENS_PER_UNIT: Record<Material, number> = {
  coal: 2_500,
  bronze: 10_000,
  copper: 25_000,
  silver: 50_000,
  gold: 100_000,
  uranium: 250_000
}

/**
 * Tokens accrued per material. Always carries every material (zeros included)
 * so a consumer can render a breakdown without checking for absent keys.
 *
 * One independent counter each, and they are never combined: every operation
 * in domain/materials.ts touches a single material's slot, and merging two
 * breakdowns adds coal to coal and gold to gold. There is deliberately no
 * function anywhere that turns one material into another — a vault only ever
 * grows in the materials it actually mined.
 *
 * The unit is TOKENS, not drawn nuggets: the raw count is what is cumulative
 * and persistent, and MATERIAL_TOKENS_PER_UNIT decides only how many nuggets
 * that one count is drawn as.
 */
export type MaterialTotals = Record<Material, number>

/**
 * Every provider identity the wire admits, and the ONE place a new one is
 * added (issue #78).
 *
 * The union below is derived from this table rather than written out beside
 * it, so the two cannot drift: adding a backend is one entry here, and the
 * type system then names the places that owe it something — `ProviderConfigs`
 * in main/config/config.ts will not compile without its settings block, and
 * `PROVIDER_REGISTRY` in main/providers/registry.ts will not compile without
 * its factory row. What the table cannot reach is the renderer's sprite art
 * and the CSS class per provider, which is still a switch on identity and is
 * the last of #78's four places (it waits on the UI rebuild in #105).
 *
 * The table is not an invitation: `CONTRIBUTING.md`'s evidence bar decides
 * whether a third backend exists at all. This only makes the addition cheap.
 */
export const DWARF_PROVIDERS = ['claude', 'codex'] as const

export type DwarfProvider = (typeof DWARF_PROVIDERS)[number]

/**
 * Whether an unknown value names a provider this build has.
 *
 * Same reason `isMineTier` is a value and not a cast: every caller is reading
 * something it did not produce — a `last_provider` column off the user's disk,
 * a value arriving over IPC — and an unrecognised one has to read as "no
 * provider" rather than being passed on as a guess.
 */
export function isDwarfProvider(value: unknown): value is DwarfProvider {
  return typeof value === 'string' && (DWARF_PROVIDERS as readonly string[]).includes(value)
}

/**
 * The observer that is not a provider: THIS PANEL, holding a process it
 * started over its stdio (#194).
 *
 * ## Why this is not a new DWARF_PROVIDERS entry
 *
 * Because `DwarfProvider` is a list of STORES that can be read, and this is not
 * one. Adding a member there would demand a `ProviderConfigs` block and a
 * `PROVIDER_REGISTRY` factory row for a store that does not exist, and would
 * offer a chip for a "provider" nobody can install. The two facts are on
 * different axes, so they are on different types: `DwarfProvider` is unchanged
 * and `DwarfObserver` is what a dwarf carries.
 *
 * ## Why it is not 'other' either
 *
 * `launchState.ts` keeps `OTHER_CHOICE` out of the provider union with a rule
 * that reads exactly right and must not be softened: that union "is who
 * OBSERVED a dwarf, and no observation ever comes back saying 'other'". It
 * still does not. 'other' is what a person PICKED in the chip row; 'panel' is
 * who then observed the result. #194's maintainer decision is that a process
 * the panel holds needs no session file to be observed, because the panel is
 * its stdio — so the observer has a name, and the name is not the chip's.
 *
 * ## What it costs a dwarf to carry it
 *
 * Everything a transcript would have supplied. A hosted dwarf has no store
 * behind it, so `model`, `effort`, `tokensUsed`, `tokensObserved`,
 * `silentForMs`, `transcriptUpdatedAt`, `attendance`, `waitingReason`,
 * `pendingQuestion`, `mcpServers` and `totalCostUsd` are absent — not "not
 * yet", but with nothing that could ever report them. Its mine's tier is a
 * provisional one for the same reason every unwalked mine's is. Absence is the
 * reading this app takes everywhere: absent beats guessed.
 */
export const PANEL_OBSERVER = 'panel'

/**
 * Who observed one dwarf: a provider that read its store, or the panel holding
 * the process itself.
 *
 * Named for the question it answers rather than for the field it sits in, and
 * the field keeps its own name (`Dwarf.provider`) so nothing that already reads
 * it has to be renamed to keep compiling. Every reader that must now handle a
 * dwarf no CLI produced is named by the type checker, which is the point.
 */
export type DwarfObserver = DwarfProvider | typeof PANEL_OBSERVER

/**
 * Whether a dwarf was observed by a provider at all, or is one this panel is
 * holding itself.
 *
 * A value rather than a comparison spelled out at each site, for the reason
 * `isDwarfProvider` is one: this is the question ten call sites ask, and ten
 * spellings of it is ten chances for one of them to mean something slightly
 * different.
 */
export function isPanelObserved(observer: DwarfObserver): observer is typeof PANEL_OBSERVER {
  return observer === PANEL_OBSERVER
}

/**
 * The providers a session can be HELD for — kept open by this app, over the
 * provider's own Agent SDK stream (#168).
 *
 * On the wire because both processes act on it and must not disagree: the
 * renderer reads it to choose which launch channel a chip goes down, and the
 * held registry enforces it. Two copies of this list would be two answers to
 * "can this provider be watched", and the panel would eventually offer a chip
 * whose only outcome is a refusal from the other side.
 *
 * Claude alone, and this is a capability rather than a preference: holding a
 * session IS that stream, and Codex has no held-session engine in this app —
 * `docs/command-surface-evaluation.md` records it, and the question-capture
 * matrix marks the `codex exec` row No for live capture and No for answering.
 * A provider missing here can still be LAUNCHED; it is started detached and
 * discovered by the ordinary poll, which is a real launch and simply not a
 * watched one.
 */
export const HELDABLE_PROVIDERS: readonly DwarfProvider[] = ['claude']

/**
 * Every connection state the Agent SDK reports for one MCP server (issue
 * #96), read verbatim off a held session's own `init` message.
 *
 * The CLI's `init` message types `mcp_servers[].status` as a plain `string` —
 * but the SDK's own control-request surface (`mcpServerStatus()`) types the
 * same status as this closed five-member enum, and issue #96's live-fire
 * spike observed only members of this set across seven real servers on a
 * real session (three flavours of `needs-auth` among them, correcting an
 * earlier assumption that a fresh install would report none configured). So
 * this app treats the field as the closed set the SDK's own typed surface
 * promises, not as the open string its `init` message declares.
 */
export const MCP_CONNECTION_STATUSES = [
  'connected',
  'failed',
  'needs-auth',
  'pending',
  'disabled'
] as const

export type McpConnectionStatus = (typeof MCP_CONNECTION_STATUSES)[number]

/**
 * Whether an unknown value names a status this build's MCP enum admits.
 *
 * Same reason `isMineTier`/`isDwarfProvider` are values and not casts: this
 * reads a field the CLI itself only TYPES as a string, so an unrecognised
 * value has to read as "not this enum" rather than being passed on as a
 * guess — the boundary-validation discipline `WaitingReason`'s three closed
 * values already hold.
 */
export function isMcpConnectionStatus(value: unknown): value is McpConnectionStatus {
  return typeof value === 'string' && (MCP_CONNECTION_STATUSES as readonly string[]).includes(value)
}

/**
 * One MCP server a held session's own protocol messages named, and the CLI's
 * own connection state for it (issue #96) — never text this app parsed out
 * of `/mcp`'s prose output, which has no structured route for a session this
 * app does not hold (see docs/command-surface-evaluation.md §2a).
 */
export interface DwarfMcpServerStatus {
  name: string
  status: McpConnectionStatus
}

/**
 * A dwarf's rank, which is TOPOLOGY read off the spawn tree and never a title
 * anything scripted (#86, #157).
 *
 * Depth decides, and it is derived from what a provider actually observed on
 * the poll that reports it:
 *
 * - `foreman` — the root of the tree, the session a human could address
 *   directly. A root that has coordinated is a foreman whether or not it
 *   currently has agents out: the rank is what it IS, not a headcount, and
 *   deriving it from one made the same dwarf swap identity mid-session (see
 *   claudeProvider).
 * - `worker` — spawned by the root. Depth 1.
 * - `worker2` — spawned by a WORKER, and recursively by anything below one.
 *   Depth 2 and deeper, at every level: the tree keeps going, the rank does
 *   not, because a fifth rank per level would be a drawing nobody could read.
 *
 * A depth this app could not establish falls to `worker`, never to `worker2`:
 * being deeper is the stronger claim, and claiming it needs the proof. That is
 * the same direction absence is read in everywhere else here — an absent
 * pendingBackgroundAgentCount is not a count of zero.
 *
 * Rank is not attendance. Every rank below the root is headless BECAUSE it is
 * spawned, which is the one thing rank proves and the reason it may shorten a
 * silence window (see dwarfSilenceWindowKey); a root's keyboard is a separate
 * fact carried by DwarfAttendance.
 */
export type DwarfRole = 'foreman' | 'worker' | 'worker2'

/**
 * working: actively producing (busy). waiting: session alive but paused/awaiting
 * (a resting dwarf). leaving: present in the previous runtime tick but its
 * agent finished/disappeared — kept for a grace period, then dropped.
 */
export type DwarfStatus = 'working' | 'waiting' | 'leaving'

/**
 * What a blocked agent is blocked ON, normalized across providers (issue #60).
 *
 * Derived ONLY from a provider's own structured evidence, of which there are
 * two kinds and no third. Its lifecycle record — Claude Code's registry
 * `waitingFor` — is the only one that can make this a value at all, because it
 * is the thing that watched the session stop. Its structured record of an ask,
 * where the agent itself enumerated in schema the question and the answers it
 * would take (see DwarfQuestion), may then name a condition that lifecycle
 * record left 'unknown', and may do nothing else: it refines a proof, never
 * manufactures one.
 *
 * Prose remains forbidden outright, and nothing above softens it. A question
 * mark in a speech bubble, a sentence that reads like a request, an agent that
 * has simply gone quiet — none of them may ever produce a value here. An agent
 * waiting on a human writes nothing at all, so prose is exactly the signal that
 * is absent when it matters, and reading it would make the panel claim a thing
 * it cannot know. A question asked as plain prose therefore stays uncaught,
 * which is where the line falls rather than a gap in it.
 *
 * 'user-input' is the only value that carries a behavioural promise: while it
 * is active the agent is exempt from age-based eviction whatever its role's
 * silence window says (see DWARF_SILENCE_WINDOW_MS). It therefore means one
 * narrow thing — a human has been asked a question and the session cannot move
 * until it is answered — and never "probably blocked on someone".
 *
 * 'unknown' is the honest middle: the provider proved the session is blocked
 * but named no condition this table recognizes. Nothing may TREAT it as
 * 'user-input' — a second structured proof REPLACING it is a different move,
 * and the only one allowed. The same shape has been decided twice already in
 * this codebase — absence of a `pendingBackgroundAgentCount` is not a count of
 * zero, and `tierOf`'s placeholder must never seal a ledger delta — and this
 * is the third: absence of proof is not proof, in either direction.
 *
 * Deliberately three values, not four. The issue also suggested a 'tool'
 * reason for a long tool call, and nothing on this machine writes evidence of
 * one: Claude's registry vocabulary has no such condition and Codex writes no
 * blocked record at all. A member no provider can produce is a claim with
 * nothing behind it, and adding one later is purely additive.
 *
 * Absent (no value at all) is a fourth reading and a different one: the agent
 * is not blocked, or its provider proves nothing either way.
 */
export type WaitingReason = 'user-input' | 'approval' | 'unknown'

/**
 * The one waiting reason that means a human has actually been asked something
 * and the session cannot move until they answer.
 *
 * Two rules key off exactly this value and no other, and it is named once here
 * rather than restated in each: the provider suspends age-based eviction while
 * it is active (see DWARF_SILENCE_WINDOW_MS), and the panel puts the dwarf on
 * its awaiting-answer loop. Both live on the wire contract for the reason the
 * silence windows do — a provider and a panel that each decided this for
 * themselves could disagree, and the panel would then say one thing about a
 * dwarf while the provider acted on another.
 */
export const WAITING_ON_HUMAN_REASON: WaitingReason = 'user-input'

/**
 * Whether a human could be sitting at this session, as its provider observed
 * it — never as anything downstream inferred (issue #68).
 *
 * Three values for the reason WaitingReason has three. 'attended' and
 * 'unattended' are both positive findings, read from a provider's own
 * structured record of how the session was started: Claude Code writes `kind`
 * on its registry entry, Codex writes `thread_source` on its thread. 'unknown'
 * is the honest middle — the provider was asked and proved nothing, or was
 * never taught to answer — and it is the third statement of a rule this
 * codebase has settled twice before: an absent pendingBackgroundAgentCount is
 * not a count of zero, and tierOf's placeholder may not seal a ledger delta.
 *
 * It must therefore never behave like a proven value in EITHER direction. The
 * window it draws (see dwarfSilenceWindowMs) is the generous one, but that is
 * a deliberate choice about which error costs more, not an equivalence: nothing
 * that RECORDS a decision may resolve 'unknown' into 'attended'.
 *
 * Deliberately not a boolean, and deliberately not derived from rank: role
 * comes from topology, so every root session is a foreman whether or not there
 * is a keyboard in front of it.
 */
export type DwarfAttendance = 'attended' | 'unattended' | 'unknown'

/**
 * How long a dwarf has to have produced nothing before its silence is worth
 * showing (issue #47).
 *
 * These are the SAME windows the Claude provider's staleness rule judges a
 * remembered launch by (issue #40), which is the whole point of them living
 * here: the panel must never say "still working" about a dwarf the provider has
 * already started counting out. Read them through dwarfSilenceWindowMs, do not
 * re-invent them and do not pick between them by hand.
 *
 * They differ because the two silences are not equally telling, and collapsing
 * them into one number would lose the distinction. A session A HUMAN CAN TYPE
 * INTO legitimately sits idle for as long as it takes them to write the next
 * prompt, so its silence is weak evidence and gets the longer hour. A session
 * NOBODY IS AT cannot wait on anyone: once launched it runs to completion, so
 * silence from its own transcript is strong evidence and half an hour says
 * enough.
 *
 * Keyed on the keyboard rather than on the rank since issue #68. It used to say
 * `foreman` and `worker`, which read as the same distinction and is not: role
 * is topology, so a headless `claude -p` run is a root, is therefore a foreman,
 * and was drawing the hour that exists for a human who was never there.
 *
 * A dwarf past its window is NOT in a different state — see Dwarf.silentForMs.
 */
export const DWARF_SILENCE_WINDOW_MS: Record<'attended' | 'unattended', number> = {
  attended: 60 * 60 * 1000,
  unattended: 30 * 60 * 1000
}

/**
 * The window this dwarf's silence is judged against — the single entry point
 * to the two numbers above, so the provider's staleness rule and the panel can
 * never disagree about which one a dwarf gets (issue #68).
 *
 * Role is still consulted, in one direction only: ANY RANK BELOW THE ROOT is a
 * spawned subagent with no channel of its own, so topology there does not stand
 * in for the fact, it proves it — no human can be typing into something nothing
 * outside its parent can even address. Rank may therefore shorten the window
 * and may never lengthen it, which is why a provider claiming 'attended' about
 * a worker changes nothing.
 *
 * Said as "not a foreman" rather than as a list of the spawned ranks (#157):
 * `worker2` is exactly as headless as a `worker` — it is spawned BY one — and a
 * list would have had to be remembered here for it to stay true. A rank added
 * later inherits the shorter window until it argues for the longer one, which
 * is the safe direction: only a root can have a human in front of it.
 *
 * Everything else rests on attendance, and both unproven readings — 'unknown'
 * and the field being absent — keep the hour. The two errors are not
 * symmetric: shortening the window on a session someone is typing into makes
 * the panel call a live dwarf silent, which is the false departure #28 and #40
 * exist to prevent, while leaving the hour on a headless run only makes the
 * panel slow to notice. Generous is the side this repository has always taken
 * when the evidence runs out.
 */
export function dwarfSilenceWindowMs(role: DwarfRole, attendance?: DwarfAttendance): number {
  return DWARF_SILENCE_WINDOW_MS[dwarfSilenceWindowKey(role, attendance)]
}

/**
 * WHICH of the two windows this dwarf gets, without saying how long it is.
 *
 * The rule above lives here, and dwarfSilenceWindowMs is a lookup on top of it,
 * so there is still exactly one place that decides. The separate name exists
 * for the one caller that does not want the product's numbers: the Claude
 * provider's staleness rule takes both windows as injected options, so its
 * tests can cross an hour without waiting one, and it must make the SAME choice
 * against its own pair. Without this it would have to restate the rule, which
 * is how a provider and a panel start disagreeing about the same dwarf.
 */
export function dwarfSilenceWindowKey(
  role: DwarfRole,
  attendance?: DwarfAttendance
): 'attended' | 'unattended' {
  return role !== 'foreman' || attendance === 'unattended' ? 'unattended' : 'attended'
}

/**
 * How a live session can be handed a typed message.
 *
 * terminal: the session owns a console window — keystrokes are injected into it.
 * claude-relay: the session is headless but addressable by name, so a one-shot
 *   `claude -p` turn delivers the text over Claude Code's cross-session messaging.
 * foreman-relay: the dwarf is a subagent with no channel of its own; the text
 *   goes to its foreman (parent session) under an explicit `[for agent X] ` prefix.
 * codex-queue: the session is a Codex thread whose own message queue accepts an
 *   item addressed by thread id, so `codex queue` hands it over without any
 *   window, pid or console (#97).
 * held-session: THIS PANEL is holding the session's own stream open, so the text
 *   goes onto that stream in-process — no window, no pid, no relay turn (#210).
 * launched-process: THIS PANEL started that session detached and still holds the
 *   process it started, so the session can be ENDED — and only ended (#217). The
 *   one channel that carries no message at all: `codex exec` reads one prompt
 *   from stdin and exits with its turn, so there is no inbox behind it and no
 *   process left to read one. It is `cancel` without `sendText`, the mirror of
 *   the queue's `sendText` without `cancel`.
 *
 * held-session outranks every other channel for the same dwarf, and that
 * ordering is the fix #210 exists for: an SDK-hosted session registers as
 * `kind: "interactive"`, which made the provider offer the SDK child's pid — a
 * process owning no window — and then a relay a session with no REPL never
 * drains. Ownership is a fact about who holds the stream, so it is resolved
 * before any question about what kind of endpoint exists.
 *
 * A ✓ means the same thing on every one of them and nothing more: handed over.
 * It is worth restating for the queue, because that tier is the one where the
 * gap is visible — a queued item is persisted immediately and drained at the
 * thread's next idle boundary (6-8s in the one measured run), so the panel is
 * reporting a durable hand-over, never that anything has read it. held-session
 * is the one tier with nothing between the hand-over and the session: it is the
 * session's own input stream, which is also why it has no second channel to
 * fall back to and says so instead. Only the renderer's observed-reaction rule
 * may ever say more (see reaction.ts).
 *
 * A dwarf with no channel at all simply carries no value.
 */
export type TextDeliveryChannel =
  | 'terminal'
  | 'claude-relay'
  | 'foreman-relay'
  | 'codex-queue'
  | 'held-session'
  | 'launched-process'
  /**
   * The stdin of a process this panel is HOLDING (#194) — the one channel that
   * is a pipe rather than a store, a window or a queue.
   *
   * Told apart from `'launched-process'` on purpose, because the two are
   * opposite halves of the same distinction. A launched process had its stdin
   * CLOSED right after its prompt, so it takes no messages and can only be
   * ended; a hosted process still has its stdin open in this process's hands,
   * so it takes messages and can be ended. That is the whole reason hosting is
   * worth its lifetime cost.
   *
   * What reaches it is still only `delivered`, never `reacted`: bytes went into
   * a pipe. Whether anything read them is a fact no hosted process can report,
   * because there is no transcript to watch — see the reaction rule in the
   * renderer's reaction.ts, which this channel can never promote past.
   */
  | 'hosted-stdin'

/**
 * One answer an agent said it would accept, in its own words.
 *
 * `label` is the whole answer — what a human would press and what a reply would
 * have to name — so an option that carried none was never offered here. The
 * description is the agent's own gloss on it, and both are display text: they
 * pass redaction at the provider boundary like every other transcript string.
 */
export interface DwarfQuestionOption {
  label: string
  description?: string
}

/**
 * A question an agent asked its user and that nothing has answered yet
 * (issue #94).
 *
 * This is NOT the prose the WaitingReason comment above bars. The rule there is
 * about inferring a blocked state from text — a question mark, a sentence that
 * reads like a request — and it stands. What crosses here is a provider's own
 * structured record of an ask: Claude's AskUserQuestion tool call, where the
 * model enumerates in schema the question and the answers it will take. The
 * panel is not guessing what was asked; it is repeating what the agent stated.
 * A question asked as plain prose produces no such record and stays uncaught,
 * which is exactly the line the prohibition draws rather than a gap in this.
 *
 * Carrying a question may REFINE waitingReason and may never assert it. Blocked
 * and blocked-on-what are two different facts from two different sources, and
 * neither may claim the other's: this field says an ask is outstanding, the
 * registry says whether the session can still move. So where the provider
 * proved a session blocked and named no condition it recognized, an outstanding
 * ask names it; where the provider proved nothing, no reason appears however
 * many asks are open, because an ask inside a running turn is the model still
 * working rather than a human being waited on.
 *
 * `toolUseId` is what makes the round trip observable — the answer is written
 * back as a result naming the same id, so "answered" is matched rather than
 * inferred, which is the evidence `delivered` versus `reacted` has been missing
 * (see the renderer's reaction.ts).
 *
 * Absent means one of two things and deliberately does not distinguish them:
 * nothing is being asked, or the ask is older than the provider's transcript
 * window. Truncation can only hide a question, never invent one — see
 * ClaudeTranscriptInfo.pendingQuestion for why that asymmetry holds — so a
 * missing field is a miss, never a false claim.
 */
export interface DwarfQuestion {
  toolUseId: string
  question: string
  /** The agent's own short title for the ask, when it wrote one. */
  header?: string
  /** Whether the agent said it would accept more than one option. */
  multiSelect: boolean
  options: DwarfQuestionOption[]
  /** When the ask was written, as the provider recorded it. */
  askedAt?: string
}

/**
 * A tool call a held session is blocked on until somebody approves it (#203).
 *
 * A SIBLING of DwarfQuestion, deliberately not a variant of it. That type's
 * contract is that the panel repeats the agent's own words — the question and
 * the answers the model enumerated. A permission prompt is the other way
 * round: the model wrote nothing to choose between, and the two answers are
 * Claude Code's, fixed for every prompt. Folding one into the other would have
 * meant a `DwarfQuestion` whose option labels this app invented, which is the
 * one thing that type promises never happens.
 *
 * Held sessions ONLY, and that is structural rather than a gap: the prompt
 * reaches this app through the Agent SDK's `canUseTool` callback, which is
 * the one route on this machine that carries a permission request as data
 * and takes a decision back. An observed session's transcript records the
 * `tool_use` but not the prompt, and its hook says only that *a* prompt is
 * open (`permission_prompt`) — see docs/question-capture-evaluation.md §4.
 *
 * `title` and `description` are the CLI's own rendering of the prompt
 * ("Claude wants to run …"), passed through when the bridge supplied them and
 * absent otherwise; nothing here is composed from prose. `input` is a compact,
 * redacted reading of the tool's structured input — the command, the path,
 * or the whole input as JSON — capped so a pasted file never becomes the
 * card. `toolUseId` makes the round trip observable exactly as it does for an
 * ask: the decision is released against this id and no other.
 */
export interface DwarfPermissionRequest {
  toolUseId: string
  /** The tool the agent wants to run, as the CLI named it. */
  toolName: string
  /** The CLI's own prompt sentence, when it rendered one. */
  title?: string
  /** The CLI's own subtitle for the prompt, when it rendered one. */
  description?: string
  /** A compact, redacted rendering of the tool's input. */
  input: string
  /** When this host received the prompt — the only honest clock there is. */
  askedAt: string
}

/**
 * The two answers a permission prompt takes. Claude Code's own vocabulary,
 * and deliberately not its third one: "always allow" writes a rule into the
 * user's settings, and this slice offers nothing that outlives the prompt.
 */
export type DwarfPermissionDecision = 'allow' | 'deny'

export interface Dwarf {
  id: string
  /**
   * Who observed this dwarf — a provider that read its store, or `'panel'` for
   * a process this panel is holding over stdio (#194). See DwarfObserver for
   * why a hosted process is an OBSERVER value and not a provider one, and for
   * the complete list of what a dwarf carrying `'panel'` cannot say.
   */
  provider: DwarfObserver
  role: DwarfRole
  name: string
  /**
   * Whichever provider observed it: Claude's transcript tail for an observed
   * session, or (issue #96) a held session's own `init` message, which
   * arrives on every turn and supersedes whatever the tail last read.
   */
  model?: string
  /** Same provenance as `model` — a held session's `init.effort` is a second writer, not a new field (issue #96). */
  effort?: string
  status: DwarfStatus
  /**
   * What this agent was asked to do, in whatever form its provider states it
   * as a FIELD — never prose anything here parsed out of a transcript.
   *
   * Three writers, one meaning. A Claude subagent's is the `description` its
   * spawning tool call carried; a held session's crew member's is the same
   * string off `task_started`; and a Codex sub-agent's is the `agent_path` of
   * its spawn blob (`/root/audit_chain_report`), which is the only field that
   * states its objective at all — a Codex child thread is a FORK, so the first
   * `user` record in its own rollout is the HUMAN's original prompt rather
   * than the instruction its parent gave it (#218).
   *
   * Carried verbatim, agent_path included: prettifying `/root/…` into a
   * sentence would be this app writing an objective rather than repeating one.
   */
  description?: string
  /**
   * The id of the dwarf that spawned this one, when the provider saw it — the
   * parent EDGE (#189, #218). Always a `Dwarf.id`, never a raw provider
   * session or task id, so one board lookup crosses no translation.
   *
   * The field docs/session-topology-and-roles.md §6 proposed, landed early
   * because two issues needed the edge before the rank redesign around it
   * does. That design pairs it with a `topology` verdict; nothing here reads
   * one, and whoever lands `topology` should read THIS field rather than add a
   * second name for the same fact.
   *
   * A dwarf id is not a family tree. It reads like one for a Claude subagent,
   * whose id is its session's plus its own agent id, and `launchingAgentOf`
   * used to slice it at the last colon to name a launcher. That answer is
   * right for exactly one shape and wrong for the rest: a `worker2` is depth 2
   * OR DEEPER, so the prefix names the SESSION it belongs to rather than the
   * agent that spawned it, and a Codex sub-agent's id is `codex:<uuid>`, whose
   * prefix is a PROVIDER's name and no agent at all. An id prefix is not an
   * edge; this is.
   *
   * ABSENT MEANS UNKNOWN, and unknown stays unattributed. #175's contract is
   * that a message with no issuer is the human's, so a wrong issuer is a worse
   * claim than none: every provider that has not observed a spawn — and every
   * session root, which really was launched by a person — carries no value.
   */
  parentId?: string
  lastMessage?: string
  sessionId: string
  pid?: number
  startedAt?: number
  /**
   * Cumulative tokens the session has spent, when the provider knows it.
   * Codex records it on its registry row; Claude does not expose an equivalent.
   */
  tokensUsed?: number
  /**
   * Tokens observed for the ore/vault economy (see Mine.tokensObserved): a
   * lightweight, honest approximation of what this dwarf has burned — never
   * exact billing. Codex mirrors tokensUsed; Claude accumulates a monotonic
   * runtime-lifetime counter from the latest usage block seen in its bounded
   * transcript tail (see ClaudeProvider).
   */
  tokensObserved?: number
  /**
   * How long THIS agent's own transcript has gone unwritten, in milliseconds
   * (issue #47). A worker is measured against its own subagent file, a foreman
   * against its session transcript — never against each other's.
   *
   * Deliberately a measurement rather than a state. Silence is not something
   * the agent is doing; it is how much confidence we have that it still
   * exists, so it sits beside `status` instead of inside it — the ledger, the
   * delivery channels and the capability matrix all key off DwarfStatus, and a
   * fourth value there would change what the app BELIEVES about a dwarf rather
   * than only what it shows. The panel layers a pose and a tooltip line over an
   * unchanged `working` (see DWARF_SILENCE_WINDOW_MS).
   *
   * Absent where no such evidence exists — Codex writes no equivalent
   * per-subagent file — which means "not known", never "just spoke". A clock
   * running behind a filesystem timestamp floors at 0 rather than going
   * negative.
   */
  silentForMs?: number
  /**
   * The transcript's own last-write time, in epoch ms (issue #183) — the raw
   * mtime `silentForMs` turns into an age, published a second time for a
   * caller that needs the tail to have MOVED rather than how long ago.
   *
   * `silentForMs` cannot serve that job: it is `now - mtimeMs`, so it changes
   * on every poll purely because the clock keeps advancing, whether or not a
   * writer ever touched the file. Watching it would re-read a transcript on
   * every idle poll — the exact disk cost the renderer's feed watch exists to
   * avoid (see App.vue). The raw mtime changes only when a writer actually
   * appends, whoever that writer is — a human turn typed into the terminal
   * included, which `lastMessage` alone cannot say because it only reports the
   * ASSISTANT's side.
   *
   * Same absence rule as `silentForMs`: no such evidence is no key at all,
   * never a value a real write could also have produced.
   */
  transcriptUpdatedAt?: number
  /**
   * Whether anyone could be typing into this dwarf's session (issue #68), which
   * is what decides how long its silence above is given the benefit of the
   * doubt — see dwarfSilenceWindowMs.
   *
   * Read from the provider's own record of how the session was started, never
   * from rank: `role` answers a question about the spawn tree, and a headless
   * run is still the root of its own. Absent from a provider that has not been
   * taught to report it, which reads as 'unknown' rather than as either proof.
   */
  attendance?: DwarfAttendance
  /**
   * Why this dwarf is blocked, when its provider proved it (issue #60).
   *
   * Only a dwarf whose provider writes a structured blocked condition ever
   * carries one — today that is a Claude main session and nothing else. A
   * Claude subagent never does: its sidecar records no status at all, so a
   * worker's absence of a reason is absence of evidence rather than proof it
   * is unblocked. Codex writes no blocked record of any kind.
   *
   * Sits beside `status` rather than inside it, exactly as `silentForMs` does:
   * a blocked dwarf is already `waiting`, and a fourth DwarfStatus would change
   * what the ledger, the delivery channels and the capability matrix believe
   * about it rather than only what the panel shows.
   */
  waitingReason?: WaitingReason
  /**
   * What this dwarf's agent asked its user, when the agent asked it through a
   * structured channel and nothing has answered it yet (issue #94).
   *
   * Sits beside `waitingReason` and may only refine it, for the reason
   * DwarfQuestion spells out: an outstanding ask and a blocked session are two
   * facts with two sources. Today only a Claude session can produce one; Codex
   * writes no equivalent, and a dwarf without the field is never "not asking",
   * only "not shown to be" — so its absence never unsets a reason either.
   */
  pendingQuestion?: DwarfQuestion
  /**
   * The tool call this dwarf's held session is blocked on until the panel
   * approves or declines it (#203). Beside `pendingQuestion` rather than
   * inside it — see DwarfPermissionRequest for why the two are siblings —
   * and the two may be open at once: several tool calls in one assistant
   * message each prompt on their own id. Absent means nothing is waiting, or
   * this is not a session the panel holds; the field cannot tell the two
   * apart and does not try to.
   */
  pendingPermission?: DwarfPermissionRequest
  /**
   * The channel a typed message would travel through right now, resolved by
   * the runtime on every poll. Absent means the panel must offer no send
   * action for this dwarf (see TextDeliveryChannel).
   */
  textDelivery?: TextDeliveryChannel
  /**
   * What the action menu can offer for this dwarf right now, resolved by the
   * runtime on every poll alongside textDelivery. Absent has the same meaning
   * as every field being null: no provider channel was reachable at all.
   */
  capabilities?: DwarfCapabilities
  /**
   * Every MCP server a held session's own `init` message has named, and its
   * connection status, refreshed on every turn (issue #96).
   *
   * Held sessions ONLY: no other session type this app runs has any
   * structured route to a server's connection health — an observed session's
   * transcript never carries it, and the CLI's own text commands are the
   * "screen-scraping wearing a different hat" #96 explicitly declined
   * (docs/command-surface-evaluation.md §2a). Absent means one of two things
   * and deliberately does not distinguish them: this is not a held session, or
   * it is one whose first `init` has not arrived yet — the same asymmetry
   * DwarfQuestion's own doc comment draws for its absence.
   */
  mcpServers?: DwarfMcpServerStatus[]
  /**
   * The running cost, in USD, of the WHOLE held session's `query()` call, as
   * of its most recently read `result` message — never a per-turn figure, and
   * never something this panel computed (issue #96). The SDK's own doc
   * comment on `total_cost_usd` says why a later value REPLACES this one
   * rather than adding to it: "cumulative across turns in streaming-input
   * sessions — each result carries the running total so far, so read the
   * latest result rather than summing across results... an estimate, not a
   * billing statement." Issue #96's live-fire spike confirmed this live,
   * twice over: the structured usage call's own running total matched the
   * plain `result.total_cost_usd` from the same turn exactly.
   *
   * Held sessions ONLY, for the same reason `mcpServers` is: every other
   * session type this app runs has tokens at best, never a dollar figure (see
   * docs/command-surface-evaluation.md §2a). A different unit from every
   * material the vault tracks (see MATERIAL_TOKENS_PER_UNIT) — additive,
   * never converted into materials or vice versa, for the reason materials
   * never convert into one another.
   */
  totalCostUsd?: number
  /**
   * The exchange this panel itself watched go by on a stream it is HOLDING
   * (#159, #194) — the prompt it sent to start the session, and every message
   * the stream has carried since, oldest first.
   *
   * Sessions this panel HOLDS only, for the reason `mcpServers` is: nothing
   * else this app runs hands it a conversation live. An observed session's
   * words are read from its transcript on demand instead (see
   * DwarfFeedResult), and the two are deliberately different fields because
   * they are different claims — this one is first-hand, that one is a bounded
   * tail somebody else wrote.
   *
   * Two things hold a stream, and both write here. A held Claude session's
   * conversation is its own structured messages off the Agent SDK stream; a
   * hosted process's is the plain text captured off its stdout and stderr
   * (#194). Same claim in both cases — this panel saw these bytes go past —
   * and it is deliberately the ONE field a hosted dwarf shares with a held one,
   * because it is the only fact hosting actually establishes.
   *
   * Bounded at both ends, and the bound is the point: at most
   * HELD_CONVERSATION_LIMIT messages, each at most HELD_MESSAGE_MAX_CHARS
   * long, because this rides every poll's snapshot. Absent means one of two
   * things and deliberately does not distinguish them: this is not a held
   * session, or it is one that has yet to say anything.
   */
  conversation?: FeedMessage[]
  /**
   * The receipt of a launch the Add Panel made itself, once main has PROVED
   * this dwarf is that launch's session (#191).
   *
   * Why the panel needs one at all: submitting has to hand over to this
   * dwarf's MessagePanel, and the launch verdict deliberately carries no dwarf
   * id — the session's id is not known at that moment, and claiming one there
   * would be the second observation path #86 refuses. A HELD launch leaves its
   * receipt on the board already, because the registry seeds the new session's
   * conversation with the exact prompt that was sent, so `conversation[0]` IS
   * the evidence. A DETACHED launch leaves no conversation, and for a long
   * time that left the panel with nothing to recognise: it stopped at "the
   * session started" and never handed over.
   *
   * The third source of evidence is the session's own transcript, whose first
   * human turn is the prompt the launch wrote to that child's stdin. Main
   * performs that match — read once at the head of the file, off the poll,
   * never on it — and publishes only its VERDICT here. The prompt itself stays
   * in main: the comparison is between two strings main holds, so it is exact
   * rather than a reading of a redacted feed, and the renderer's matching logic
   * never has to hold the user's text at all.
   *
   * An id of the LAUNCH, never of the dwarf and never of the session, and that
   * is what keeps it out of #86's way: the panel is not told which dwarf its
   * launch became, it recognises the one carrying the receipt it was given.
   * Absent means what it says — this app did not launch this session, or has
   * not proved that it did. Evidence, never timing: "the dwarf that was not
   * here a moment ago" would adopt whatever happened to start next.
   */
  launchId?: string
}

/**
 * Per-dwarf action capability matrix. Each member names the channel that
 * capability would use, or null when there is no way to offer it right now —
 * the action menu renders every button unconditionally and disables the ones
 * that resolve to null, with a reason, instead of hiding them.
 */
export interface DwarfCapabilities {
  /** Same channel model as textDelivery; kept here too so the matrix is self-contained. */
  sendText: TextDeliveryChannel | null
  /**
   * Cancelling reuses whichever channel sendText would use — a terminal gets a
   * raw interrupt keystroke instead of typed text, a relay tier gets a fixed
   * instruction instead of the user's message.
   *
   * It used to be null exactly when sendText was null; that stopped being true
   * the moment a channel could do one and not the other, and both directions
   * now exist. A Codex thread's queue delivers and cannot interrupt a turn
   * (#97), so cancel is null beside a working sendText. A process this panel
   * launched can be ended and takes no messages (#217), so sendText is null
   * beside a working cancel — and there the act is harsher than everywhere
   * else: it ends the SESSION rather than the turn, which the panel has to say
   * out loud. Read both halves; neither implies the other, and
   * resolveKickDelivery remains the one place the cancel rule lives.
   */
  cancel: TextDeliveryChannel | null
  /**
   * Always null in v1: no provider exposes a channel to change a running
   * session's effort. Modeled now so a future channel plugs in without a UI change.
   */
  adjustEffort: null
}

export interface Mine {
  id: string
  path: string
  name: string
  tier: MineTier
  dwarfs: Dwarf[]
  /** Sum of every dwarf's tokensObserved currently in this mine — the ore this mine has produced. */
  tokensObserved: number
  /**
   * Cumulative tokens this mine has yielded, split by the material in force
   * when each delta was observed (see #22).
   *
   * Unlike tokensObserved — a live gauge recomputed from the dwarfs visible
   * this instant — these totals are read from the persisted ledger: they
   * survive a dwarf leaving and an app restart, and a tier upgrade starts a
   * NEW material bucket rather than reinterpreting the old ones.
   *
   * Optional only so that renderer code written before the vault UI landed
   * still compiles; the main process always stamps it onto the wire.
   */
  materials?: MaterialTotals
  updatedAt: number
  /**
   * True when the USER put this mine on the board (#85) rather than the app
   * discovering it from a running session.
   *
   * Absent is the ordinary case and means discovered — the panel offers to undo
   * a declaration only where this is true, and a mine that is both declared and
   * currently being worked is still ONE mine carrying this flag. It is not a
   * second identity: the id is `mineIdForPath` either way, which is what lets
   * whatever the ledger already accrued for the path attach to it.
   */
  declared?: boolean
  /**
   * Which of the world map's spawn locations this mine stands on (#136), from
   * `1` to `MAP_SPAWN_SITE_COUNT`.
   *
   * A remembered fact, not a computed one: main reads it from the projects
   * store, which chose it once, at random from the locations nobody held, and
   * never moves it again. That is the whole reason it crosses the wire — the
   * renderer could hash the id and get a stable position for free, but it would
   * be a DIFFERENT position after any change to the hash or the site list, and
   * the design says closing and reopening the app must not move a mine.
   *
   * Absent means nobody has placed this mine: a project that predates the
   * column, one the store has not written yet, a valley whose locations are all
   * taken, or a simulated one that never touches the store at all. The renderer
   * places those itself, deterministically, and nothing is persisted.
   */
  mapSite?: number
  /**
   * True when the projects store holds no row for this mine (#165).
   *
   * The map draws the BOARD and the Mines list draws STORE ROWS, so the two
   * could disagree: a mine reached the board with no card beside it and the
   * third acceptance run photographed the gap. They are one world, and this is
   * the fact that joins them — the list surfaces every board mine the store has
   * no row for, built from the board itself and marked as unrecorded, so no
   * mine on the map is missing from the list.
   *
   * Three kinds reach here, and none of them is an error: a mine whose crew is
   * only leaving or waiting, which the observer deliberately does not count as
   * a sighting; a project in the poll or two before its first row is written;
   * and a simulated valley, which never touches the store at all (#42).
   *
   * ABSENT IS NOT FALSE. It means main could not say — a store that has never
   * answered has recorded nothing and knows nothing, and stamping every mine
   * unrecorded on that reading would put the whole board in the list twice
   * over. Only a mine main can positively say is missing carries this.
   */
  unrecorded?: boolean
}

/**
 * How many spawn locations the world map defines (#136).
 *
 * The design fixes it at 74 and the extraction found exactly 74. It is here,
 * rather than beside the coordinates, because both processes need it and only
 * one of them needs where the locations ARE: main chooses a site id from this
 * range and the renderer looks its coordinates up. `MAP_SPAWN_POINTS` in the
 * renderer is checked against this number, so the two cannot drift.
 */
export const MAP_SPAWN_SITE_COUNT = 74

/**
 * busy: a turn is actively running. waiting: the session is alive but provably
 * blocked on a known external condition — user input, an open dialog, an
 * approval — reported only from structured provider lifecycle evidence, never
 * inferred from assistant text (issue #34). idle: between turns. A provider
 * that cannot prove blockage simply never reports waiting.
 */
export type SessionStatus = 'busy' | 'waiting' | 'idle'

export interface ProviderSnapshot {
  provider: DwarfProvider
  sessionId: string
  cwd: string
  status: SessionStatus
  dwarfs: Dwarf[]
  updatedAt: number
}

/**
 * WHO issued one message, when it was not the human (#175).
 *
 * An agent's prompt to the agent it launches is written down exactly as a
 * human's is — the same `user` record in the same transcript — so authorship
 * was being read off a message's POSITION rather than off any evidence, and
 * the panel drew a coordinator's instruction to its worker under the user's
 * own face.
 *
 * A field beside the role rather than a third value inside it. `role` is what
 * every consumer switches on to say which HALF of an exchange a message is, and
 * a third value would make every one of those switches wrong until it was
 * widened — for a message that is not a third KIND at all, only a `user` turn
 * with its author named. So ABSENT MEANS THE HUMAN, and it has to: every
 * message already on the wire and every line an observed session's transcript
 * yields carries no issuer and keeps meaning precisely what it meant.
 *
 * Rank and name both, because both are how this app draws an agent — the rank
 * picks the portrait and the name is who the instruction came from.
 */
export interface MessageIssuer {
  role: DwarfRole
  name: string
}

export interface FeedMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: string
  /**
   * Who issued a `user` turn that no human typed (#175). Absent is the
   * ordinary case and means the human — see MessageIssuer.
   */
  issuer?: MessageIssuer
}

/**
 * What one dwarf's transcript last said, for a session this panel only
 * OBSERVES (#159) — the same bounded tail the activation fallback has always
 * read, on a channel of its own so the message panel can ask for it without
 * first failing to focus a window.
 *
 * `readable: false` and an empty list are two different facts and are kept
 * apart on purpose: the first says this session type keeps nothing this panel
 * can read, the second says it does and has written nothing yet. A panel that
 * blurred them would show "no activity" for a session it never had a way to
 * read at all.
 */
export interface DwarfFeedResult {
  readable: boolean
  messages: FeedMessage[]
}

/**
 * How many of one dwarf's messages the Mine History panel shows at most
 * (#192, `screens/history.md`: "up to that dwarf's latest 50 messages").
 *
 * On the wire because both sides act on it: main reads no more than this
 * off a transcript, and the renderer's tab trims to the same figure, so a
 * main that ever over-delivered could not make the panel disagree with the
 * design. A count rather than a time window or a session count — the
 * maintainer settled that reading in #192's design comment.
 */
export const MINE_HISTORY_MESSAGE_LIMIT = 50

/**
 * One dwarf that has spoken in a mine, as its transcript on disk remembers it
 * (#192) — a tab of the Mine History panel.
 *
 * Deliberately NOT a `Dwarf`. The dwarf may be gone: this is read from the
 * transcripts under the mine's project folder, which outlive the session that
 * wrote them, so nothing here is a claim about anything running now. `id`
 * repeats the provider's own dwarf-id scheme (`claude:<session>`,
 * `claude:<session>:<agent>`, `codex:<thread>`) so a speaker and the live dwarf
 * it once was are one name, never two.
 *
 * `role` is TOPOLOGY read off the transcript's own position and its sidecar —
 * the root of a session is the foreman, a subagent's depth picks worker or
 * worker2 through the same `rankForSpawnDepth` the live board uses — never
 * copied from a live dwarf, since there may be none. A depth the sidecar does
 * not state falls to `worker`, the direction every unproven rank falls in here.
 *
 * `messages` is oldest first and at most MINE_HISTORY_MESSAGE_LIMIT long, read
 * from a bounded tail: a transcript older than Claude Code's own
 * `cleanupPeriodDays` is gone, so "the latest 50" is a safe claim and
 * "everything ever said" never was. `lastMessageAt` is the newest message's
 * own timestamp as epoch ms, falling back to the file's mtime when the line
 * carried none; the panel orders tabs by it, newest first.
 */
export interface MineHistorySpeaker {
  id: string
  provider: DwarfProvider
  role: DwarfRole
  name: string
  lastMessageAt: number
  messages: FeedMessage[]
}

/**
 * What a mine's transcripts on disk say (#192), answered on request for one
 * mine id — never a path, for the reason every other mine channel names an id.
 *
 * `readable: false` and an empty list are two different facts and are kept
 * apart on purpose, exactly as DwarfFeedResult keeps them: the first says main
 * could not answer for this mine at all (it is not on the board), the second
 * says it could and nobody has spoken there yet. The panel draws one line for
 * the second and must never draw it for the first.
 */
export interface MineHistoryResult {
  readable: boolean
  /** Every dwarf that has spoken, in no promised order — the renderer sorts. */
  speakers: MineHistorySpeaker[]
}

/** Result of trying to open the terminal that hosts a visualized dwarf. */
export interface DwarfActivation {
  /** True when an existing terminal window was found and brought to the foreground. */
  focused: boolean
  /** True when no window could be focused, but a new terminal was opened tailing the transcript. */
  openedTerminal: boolean
  /** Recent transcript messages, used only when both focused and openedTerminal are false. */
  feed: FeedMessage[]
}

/**
 * Longest message accepted for delivery. Long enough for a real instruction,
 * short enough that keystroke injection stays a few seconds rather than a
 * minute of the user's keyboard being taken over.
 */
export const MAX_DWARF_TEXT_CHARS = 4000

/**
 * How many of a held session's own messages this app keeps (see
 * `Dwarf.conversation`), and how much of any one of them.
 *
 * Both are ceilings on something that rides EVERY poll's snapshot, which is
 * the whole reason they exist: a session that runs all afternoon must not grow
 * the push, and one that pasted a file into its reply must not either. Twelve
 * matches the transcript feed's own limit, so a held session and an observed
 * one show a comparable amount of history rather than two arbitrary depths.
 *
 * The cap is short of MAX_DWARF_TEXT_CHARS on purpose: that one bounds what a
 * user may SEND, once, and this one bounds what a dozen retained messages cost
 * on every push forever.
 */
export const HELD_CONVERSATION_LIMIT = 12
export const HELD_MESSAGE_MAX_CHARS = 2000

/**
 * KB boundaries at which a mine's SOURCE-CODE BYTE WEIGHT crosses into the
 * next tier — the design source's canonical thresholds
 * (`docs/dwarfai-miners-design/foundations.md`), and the same figures
 * `TierThresholds`'s default carries in `main/config/config.ts` (#140).
 *
 * That default type is main-only (`main/tier/tierService.ts`) and reachable
 * from a packaged install's userData config file, so `TIER_COPPER_KB` and its
 * three siblings CAN move it per install (see the `config-layering` skill).
 * Nothing today ships that live, possibly-tuned figure to the renderer over
 * IPC — only this shared default does — so a renderer deriving `cur/max` from
 * `ProjectSummary.weightBytes` against this table reads the shipped default,
 * not a running override. Widening the wire with a live copy of
 * `AppConfig.tierThresholds` is the way to close that gap; this table is
 * deliberately not that, and exists so `main/config/config.ts`'s own default
 * and the renderer read the SAME four numbers instead of each hand-typing a
 * copy that could drift.
 */
export const TIER_WEIGHT_THRESHOLDS_KB = {
  copperKb: 100,
  silverKb: 500,
  goldKb: 2048,
  uraniumKb: 8192
}

/** One message the panel wants handed to a dwarf's live session. */
export interface DwarfTextRequest {
  dwarfId: string
  text: string
  /** Whether the session should also receive an ENTER, submitting the line. */
  pressEnter: boolean
}

/** Verdict of one delivery attempt. Never carries the message itself. */
export interface DwarfTextResult {
  delivered: boolean
  /** The channel used, or 'none' when no attempt was possible. */
  via: TextDeliveryChannel | 'none'
  /** Human-readable reason shown in the panel when delivered is false. */
  error?: string
}

/** One request to cancel a dwarf's current work. No user text is ever involved. */
export interface DwarfKickRequest {
  dwarfId: string
}

/** Verdict of one kick attempt. Same shape as DwarfTextResult for a consistent panel. */
export interface DwarfKickResult {
  delivered: boolean
  /** The channel used, or 'none' when no attempt was possible. */
  via: TextDeliveryChannel | 'none'
  /** Human-readable reason shown in the panel when delivered is false. */
  error?: string
}

/**
 * One provider the Add Panel may draw a chip for (#86, over detection's #91).
 *
 * Two facts, and they are not the same fact. `installed` is whether the CLI is
 * on this machine, which is what decides whether a chip appears at all; the
 * design shows detected providers and an always-present Other, and nothing
 * else. `launchable` is whether this app has a path that can actually start it,
 * which is narrower and moves independently — a chip drawn from the first alone
 * would promise what the second cannot keep.
 *
 * What deliberately does NOT travel is where the CLI was found, or detection's
 * own explanation for not finding it. Both name this machine's filesystem
 * (`~/.local/bin`, or a configured override verbatim), the panel can act on
 * neither, and the wire is where they stop — the rule the launch channels
 * already hold by naming a mine instead of a directory.
 */
export interface AgentProviderOption {
  provider: DwarfProvider
  /** Whether this CLI was found on this machine. */
  installed: boolean
  /** Whether a session can actually be started for it from the panel. */
  launchable: boolean
  /** Fixed copy saying why not, when launchable is false. Never a path. */
  reason?: string
}

/** Every known provider's availability, answered on request (#86). */
export interface AgentProviderList {
  providers: AgentProviderOption[]
}

/** One request to start a new agent session in a mine's folder (#86). */
export interface AgentLaunchRequest {
  /** Which mine to start in. The id, never a path: main resolves the folder. */
  mineId: string
  /**
   * Which CLI to start (#168).
   *
   * Required, and deliberately not defaulted anywhere on the way down. Until
   * #168 this channel carried a mine and a prompt only, so the engine had
   * nothing to read and started `claude` whichever chip the user had pressed —
   * a Claude session laundered under another provider's name, which is the one
   * outcome a launch must never produce. A request that names no provider this
   * build has is refused at the boundary rather than resolved to a favourite.
   *
   * The existing `DwarfProvider` union, and no new vocabulary: this is the same
   * identity the poll reports a dwarf under, so a launched session and the
   * dwarf it becomes are named by one word rather than two that have to be kept
   * in step. It is therefore also why a custom command is NOT a value here —
   * see docs/custom-launch-command.md for that ruling.
   */
  provider: DwarfProvider
  /** The first thing to say to the new session. Capped like any delivered message. */
  prompt: string
}

/**
 * Verdict of one launch attempt. Never carries the prompt back, and never
 * claims a dwarf: `launched` means a process was STARTED, not that anything is
 * on the board. The session is discovered by the ordinary poll like every
 * other one, so a dwarf appears up to `pollIntervalMs` later and the panel has
 * to acknowledge the launch itself rather than waiting for the crew to change.
 */
export interface AgentLaunchResult {
  launched: boolean
  /** Which CLI the launch was for, or 'none' when it was refused before one was chosen. */
  provider: DwarfProvider | 'none'
  /** Human-readable reason shown in the panel when launched is false. */
  error?: string
  /**
   * The receipt this launch will be recognised by, when main opened one (#191).
   *
   * Not a dwarf id and not a session id — see `Dwarf.launchId`, which is where
   * the same string turns up once main has proved which session this launch
   * became. The panel holds it while it waits and adopts the dwarf that comes
   * back carrying it, so the paragraph above still holds in full: no dwarf is
   * claimed here, and none is known to claim.
   *
   * Absent when there is nothing to wait for — a refused launch, or a channel
   * that leaves a different receipt (a held session is recognised by the
   * conversation it was seeded with).
   */
  launchId?: string
}

/*
 * ---------------------------------------------------------------------------
 * Held sessions (#86, #94) — the panel STARTING a session and keeping hold of
 * it, rather than observing one somebody else started.
 * ---------------------------------------------------------------------------
 */

/**
 * One request to start a session the panel holds open (#86).
 *
 * Names a MINE, never a directory, for the reason every other dwarf channel
 * names an id: the folder is resolved in main from the board the panel is
 * already being shown, so this channel cannot be talked into starting a process
 * somewhere the panel is not showing.
 */
export interface HeldSessionLaunchRequest {
  mineId: string
  /**
   * Which CLI to hold (#168). Carried even though exactly one provider can be
   * held, and carried FOR that reason: holding a session means an Agent SDK
   * stream, only Claude has one, and a channel that took no provider would
   * answer a Codex chip with a Claude session rather than with a refusal. The
   * registry checks this and refuses anything else by name.
   */
  provider: DwarfProvider
  /** The first thing to say to the new session. Capped like any delivered message. */
  prompt: string
}

/**
 * Verdict of one held launch. Never carries the prompt back, and never claims a
 * dwarf: `launched` means the session STARTED, not that anything is on the
 * board. The session persists to the provider's own project directory and the
 * ordinary poll discovers it there like any other, so a dwarf appears up to
 * `pollIntervalMs` later and the panel must acknowledge from this verdict
 * rather than waiting for the crew to change.
 *
 * No session id travels. It is not known at this moment — the CLI reports its
 * own id asynchronously — and an optional field nobody could rely on is worse
 * than none. Answering a question names a DWARF (see below), which is the id
 * both processes already agree on.
 */
export interface HeldSessionLaunchResult {
  launched: boolean
  /** Human-readable reason shown in the panel when launched is false. */
  error?: string
}

/*
 * ---------------------------------------------------------------------------
 * Hosted processes (#194) — the panel starting a command of the person's OWN
 * and being that process's stdio.
 * ---------------------------------------------------------------------------
 */

/**
 * One request to start the command somebody typed into Add > Other (#194).
 *
 * Names a MINE and never a directory, exactly as both other launch channels
 * do: the folder is resolved in main from the board the panel is being shown,
 * so this channel cannot be talked into starting a process somewhere the panel
 * is not showing. That guard matters more here than anywhere else in the app,
 * because the program is the caller's too.
 *
 * ## The command travels; the argv does not
 *
 * What crosses is the raw string the person typed. Main parses it — a program
 * name plus an argv array, no shell, shell metacharacters refused — and it is
 * parsed THERE rather than in the renderer for the reason every boundary check
 * in this app lives in main: the panel renders what main verified, and a parse
 * done twice is two answers to "what will actually run".
 *
 * ## Why there is no provider field
 *
 * Because there is no provider. This is the one launch channel whose subject is
 * not a CLI this app knows, which is exactly what `AgentLaunchRequest.provider`
 * being a `DwarfProvider` refuses to express — and why this is a channel of its
 * own rather than a nullable field on that one. The dwarf it produces reports
 * `PANEL_OBSERVER`, because the panel is what observed it.
 */
export interface HostedLaunchRequest {
  mineId: string
  /** The command exactly as typed. Parsed in main; never run through a shell. */
  command: string
  /** The first thing to say to the new process. Capped like any delivered message. */
  prompt: string
}

/**
 * Verdict of one hosted launch.
 *
 * `launched` means a process STARTED and this panel is holding it. Unlike the
 * other two launch verdicts, that DOES imply a dwarf will appear — the panel is
 * its own observer here, so the next poll draws it with no store to wait on.
 * What it still does not carry is the dwarf's id: the panel recognises its own
 * launch by the receipt on the board (see launchArrival.ts), which is one rule
 * for all three modes rather than a fourth way of being told.
 */
export interface HostedLaunchResult {
  launched: boolean
  /** Human-readable reason shown in the panel when launched is false. */
  error?: string
}

/**
 * One answer to a question a held session asked (see DwarfQuestion).
 *
 * `toolUseId` is what makes this an answer to a specific ask rather than to
 * whatever is open now: an answer naming an ask that has since been withdrawn
 * is refused, never re-aimed.
 *
 * `answers` is the shape the agent's own tool takes — keyed by the question's
 * TEXT, valued by the chosen option's LABEL. Both halves are checked in main
 * against the ask the agent actually made, so nothing in an answer is free
 * text: it can only ever repeat the agent's own words back to it.
 */
export interface DwarfQuestionAnswerRequest {
  dwarfId: string
  toolUseId: string
  answers: Record<string, string>
}

/**
 * Verdict of one answer. `answered` means the agent's blocked tool call was
 * released with this answer — the panel's ✓ for a question, and as narrow as
 * `delivered` is for a message: it says the agent was handed the choice, never
 * what it then did with it.
 */
export interface DwarfQuestionAnswerResult {
  answered: boolean
  /** Human-readable reason shown in the panel when answered is false. */
  error?: string
}

/**
 * One decision on a permission prompt a held session raised (#203; see
 * Dwarf.pendingPermission).
 *
 * Addressed by DWARF and by `toolUseId`, exactly as an answer is: a decision
 * naming a prompt that has since closed is refused, never re-aimed at
 * whatever is open now — approving the second tool call with a click made
 * about the first is how a panel comes to run a command nobody read.
 *
 * Answered with DwarfQuestionAnswerResult rather than a shape of its own,
 * because the verdict means the same narrow thing: the agent's blocked call
 * was released with this decision, and nothing about what it then did.
 */
export interface DwarfPermissionAnswerRequest {
  dwarfId: string
  toolUseId: string
  decision: DwarfPermissionDecision
}

/**
 * Wire payload for both the getMines() pull and the minesUpdated push: the
 * per-mine breakdown plus the cross-mine vault total, so the panel never has
 * to re-derive the grand total from a partial view of the mines.
 */
export interface MinesSnapshot {
  mines: Mine[]
  /** Sum of every mine's tokensObserved — the vault total shown in the map-view chip. */
  tokensObserved: number
  /**
   * The whole vault, split by material — the global breakdown behind the
   * map-view chip.
   *
   * Deliberately NOT the sum of `mines[].materials`: it is summed over the
   * ENTIRE persisted ledger, including projects with no dwarf running right
   * now. That is what makes coal visible, since the historical backfill
   * credits projects whose sessions all ended long ago and which therefore
   * appear in no mine today.
   *
   * Optional for the same compatibility reason as Mine.materials.
   */
  materials?: MaterialTotals
}

/**
 * What the global panel-toggle shortcut actually IS right now (see #17) — the
 * verdict, never the wish. `registered` is read back from the outcome of
 * `globalShortcut.register`, so the settings panel can never paint a shortcut
 * as active when the OS refused it.
 */
export interface ShortcutState {
  /**
   * The accelerator in force. After a failed change this is the combination
   * that was KEPT, not the one that was rejected; after a failed startup
   * registration it is the stored one, so the panel can name what is broken.
   */
  accelerator: string
  /** Whether the OS actually granted the combination. False means no shortcut works. */
  registered: boolean
  /**
   * Why the last attempt (at startup or on a change) did not work, ready to
   * show. Absent exactly when the current accelerator registered cleanly.
   */
  error?: string
  /**
   * Which platform's key names to print (Cmd vs Ctrl vs Win). Main is the only
   * process that knows `process.platform`, so it travels with the state rather
   * than being guessed from the user agent in the renderer.
   */
  platform: ShortcutPlatform
}

/**
 * Which screen edge the shell is docked to (#90). The design allows exactly
 * left or right, and names Right as the default.
 */
export type PanelEdge = 'left' | 'right'

/**
 * What the shell window IS, read back from the BrowserWindow after main applied
 * it — never what the click asked for.
 *
 * The same honesty rule the pin surface has, for the same reason: main derives
 * the panel's bounds from the display it is on, so a display too narrow for the
 * expanded panel, or an edge the user has not chosen, must reach the renderer as
 * a fact rather than being assumed by whoever pressed the arrow. The rail draws
 * its arrow from `edge`, so a panel drawn against the wrong edge would point the
 * user off the screen.
 *
 * `mineOpen` is here because it changes the WINDOW: the design keeps an open
 * mine beside one secondary panel, and that second column is width the window
 * has to be given before the renderer can draw into it.
 *
 * The two booleans are INDEPENDENT since #153, and that is the whole of the
 * maintainer's fifth acceptance correction. `expanded` says whether the
 * SECONDARY panel — map, mines, settings, lab, market — is drawn; `mineOpen`
 * says whether the mine column is. The rail's arrow toggles the first and leaves
 * the second alone, the app mark above the navigation stack clears both, and the
 * interior's own round close clears only the mine. All four combinations are
 * real: neither is the closed rail, both is the design's concurrent model, and
 * a mine with no secondary beside it is the mine mock's own composition.
 */
export interface PanelLayout {
  edge: PanelEdge
  /** Whether the SECONDARY panel is drawn — never "the shell is open at all". */
  expanded: boolean
  mineOpen: boolean
}

/**
 * What the panel asks the shell window to become (#90, #138).
 *
 * `edge` is optional and absent from every request EXCEPT the Settings
 * position control (#138): omitting it means "keep whatever edge main already
 * has", which is what the rail toggle and the mine-open resize both do — they
 * are not the position control and must never nudge the docked side by
 * accident. Only the position control's Left/Right segments ever set it.
 */
export interface PanelLayoutRequest {
  expanded: boolean
  mineOpen: boolean
  edge?: PanelEdge
}

/**
 * Which build of the app is running (see #79) — the number, and which of the
 * two builds that can be on one machine is speaking.
 *
 * Both fields are produced in main and travel; neither is derived here or in
 * the renderer. Main is the only process that can ask Electron, and with
 * context isolation on there is no package.json to read and no process.env to
 * consult on the far side of the bridge.
 *
 * `version` is `app.getVersion()`, which is the version ACTUALLY RUNNING and
 * not a copy of one. Measured on both sides: packaged, it reads the
 * package.json that shipped inside the app — the same file that stamps the
 * executable's ProductVersion and the installer's filename, so the panel and
 * the .exe cannot disagree; unpackaged, it reads the checkout's package.json,
 * which is what the bug-report template already asks a reporter for. A
 * constant compiled in at build time was the alternative and is the wrong one:
 * it is a copy taken at some other moment, and a number that looks right and
 * is stale is precisely the failure this exists to prevent.
 *
 * `packaged` is `app.isPackaged` — the distinction main already turns three
 * startup decisions on, rather than a second mechanism invented for a label.
 * It is the half the incident actually needed: an installed build and a dev
 * build of the same checkout carry the SAME version, so the number alone
 * cannot tell them apart, and the wrong one got diagnosed.
 */
export interface AppBuild {
  version: string
  packaged: boolean
}

/**
 * Verdict of asking main to adopt a folder as a mine (#85, #127).
 *
 * There is no request payload: the OS folder picker is opened in MAIN, so the
 * renderer asks and never names a path. `outcome` is the discriminator its
 * sibling below already has, and it is why 'cancelled' is not 'failed': the
 * user backing out of the picker is a decision, not a fault, and a control
 * that silently does nothing on a FAULT is broken — but one that does nothing
 * because the user changed their mind is working exactly as asked. Before this,
 * both arrived as `{ declared: false, reason: string }` and the only thing
 * telling them apart was matching an exact English sentence on the wire.
 */
export interface MineDeclareResult {
  outcome: 'added' | 'cancelled' | 'failed'
  /**
   * The mine that now exists, when one does — the SAME id aggregation and the
   * ledger use for that path, never a second scheme. The mine itself arrives on
   * the next minesUpdated like every other change.
   */
  mineId?: string
  /**
   * The adopted project as the browse would list it, when the store answered
   * with one (#156).
   *
   * The panel reloads its first page after an adopt, and that reload cannot be
   * relied on to contain the new card: a project keeps the date it was first
   * seen, so RE-declaring a folder the store already holds leaves it wherever it
   * already sat in the order — pages down, or off the end. An Add that reports
   * success and changes nothing on screen is indistinguishable from a broken
   * one, so the row travels with the verdict and the panel puts it on the list
   * itself when the reload did not.
   *
   * Absent when there is nothing to name: a cancelled picker, a refusal, or a
   * store that could not read the row back.
   */
  project?: ProjectSummary
  /** Why the declare failed; absent except when `outcome` is 'failed' — a cancel needs none, `outcome` already says so. */
  reason?: string
}

/**
 * Verdict of undoing a declaration (#85). Keyed by mine id, never by path:
 * the id is what the board, the ledger and the projects store already agree on.
 *
 * 'removed' means the mine leaves the board. 'reverted' means a live session is
 * still working it, so it stays as an ordinary discovered mine — the user asked
 * to undo their declaration, not to hide a running agent. 'unchanged' is an id
 * the store holds no declaration for, and 'failed' is a store that refused.
 * Neither of the last two ever removes anything, and both carry a reason.
 */
export interface MineUndeclareResult {
  outcome: 'removed' | 'reverted' | 'unchanged' | 'failed'
  /** Why nothing changed; absent exactly when the outcome is 'removed' or 'reverted'. */
  reason?: string
}

/**
 * Verdict of the Settings "Reset metrics" action (#138), same idiom as
 * MineUndeclareResult: a discriminated outcome plus a reason exactly when
 * something did NOT happen.
 *
 * PRODUCT DECISION (#138): this wipes METRICS only — the material ledger
 * (mined totals and session marks) — and NEVER touches the projects store.
 * The design's own text says "delete your data" but means the accumulated
 * metrics; the declared/discovered project list is the user's remembered
 * mines, not a metric, and survives a reset untouched. So does the panel
 * side, the shortcut, the pin and autostart preferences — none of them are
 * metrics either.
 *
 * 'reset' means the vault was cleared AND that clearing was persisted before
 * this resolved — the modal's Confirm is a destructive, irreversible action,
 * so its caller must know the wipe actually reached disk rather than assuming
 * a promise that resolved without throwing. 'failed' carries a reason and
 * changes nothing; there is no 'cancelled' here because closing the modal
 * (the X) never reaches main at all.
 */
export interface MetricsResetResult {
  outcome: 'reset' | 'failed'
  /** Why nothing changed; absent exactly when the outcome is 'reset'. */
  reason?: string
}

/**
 * Which stored date a project browse is ordered by (#92).
 *
 * Two keys because they answer different questions and the user asked to sort
 * by either: `addedAt` is provenance — when the project first arrived — and
 * `lastOpenedAt` is recency. Neither is `Mine.updatedAt`, which is recomputed
 * from this poll's snapshots and never persisted; a browse spans projects with
 * no session running, so a liveness figure cannot order it.
 */
export type ProjectSortKey = 'addedAt' | 'lastOpenedAt'

export type ProjectSortDirection = 'asc' | 'desc'

/**
 * What the panel asks for when browsing every project it has ever been shown
 * (#92) — the filters, the order, and one page of it.
 *
 * `tier` matches the MEASURED tier only. A project nobody has walked yet has
 * no stored tier and therefore matches no tier filter, including 'bronze':
 * `tierOf()`'s provisional bronze is for DRAWING a mound, never for answering
 * a question, and a bronze filter that swept up every unmeasured project would
 * be exactly the #41 mistake.
 *
 * `nameContains` is a SUBSTRING of the folded name, so typing 'ontein' finds
 * 'container' and 'cafeteria' finds 'Cafetería'. Main folds the term with the
 * same normalizer that wrote the stored column, so the renderer sends whatever
 * was typed and never pre-processes it.
 *
 * `limit` and `offset` are a page. Both are advisory: main clamps them, so a
 * renderer cannot ask for the whole table and cannot ask for nothing.
 */
export interface ProjectQuery {
  tier?: MineTier
  sortBy: ProjectSortKey
  direction: ProjectSortDirection
  nameContains?: string
  limit?: number
  offset?: number
}

/**
 * One row of a project browse (#92): what is REMEMBERED about a project, plus
 * the one fact that is not remembered at all.
 *
 * `live` is whether the project is on the board this poll produced — it is
 * poll-truth, stamped as the answer is assembled, and is deliberately not a
 * stored column. Everything else here comes off disk and survives a restart;
 * `live` cannot, because it is a statement about right now.
 *
 * `knownTier` is absent until a walk has measured one, and absent means
 * unmeasured rather than bronze (#41). `lastOpenedAt` is absent for a project
 * the user declared and no agent has been seen in: declaring is not opening.
 *
 * `materials` is this project's persisted per-material breakdown (#90),
 * joined by the SAME id — `mineIdForPath`, see `id` below — the material
 * ledger already keys every mine by. It is absent exactly when the ledger
 * holds no row for this id at all, never a breakdown of zeros invented for a
 * project nobody has ever mined — the same absent-means-unmeasured
 * discipline `knownTier` uses (#41).
 *
 * `weightBytes` is the tier-PROGRESS figure `knownTier` alone cannot give
 * (#140): the raw SOURCE-CODE BYTE WEIGHT `main/tier/tierService.ts` measured
 * — in BYTES, the unit its walk actually produces, never mined tokens, which
 * are a wholly unrelated axis exactly as the materials themselves never
 * convert into one another. Same absent-means-unmeasured discipline as
 * `knownTier`: absent until a walk has measured this path, present (a stale
 * measurement counts) once one has, never an invented 0. It is joined LIVE
 * off `TierService`'s own cache, by PATH — the same key `tierOf`/
 * `knownTierOf` use — never persisted as a projects-store column the way
 * `knownTier` is.
 *
 * The renderer derives `cur/max` for the design's `Next level: <cur>/<max>`
 * (screens/browse.md) by comparing `weightBytes` against
 * `TIER_WEIGHT_THRESHOLDS_KB` below (× 1024 for the KB-to-byte conversion,
 * since that table is in KB and this field is in bytes) — the SAME canonical
 * boundaries `knownTier` was classified from, so the two stay one honest
 * reading of one measurement rather than two figures that could disagree.
 */
export interface ProjectSummary {
  /** mineIdForPath — the same id the board and the ledger use, never a second scheme. */
  id: string
  path: string
  name: string
  /** True when the user adopted this folder (#85); false when it was discovered. */
  declared: boolean
  knownTier?: MineTier
  /** See the field-group comment above; absent exactly when no walk has measured this path. */
  weightBytes?: number
  addedAt: number
  lastOpenedAt?: number
  lastProvider?: DwarfProvider
  /** Absent means the ledger has no row for this id — never zeros for a project nobody has mined (#90). */
  materials?: MaterialTotals
  /**
   * Where this project's mine stands on the world map (#136), or absent when
   * nothing has placed it. The same stored number `Mine.mapSite` carries, off
   * the same row — a browse and the map must never disagree about where a mine
   * is.
   */
  mapSite?: number
  live: boolean
}

/**
 * The answer to a project browse (#92).
 *
 * `answered` exists so an empty page is never ambiguous: no projects yet and a
 * projects database that would not open are both "zero rows", and reporting the
 * second as the first would tell a user their history is gone. A refusal always
 * carries its reason, and `projects` is empty rather than absent so the panel
 * can render the same way either way.
 */
export interface ProjectQueryResult {
  answered: boolean
  projects: ProjectSummary[]
  /** Why nothing could be read; absent exactly when `answered` is true. */
  reason?: string
}

export const IPC_CHANNELS = {
  hidePanel: 'panel:hide',
  /**
   * Bring the shell to the front and focus it (#165).
   *
   * Fire-and-forget, like `hidePanel`: there is no verdict to render — the
   * renderer is reporting that the user clicked the panel, and what a z-order
   * change costs is a request the window manager may answer however it likes.
   *
   * It exists because the platform's own click-to-front does not reliably
   * apply to a frameless transparent window, so the third acceptance run found
   * the panel taking clicks from behind whatever program had the foreground.
   */
  raisePanel: 'panel:raise',
  /**
   * Always-on-top ("pin") surface, see #35. Both channels answer with the REAL
   * state read back from the BrowserWindow — never the requested one — so the
   * renderer can only ever render what the window manager actually did.
   */
  getAlwaysOnTop: 'panel:getAlwaysOnTop',
  setAlwaysOnTop: 'panel:setAlwaysOnTop',
  /**
   * The docked shell's own shape, see #90. Both channels answer with the REAL
   * PanelLayout after main moved the window, for the same reason the pin
   * channels do: the bounds are derived from the display, so a request the
   * display cannot satisfy must come back as what actually happened.
   */
  getPanelLayout: 'panel:layout:get',
  setPanelLayout: 'panel:layout:set',
  /**
   * User-configurable panel toggle, see #17. Both channels answer with the
   * REAL ShortcutState after the registration attempt — never the requested
   * accelerator — so a combination another application owns can never be
   * rendered as the working shortcut.
   */
  getToggleShortcut: 'shortcut:get',
  setToggleShortcut: 'shortcut:set',
  getMines: 'mines:get',
  minesUpdated: 'mines:update',
  activateDwarf: 'dwarf:activate',
  /**
   * One dwarf's own transcript tail, on demand (#159). Separate from
   * `activateDwarf` because that channel reads a feed only after failing to
   * focus a window and failing to open a terminal, and the message panel wants
   * the words without either attempt.
   */
  getDwarfFeed: 'dwarf:feed',
  /**
   * Every dwarf that has spoken in one mine, with its latest messages (#192),
   * read from the transcripts under the mine's project folder on request.
   *
   * Pull-only, like `getDwarfFeed`, and deliberately not folded into
   * minesUpdated: that push carries the board — the sessions running THIS
   * poll — and the whole point of this channel is the sessions that are not.
   * Names a mine ID and never a path, for the reason the declare/undeclare
   * channels give: the id is what both sides already agree on.
   */
  getMineHistory: 'mine:history',
  sendDwarfText: 'dwarf:sendText',
  kickDwarf: 'dwarf:kick',
  /**
   * The panel reporting that it WATCHED a kicked agent stop (see #46), so main
   * can take the dwarf off the board. One-way: the renderer contributes the
   * observation it alone makes, main owns which dwarfs exist, and the
   * departure comes back on minesUpdated like every other change.
   */
  retireDwarf: 'dwarf:retire',
  /**
   * The running build (see #79). Pull-only and answered from Electron: a
   * version cannot change while the process lives, so there is nothing to
   * push and nothing to keep in step.
   */
  getAppBuild: 'app:build',
  /**
   * Adopting a folder as a mine, and undoing that (#85).
   *
   * declare carries NO payload in either direction beyond its verdict: the
   * native folder picker is opened in main, so the renderer asks for one and
   * never chooses, names or even sees a path it did not already receive on a
   * mine. undeclare carries a mine id and never a path, for the same reason
   * every other dwarf channel does — the id is the thing both sides already
   * agree on, and a path would be a second key to keep in step.
   */
  declareMine: 'mine:declare',
  undeclareMine: 'mine:undeclare',
  /**
   * Settings' "Reset metrics" action (#138). No payload: the typed
   * confirmation is validated entirely in the renderer (the gate on
   * `Confirm`), and this channel carries only the already-confirmed intent.
   * Answers with MetricsResetResult — see its doc comment for exactly what
   * this does and does not wipe.
   */
  resetMetrics: 'metrics:reset',
  /**
   * Browsing every project the app remembers (#92) — filtered, ordered and
   * paged in SQL, in main.
   *
   * Pull-only, and deliberately not folded into minesUpdated: that push carries
   * the board, which is the projects being worked THIS poll, and the whole point
   * of this channel is the projects that are not. A browse is also a question
   * with arguments, asked when a user types, rather than a state to keep in
   * step — so it answers on request and pushes nothing.
   */
  queryProjects: 'projects:query',
  /**
   * Start a new agent session in a mine (see #86). Answers with the verdict of
   * the START only — the dwarf itself arrives on a later minesUpdated, because
   * the launched session is discovered by the same poll as every other one.
   */
  launchAgent: 'agent:launch',
  /**
   * Which agent CLIs this machine has, and which of them the panel can start
   * (#86, over detection's #91).
   *
   * Pull-only, and deliberately not folded into minesUpdated: that push carries
   * the board — the sessions running THIS poll — and what is installed on a
   * machine is not board state. It changes when somebody installs a CLI, which
   * is not something to keep in step at 2Hz, so the Add Panel asks when it
   * opens. Answers with AgentProviderList; no path ever crosses.
   */
  listAgentProviders: 'agent:providers',
  /**
   * Starting a session the panel HOLDS, and answering what it asks (#86, #94).
   *
   * Two channels rather than one because they are two acts with different
   * lifetimes: a launch is a request that resolves in a moment, an answer
   * releases a tool call the agent has been blocked inside — possibly for
   * minutes, since a human is on this end. Both name an id and never a path
   * (launchHeldSession) or a session (answerDwarfQuestion), for the reason the
   * mine channels above give.
   *
   * A held session is not the only way to start one. The detached mode
   * (`agent:launch`, #86's first cut) hands the session over and lets go, so it
   * outlives the panel; a held session's child dies with the panel, and in
   * exchange its asks reach the panel live rather than post-hoc. Both belong.
   */
  launchHeldSession: 'agent:launchHeld',
  answerDwarfQuestion: 'agent:answerQuestion',
  /**
   * Deciding a permission prompt a held session raised (#203). Its own
   * channel beside answerDwarfQuestion for the reason the two wire types are
   * siblings: one carries the agent's words back, the other carries a fixed
   * allow/deny, and a channel that took both would have to accept a record
   * that is sometimes an answer and sometimes a verdict.
   */
  answerDwarfPermission: 'agent:answerPermission',
  /**
   * Starting a command of the person's own and holding it over stdio (#194).
   *
   * Its own channel rather than a variant of `agent:launch`, because the two
   * carry different subjects: that one names a `DwarfProvider` this app knows
   * how to start, and this one names a string somebody typed. Folding them
   * together would mean a nullable provider on a request where "no provider"
   * and "a provider I could not read" would look identical at the boundary.
   *
   * A third launch mode, and all three belong. Detached (`agent:launch`) hands
   * the session over and lets go; held (`agent:launchHeld`) keeps a structured
   * stream into a CLI this app knows; hosted keeps a PIPE into one it does not.
   */
  launchHostedProcess: 'agent:launchHosted'
} as const
