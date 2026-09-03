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

export type DwarfRole = 'foreman' | 'worker'

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
 * Role is still consulted, in one direction only: a WORKER is a spawned
 * subagent with no channel of its own, so topology there does not stand in for
 * the fact, it proves it — no human can be typing into something nothing
 * outside its parent can even address. Rank may therefore shorten the window
 * and may never lengthen it, which is why a provider claiming 'attended' about
 * a worker changes nothing.
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
  return role === 'worker' || attendance === 'unattended' ? 'unattended' : 'attended'
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
 *
 * A ✓ means the same thing on every one of them and nothing more: handed over.
 * It is worth restating for the queue, because that tier is the one where the
 * gap is visible — a queued item is persisted immediately and drained at the
 * thread's next idle boundary (6-8s in the one measured run), so the panel is
 * reporting a durable hand-over, never that anything has read it. Only the
 * renderer's observed-reaction rule may ever say more (see reaction.ts).
 *
 * A dwarf with no channel at all simply carries no value.
 */
export type TextDeliveryChannel = 'terminal' | 'claude-relay' | 'foreman-relay' | 'codex-queue'

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

export interface Dwarf {
  id: string
  provider: DwarfProvider
  role: DwarfRole
  name: string
  model?: string
  effort?: string
  status: DwarfStatus
  description?: string
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
   * instruction instead of the user's message — so it is null exactly when
   * sendText is null (see resolveKickDelivery).
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
}

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

export interface FeedMessage {
  role: 'user' | 'assistant'
  text: string
  timestamp: string
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

/** One request to start a new agent session in a mine's folder (#86). */
export interface AgentLaunchRequest {
  /** Which mine to start in. The id, never a path: main resolves the folder. */
  mineId: string
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
 */
export interface PanelLayout {
  edge: PanelEdge
  expanded: boolean
  mineOpen: boolean
}

/**
 * What the panel asks the shell window to become (#90).
 *
 * `edge` is deliberately absent: the design puts the left/right choice in the
 * Settings position control, which is its own slice. Until that exists the edge
 * is main's, and the renderer can only ever read it back.
 */
export interface PanelLayoutRequest {
  expanded: boolean
  mineOpen: boolean
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
 */
export interface ProjectSummary {
  /** mineIdForPath — the same id the board and the ledger use, never a second scheme. */
  id: string
  path: string
  name: string
  /** True when the user adopted this folder (#85); false when it was discovered. */
  declared: boolean
  knownTier?: MineTier
  addedAt: number
  lastOpenedAt?: number
  lastProvider?: DwarfProvider
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
  answerDwarfQuestion: 'agent:answerQuestion'
} as const
