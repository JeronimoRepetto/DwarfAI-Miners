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
 *
 * `antigravity` is the third, and it is the one that makes the difference
 * between an identity and a capability visible (#237). The name is the
 * HARNESS, not its binary: `agy` is only what the executable is called, and
 * the CLI can front models other than Gemini, so calling the provider either
 * of those would name the wrong thing. What this app can do with it is
 * narrower than what it can do with the other two: step 3 gave it explicit
 * Mine History discovery, step 4 gave it a DETACHED one-shot launch (see
 * `LAUNCHABLE_PROVIDERS` in main/domain/launchProviders.ts), and step 5 proved
 * a held round trip through its documented stream-json protocol, so it now
 * sits in `HELDABLE_PROVIDERS` too — see that constant's own comment for what
 * the held protocol still cannot do. Membership in `DWARF_PROVIDERS` alone
 * says only that a store can be READ; the other two lists are what say how
 * far past reading this app may go.
 *
 * `opencode` is the fourth (#444), and it is the plainest member so far:
 * `opencode.db` is read and nothing else is claimed. No launch (the CLI's own
 * argv was never measured against a probe this app owns), no hold, and no
 * delivery channel — the schema carries no pid or process column anywhere
 * (`docs/opencode-format.md`, row 5) — so it joins this table alone and
 * neither `LAUNCHABLE_PROVIDERS` nor `HELDABLE_PROVIDERS` grows.
 */
export const DWARF_PROVIDERS = ['claude', 'codex', 'antigravity', 'opencode'] as const

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
 * Membership is a capability rather than a preference: holding a session IS
 * such a stream. Codex has no held-session engine in this app at all —
 * `docs/command-surface-evaluation.md` records it, and the question-capture
 * matrix marks the `codex exec` row No for live capture and No for answering.
 * A provider missing here can still be LAUNCHED; it is started detached and
 * discovered by the ordinary poll, which is a real launch and simply not a
 * watched one.
 *
 * AMENDED for #237, step 5 (was: `['claude']`). This comment used to say
 * Antigravity's name would arrive "on the day a live stream has actually been
 * held, not on the day one looks possible". That day was 2026-09-07: a
 * two-turn round trip was held on this machine against Antigravity CLI 1.1.26
 * — one `agy --input-format stream-json --output-format stream-json` process,
 * one NDJSON user event per turn on its stdin, the same `conversation_id`
 * across both turns, a `result` for each — and its stdout is committed as
 * `main/providers/__fixtures__/antigravity/held-stream.jsonl`.
 *
 * Two providers, two engines, ONE port: `sdkHeldSession.ts` over the Agent
 * SDK's `query()` and `antigravityHeldSession.ts` over that child process's
 * stdin and stdout. What they share is what this list promises and no more —
 * a session started with a prompt, kept open, spoken to again, and ended.
 * Everything past that is per-protocol and declared rather than assumed: a
 * held Antigravity session offers no turn cancellation and no context
 * reading, and answers no question or permission prompt, because its
 * documented input side carries user text events and nothing else. Those are
 * absent from its handle rather than refused at runtime (see
 * `HeldSessionHandle` in main/sessionLaunch/heldSession.ts), so the panel says
 * "this protocol has no cancel" instead of "the interrupt was refused".
 */
export const HELDABLE_PROVIDERS: readonly DwarfProvider[] = ['claude', 'antigravity']

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
 * One reading of a held session's own context window, unclamped (issue #96).
 *
 * Pulled rather than pushed: unlike `model` and `mcpServers`, no stream
 * message carries this — `system/init` and `result` are silent on it — so it
 * is the one telemetry field this app has to ask for, off the session's own
 * `getContextUsage({ detail: 'summary' })` control request (see
 * `HeldSessionHandle.contextUsage` and `HeldSessionRegistry.refreshContextUsage`
 * in `main/sessionLaunch`). `usedTokens` may exceed `maxTokens` — the CLI
 * reports what it measured, and clamping a bar to its track is the panel's
 * job, not this reading's.
 */
export interface DwarfContextUsage {
  usedTokens: number
  maxTokens: number
}

/**
 * What a held session will let the panel change about ITSELF while it runs,
 * and what it has already been asked to change but nothing has confirmed yet
 * (issue #96).
 *
 * Two halves, because they answer two different questions and neither implies
 * the other. `canSetModel`/`canSetEffort` are about the ENGINE behind this
 * session — a Claude session held over the Agent SDK has `setModel` on its
 * own handle, and an engine with no such act has none, which is a fact about
 * the session type rather than about this moment. The two `pending` fields
 * are about one request in flight, and they exist because **a change is never
 * shown as done on the strength of having been accepted**:
 *
 * - `pendingModel` is the model asked for, held here until the session's own
 *   next context reading NAMES it (`DwarfContextUsage`'s pull carries the
 *   model the CLI believes is in force). That reading is the confirmation,
 *   and it costs no paid turn — issue #96's live-fire spike established the
 *   route: `setModel` resolved in ~2 ms and the following `getContextUsage()`
 *   showed `model` and `maxTokens` flipped. Cleared the moment `Dwarf.model`
 *   agrees with it.
 * - `pendingEffort` is the effort asked for, and it may never clear at all.
 *   `applyFlagSettings({ effortLevel })` resolves cleanly on a model that
 *   does not support one and silently does nothing — measured, same spike —
 *   so the only confirmation this app can honestly wait for is the next
 *   `init` re-announcing the session's own effort, which arrives at the START
 *   of the next turn or never. Until then the panel must say "requested", not
 *   "set". A field that stayed pending forever is the honest reading of a
 *   setting nothing echoed back, not a bug to paper over with a timeout.
 *
 * Held sessions ONLY, on the same terms as `mcpServers` and `contextUsage`:
 * every other session type this app runs has no structured route to change
 * anything mid-run (docs/command-surface-evaluation.md §2b), so the field's
 * absence means "no such control here" and the panel disables rather than
 * hides — the idiom the dwarf action bar already holds.
 */
export interface DwarfSessionTuning {
  canSetModel: boolean
  canSetEffort: boolean
  pendingModel?: string
  pendingEffort?: string
}

/**
 * One thing the panel asks a held session to change about itself mid-run
 * (issue #96) — discriminated rather than a record of optional fields, so a
 * request always names exactly one act and main never has to decide what a
 * payload carrying both, or neither, meant.
 *
 * One channel for two acts rather than two channels, deliberately: every
 * boundary rule they hold is the same one (held sessions only, one bounded
 * control request, no retry, the same verdict shape and the same fixed
 * refusal copy), and the thing that genuinely differs between them — how the
 * change is CONFIRMED — is not a property of the request at all. See
 * `DwarfSessionTuning` for the two different confirmations.
 */
export type DwarfTuningChange =
  { kind: 'model'; model: string } | { kind: 'effort'; effort: string }

/**
 * One request to change a held session's own tuning (issue #96). Named by
 * DWARF, never by session id, for the reason every other dwarf channel gives:
 * the dwarf is what the panel has, and main resolves the rest.
 */
export interface DwarfTuningRequest {
  dwarfId: string
  change: DwarfTuningChange
}

/**
 * Verdict of one tuning change (issue #96) — a discriminated pair rather than
 * `DwarfTextResult`'s `{ delivered, via, error? }`, because there is no
 * channel to name here: a control request travels the one stream this process
 * already owns, and `via` would be the same constant on every answer.
 *
 * `applied: true` says the session ACCEPTED the request, and nothing more
 * than that. It is deliberately not a claim that the change took effect —
 * that is what the next reading proves, and until it does the strip draws the
 * value as pending (see `DwarfSessionTuning`). `applied: false` always
 * carries a reason, because the strip shows it: a refusal the panel cannot
 * word is a control that quietly did nothing, which is the one outcome this
 * surface exists to avoid.
 */
export type DwarfTuningResult = { applied: true } | { applied: false; reason: string }

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
 * Since issue #255 it decides more than a window. A root session the registry
 * calls 'attended' stays on the board while it rests, because a dwarf is the
 * panel's only handle for sending text and a terminal still at its prompt is
 * exactly what a person wants to write to next. 'unknown' does not get that,
 * and this is the rule above rather than an exception to it: keeping a dwarf on
 * the board RECORDS a decision about who is there, so the placeholder may not
 * seal it. The window stays generous for an unproven session; its existence
 * does not.
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
 * terminal: the session owns a console window — its window is focused and
 *   keystrokes are injected into it. A MESSAGE reaches this tier only where
 *   nothing else can reach the session at all (#308); a KICK still reaches it
 *   first, because an interrupt is a keystroke by nature.
 * claude-relay: the session is addressable by name, so a one-shot `claude -p`
 *   turn delivers the text over Claude Code's cross-session messaging. The
 *   PRIMARY channel for any observed Claude session that has a registry name,
 *   on every platform, whether or not it also owns a console (#308).
 * foreman-relay: the dwarf is a subagent with no channel of its own; the text
 *   goes to its foreman (parent session) under an explicit `[for agent X] ` prefix.
 * codex-queue: the session is a Codex thread whose own message queue accepts an
 *   item addressed by thread id, so `codex queue` hands it over without any
 *   window, pid or console (#97).
 * codex-exec-resume: the session is a Codex thread that was STARTED with
 *   `codex exec`, so no process is left to hand anything to — and a new one
 *   continues it. `codex exec resume <id> -` reopens the very same thread with
 *   the message on stdin (#450). The sibling of the queue and never a
 *   replacement for it: the queue reaches a thread that is running, and this
 *   starts the turn on one that is not.
 * held-session: THIS PANEL is holding the session's own stream open, so the text
 *   goes onto that stream in-process — no window, no pid, no relay turn (#210).
 * launched-process: THIS PANEL started that session detached and still holds the
 *   process it started, so the session can be ENDED — and only ended (#217). The
 *   one channel that carries no message at all: `codex exec` reads one prompt
 *   from stdin and exits with its turn, so there is no inbox behind it and no
 *   process left to read one. It is `cancel` without `sendText`, the mirror of
 *   the queue's `sendText` without `cancel`.
 *
 * A dwarf can carry two of these at once, one per half of the matrix, and one
 * pairing is now ordinary rather than exceptional: an observed Claude session
 * with a registry name reports `sendText: 'claude-relay'` and
 * `cancel: 'terminal'` (#308). The console tier can only deliver a message by
 * focusing somebody's window and typing into it — measured live writing the
 * remainder of a sentence into whatever the person clicked on next — so a
 * message takes the invisible channel and the interrupt, which carries no
 * user text, keeps the keystroke. `textDelivery` follows `sendText`.
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
   * A NEW `codex exec` process continuing a thread that already exists (#450)
   * — the one channel whose act is starting a turn rather than handing a
   * message to something already running.
   *
   * `codex exec [OPTIONS] resume <SESSION_ID> -` was measured live on Codex CLI
   * 0.153.4: same session id, prior context intact, prompt on stdin, exit 0,
   * and ONE registry row whose `source` stays `'exec'`. That last fact is why
   * this is its own channel and not a widening of 'codex-queue': the queue gate
   * still refuses an exec thread, and still correctly — `codex queue` persists
   * an item for a running thread to drain, and there is no running thread here.
   * Two different acts against two different session shapes, kept apart the way
   * reaction.ts keeps delivered and reacted apart.
   *
   * A ✓ means what it means everywhere else and no more: the message reached
   * the session and its turn began. The panel cannot wait for that turn — it
   * blocks for its whole length, 29 s measured for a trivial one — so the
   * verdict is taken once the process has survived a short bounded start
   * window (see CODEX_RESUME_START_WINDOW_MS). Handed over, never reacted;
   * only the transcript watcher may ever say more.
   *
   * It carries no attachment and no kick. The message is stdin and nothing
   * else, and the process a resume starts is one nothing on the board tracks —
   * the launch this panel held was the OPENING turn's, and it has exited.
   */
  | 'codex-exec-resume'
  /**
   * A NEW `opencode run --session <id>` process continuing a session that
   * already exists (#534) — OpenCode's answer to the same shape
   * 'codex-exec-resume' is: the CLI reads one prompt, runs one turn and
   * exits, so nothing is left running to hand a second message to, and a new
   * process on the SAME session id continues it. `opencode run --session
   * <id> --format json` was measured live on OpenCode 1.18.31 (M4): same
   * session id, prior context intact, prompt on stdin, `session.directory`
   * unchanged.
   *
   * Offered for every ROOT session this store knows of, launched by this
   * panel or opened in a terminal — the join is the session id read from
   * `opencode.db`, never a guessed pid (#231 stays intact). A worker gets no
   * channel of its own: the foreman hop for OpenCode is unmeasured and out
   * of scope (#534).
   *
   * A ✓ means what it means everywhere else and no more: the turn was
   * handed over, not read. The verdict is taken once the process has
   * survived a short bounded start window, exactly as the Codex sibling's
   * is — see opencodeContinue.ts.
   *
   * It carries no attachment (`run -f` exists and is unmeasured here) and no
   * kick: the turn a continuation starts runs in its own process, which this
   * panel never holds a handle to.
   */
  | 'opencode-run-continue'

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
  /**
   * Where this ask can be answered — the same reading DwarfPermissionRequest
   * carries, and deliberately the same type (#354).
   *
   * Stamped by whichever writer put the ask on the wire, and the two writers
   * are exhaustive and cannot overlap: the held registry stamps `'held'` on a
   * foreman it holds, SUPERSEDING the transcript's version and clearing it
   * where the registry has none (see stampHeldQuestions), and a provider that
   * read the ask out of a transcript it does not own stamps `'terminal'`. So
   * `channel === 'held'` is exactly the condition `runtime.answerDwarfQuestion`
   * guards on rather than a renderer's guess at it, and the card cannot offer
   * an answer main would refuse.
   */
  channel: DwarfPromptChannel
  /** Whether the agent said it would accept more than one option. */
  multiSelect: boolean
  /**
   * How many questions the CALL that raised this ask carried — 1 for almost
   * every ask, and more for the one shape this panel cannot answer (#362).
   *
   * Only the first question of a call travels, and both writers say so at
   * length (askedQuestion in the Claude parse, askToWireQuestion for a held
   * session). This is the fact that omission leaves behind, and it is on the
   * wire because two surfaces have to act on it rather than guess: an answer
   * typed at the console walks the picker ON to question 2, which the panel
   * does not know exists, so a several-question ask is refused before a key is
   * pressed and the card says why up front (see ANSWER_ONLY_WHERE_IT_RUNS).
   *
   * The COUNT and nothing else: it says how many were asked, never which — the
   * same narrowness Claude's pendingBackgroundAgentCount holds. Required rather
   * than optional, because every writer counts its own source's array and a
   * missing value would be a third state a refusal cannot be based on.
   */
  questionCount: number
  options: DwarfQuestionOption[]
  /** When the ask was written, as the provider recorded it. */
  askedAt?: string
}

/**
 * Where an answer to a prompt this panel is showing can be given (#203, #354).
 *
 * ONE closed field on the prompt rather than a second wire type, and the
 * reason is that the two channels differ in exactly one thing the panel has to
 * know and nothing else. The card is identical — the same words, the same
 * options — because the prompt is the same prompt; what differs is what
 * happens after the click and therefore what the panel may honestly claim
 * afterwards. A second type would have duplicated every field the card reads
 * in order to carry that one bit, and the renderer would have had to branch on
 * which type it held before it could draw anything.
 *
 * - `'held'`: the panel owns this session's stream, so the answer releases the
 *   blocked call through the Agent SDK — `canUseTool` for a permission (#246),
 *   the blocked `AskUserQuestion` for a question (#125) — and either succeeds
 *   or does not, locally and at once.
 * - `'terminal'`: the panel only WATCHES this session, so the answer belongs
 *   to the console the session runs in rather than to this panel.
 *
 * ONE type for BOTH prompts on purpose, because both cards have to make the
 * same call and two readings of one fact is how they would come to disagree
 * (#354). What each card then DOES with `'terminal'` is the one thing that
 * differs, and the difference is evidence rather than taste:
 *
 * - A permission's two answers are Claude Code's own fixed keystrokes, and
 *   they have been measured on this build, so the panel may type one into the
 *   console. That can fail where the held path cannot — a window that will not
 *   focus — and even when it succeeds it proves only that the key was typed,
 *   never that the session acted on it.
 * - A question's answer is arbitrary text the agent enumerated, which no
 *   measured keystroke delivers, so the panel offers no answer at all: it
 *   draws the ask, leaves the options inert, and points at the terminal with
 *   ANSWER_ONLY_WHERE_IT_RUNS beside a jump.
 *
 * Derived in main, where the evidence is, and never re-derived in the renderer
 * from `provider` or `textDelivery` — neither answers the question. Closed
 * rather than optional: every prompt that reaches the panel arrived by one of
 * these two routes, and a missing value would be a third state nobody can act
 * on.
 */
export type DwarfPromptChannel = 'held' | 'terminal'

/**
 * What main returns, and what the panel prints, for the one ask that still
 * cannot be answered from here: a call that asked SEVERAL questions (#265,
 * #354, #360, #362).
 *
 * ONE string, on the wire, because two surfaces say it: `answerDwarfQuestion`
 * returns it to anything that asks anyway, and DwarfQuestionCard prints it in
 * advance so nobody has to click to find out where the answer goes. A second
 * copy in the renderer would be two sentences for one fact, which is how a
 * panel starts sounding like two apps.
 *
 * AMENDED for #360: this used to say the answer belonged to a terminal "which
 * for a Codex thread is its own". The channel is not Codex-specific — a
 * question read out of an OBSERVED Claude Code session's transcript is stamped
 * `'terminal'` too — so a Claude session's card was telling its reader about a
 * Codex thread. Nothing here names a provider now, because the field it is
 * printed for never implied one.
 *
 * AMENDED again for #362 for what it is ABOUT. The terminal channel by itself
 * is no longer unanswerable: a one-question ask is typed into the session's own
 * console (see questionKeys.ts for the measurement). What is left is a call
 * carrying more than one question, because only its first reaches the wire and
 * an answer typed to it walks the picker on to one the panel cannot see. So
 * this sentence says which ask it is about, and still says the two things it
 * always said: the answer belongs to the session's own terminal, and the panel
 * is showing the ask rather than holding it.
 *
 * Phrased off the renderer's OPEN_TURN_NO_INTERRUPT_HINT deliberately: that is
 * the sentence this app already uses for the other thing that can only happen
 * where the session runs. It lives HERE rather than beside that one because
 * main is the process that has to return it, and nothing in main may import
 * the renderer — the wire boundary is the only place both sides may read.
 */
export const ANSWER_ONLY_WHERE_IT_RUNS =
  'This ask carries several questions, and only where the session runs — its own terminal — ' +
  'can they be answered in order. The panel is showing the ask, not holding it.'

/**
 * The other four things main can return for an ask it was asked to type, each
 * a different fact about the person's own session (#362).
 *
 * Separate constants rather than one "could not answer" sentence, and beside
 * ANSWER_ONLY_WHERE_IT_RUNS rather than in main, for the reason that one is
 * here: main returns them and the card prints them verbatim, so the wire
 * boundary is the only place both processes may read one spelling of each.
 *
 * None of them names a provider, exactly as the sentence above no longer does
 * (#360). What decides each is the channel and the platform, and a session's
 * CLI is not what the panel learnt it from.
 */
export const ANSWER_NEEDS_ITS_CONSOLE =
  'The panel could not reach the console this session runs in. Answer the ask there.'
/**
 * An optional port method that is absent, stated rather than silently skipped —
 * the discipline NO_TERMINAL_END_TIER holds for the kick. macOS and Linux have
 * no arrow key behind their console adapter yet (#367), so they carry no
 * question-answer tier and this is the honest sentence for one.
 */
export const NO_ANSWER_KEYSTROKE_TIER =
  "This build can't type an answer into a session's own console. Answer the ask at its terminal."
/** A label with no option behind it: nothing on this route may invent a row to press. */
export const ANSWER_OPTION_NOT_OFFERED =
  'The agent did not offer that option, so nothing was typed.'
/**
 * A set of choices this ask cannot take — nothing chosen at all, more than the
 * ask said it accepts, or one option twice (which a toggling digit would leave
 * switched off). One sentence for the family, because each of them means the
 * same thing to the person: press again, and what they pressed is still open.
 */
export const ANSWER_NOT_A_CHOICE_THIS_ASK_TAKES =
  'That is not a set of answers this ask takes, so nothing was typed.'
/**
 * The ask named by the answer is not the one that is open now (#362).
 *
 * The sibling of the permission route's PROMPT_NO_LONGER_OPEN, and it exists
 * for the same reason a keystroke needs it at all: a key answers whatever
 * picker is really on screen, so an answer aimed at an ask that has since been
 * dealt with would choose an option in the NEXT one, unread.
 */
export const ASK_NO_LONGER_OPEN = 'That question is no longer the one waiting.'

/**
 * The four things main can return for an answer written in the person's own
 * words (#481).
 *
 * Beside the option route's five above, for the reason they are all here: main
 * returns them and the card prints them verbatim, so the wire boundary is the
 * only place both processes may read one spelling of each. Each names a
 * different fact about the person's own session rather than one "could not
 * answer" — what to do next differs for every one of them.
 *
 * None of them says the route does not exist. It does, it is measured
 * (2026-09-18, see main's questionKeys.ts), and these are the shapes around
 * its edges.
 */
export const OTHER_ROW_NOT_MEASURED_FOR_THIS_ASK =
  'Only an ask that takes one answer, with nine options or fewer, has a measured way to its ' +
  'picker\'s own "Other" row. Answer this one at the terminal, in your own words.'
/** Nothing in the box, so the Enter behind it would answer with an empty field. */
export const NOTHING_TYPED_TO_ANSWER_WITH =
  'There was nothing written to send, so nothing was typed.'
/**
 * Refused rather than repaired, and the sentence says which words to change:
 * every repair available here — dropping the line break, turning it into a
 * space — would hand the agent a sentence the person did not write.
 */
export const TYPED_ANSWER_WOULD_STEER_THE_PICKER =
  'Those words carry a line break or an escape, and the picker reads both as keys of its own — ' +
  'the line break would send the answer half-written. Take them out, or answer at the terminal.'
/**
 * The held channel's own refusal. The held path hands the agent's blocked tool
 * call the labels the ask carried (`resolveAnswers`), and what it does with
 * anything else is unmeasured; the held card offers a message box instead, so
 * nothing on screen reaches this — it is the guard behind that box.
 */
export const TYPED_ANSWER_ONLY_AT_A_PICKER =
  'This panel is holding that session, where an answer can only be one of the options the agent ' +
  'offered. Write to it as a message instead, or choose an option above.'

/**
 * What both cards show in place of their free-text box, and what main returns
 * for a message sent to a dwarf anyway, while a prompt of its own stands at its
 * terminal (#481).
 *
 * The fact underneath is that a session drawing a picker is not reading a
 * prompt. Free text from a card leaves on the ordinary MESSAGE path, and on
 * this channel that path writes into the session's own console (#182, #362,
 * #371) — so the letters are picker input, digits among them jump between
 * options, and the Enter behind the message confirms whichever option is
 * highlighted. The person's words are lost and the agent is handed an answer
 * nobody chose. Measured by the maintainer on 2026-09-18, on a two-option ask
 * that received option 1.
 *
 * ONE string on the wire for the reason ANSWER_ONLY_WHERE_IT_RUNS is one: two
 * surfaces say it — the cards up front, so nobody types to find out, and
 * `sendDwarfText` to anything that sends anyway — and a second copy would be
 * two sentences for one fact.
 *
 * Three clauses, and each is load-bearing. What is happening (a picker at that
 * terminal), what typing here would really do (that picker reads it, and its
 * Enter confirms), and the two ways out that do work — the options on the card,
 * or the person's own words at the terminal. Names no provider, exactly as the
 * sentences above no longer do (#360): the channel is what decides this.
 *
 * Says nothing about an "Other" row. Claude Code's picker has one, and the
 * keystrokes that would reach it are unmeasured (#481 item 3) — a sentence
 * promising that route before anybody has watched it work is the kind this file
 * exists not to make.
 */
export const TYPED_HERE_REACHES_THE_PICKER =
  'This session is showing a picker at its terminal, and anything typed here would be read by ' +
  'that picker — the Enter behind it confirms whichever option is highlighted. Choose an option ' +
  'above, or answer in your own words at the terminal.'

/**
 * The rows Claude Code's `AskUserQuestion` picker numbers, and therefore the
 * last option that has a digit of its own (#362, #402).
 *
 * On the wire rather than in main because the renderer counts to the same
 * number now (see `askHasAReachableOtherRow`), and a second spelling of a
 * measured nine is how the card and the keys would come to disagree about which
 * ask can be typed into. The measurement itself stays where it was taken —
 * main's `textDelivery/questionKeys.ts` and docs/console-hosting.md §§4c, 6.
 */
export const MAX_PICKER_NUMBERED_ROWS = 9

/**
 * Whether this ask's picker has an "Other" row that a MEASURED sequence of keys
 * reaches (#481).
 *
 * One rule, read by both processes and for two different decisions: the card
 * offers its free-text box off this, and main builds the keystrokes off it (see
 * `questionFreeTextChunks`). A box a person may type into that main would then
 * refuse is the worst of the two failures available here, so the two sides read
 * one function rather than two spellings of one reading.
 *
 * Measured on Claude Code 2.1.276, Windows Terminal, 2026-09-18, at the
 * keyboard: on a single-question, single-select ask the digit one past the last
 * option lands on the Other row with its field ready, and one Enter behind the
 * typed text sends it. Each condition below is a shape that reading does NOT
 * cover, and each is a refusal rather than an attempt:
 *
 * - **Several questions in the call.** Only the first reaches the wire, so an
 *   answer walks the picker on to one the panel cannot see (see
 *   ANSWER_ONLY_WHERE_IT_RUNS).
 * - **A multi-select ask.** Enter TOGGLES the row a multi-select cursor is on
 *   (#362, round 1), so what it does on that picker's Other row is a different
 *   gesture and nobody's finding.
 * - **More options than the picker numbers rows.** The digit runs out and the
 *   list is where the rows may start scrolling, which is exactly where a
 *   counted arrow walk stops being derivable from the measurement.
 * - **No options at all.** Both routes to the row are counted off the options —
 *   the digit is N+1, the arrows are N of them — so an ask with none of them
 *   counts to a row nobody has seen.
 *
 * Says nothing about the CHANNEL, deliberately: where the prompt is drawn is a
 * separate fact each caller already holds (see DwarfPromptChannel), and folding
 * it in here would give both of them a second reading of something they know.
 */
export function askHasAReachableOtherRow(question: DwarfQuestion): boolean {
  return (
    question.questionCount === 1 &&
    !question.multiSelect &&
    question.options.length >= 1 &&
    question.options.length <= MAX_PICKER_NUMBERED_ROWS
  )
}

/**
 * A tool call a session is blocked on until somebody approves it (#203).
 *
 * A SIBLING of DwarfQuestion, deliberately not a variant of it. That type's
 * contract is that the panel repeats the agent's own words — the question and
 * the answers the model enumerated. A permission prompt is the other way
 * round: the model wrote nothing to choose between, and the two answers are
 * Claude Code's, fixed for every prompt. Folding one into the other would have
 * meant a `DwarfQuestion` whose option labels this app invented, which is the
 * one thing that type promises never happens.
 *
 * Two sessions can raise one, from two different kinds of evidence — see
 * `channel` above:
 *
 * - A session the panel HOLDS delivers the prompt itself, through the Agent
 *   SDK's `canUseTool` callback, which carries the request as data and takes
 *   a decision back.
 * - A session the panel only OBSERVES delivers it in two halves that name
 *   each other. Claude Code's `permission_prompt` Notification says a dialog
 *   is open for that `session_id` and never what it asks; the assistant's own
 *   `tool_use` block, written to the transcript BEFORE the dialog opens and
 *   left unresolved by any `tool_result` while it stands, says exactly what.
 *   Neither half alone names a request; together they do, and nothing in
 *   either is parsed out of prose.
 *
 * `title` and `description` are the CLI's own rendering of the prompt
 * ("Claude wants to run …"), passed through when the bridge supplied them and
 * absent otherwise; nothing here is composed from prose. An observed session
 * carries neither — the CLI renders that sentence into a terminal this app
 * cannot read. `input` is a compact, redacted reading of the tool's
 * structured input — the command, the path, or the whole input as JSON —
 * capped so a pasted file never becomes the card. `toolUseId` makes the round
 * trip observable exactly as it does for an ask: on the held channel the
 * decision is released against this id and no other, and on the terminal
 * channel it is what a later `tool_result` will name when the session
 * finally acts.
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
  /** Which way a decision on this prompt travels back. */
  channel: DwarfPromptChannel
  /** When this host received the prompt — the only honest clock there is. */
  askedAt: string
}

/**
 * The two answers a permission prompt takes. Claude Code's own vocabulary,
 * and deliberately not its third one: "always allow" writes a rule into the
 * user's settings, and this slice offers nothing that outlives the prompt.
 */
export type DwarfPermissionDecision = 'allow' | 'deny'

/**
 * Where a dwarf actually works, when that is not the mine's own folder (#348).
 *
 * Every worktree of one repository folds into the main working tree's mine —
 * the repository is the project, a worktree is a place it is being worked on —
 * so a mine's crew can be spread over several folders. This is the one that
 * belongs to THIS dwarf: its session's own cwd, which is where its files are,
 * where its transcript's `cwd` points, and what a relative path on an activity
 * line resolves against (#279).
 *
 * `path` is the session's cwd, not the worktree's top folder: a session started
 * in a subfolder resolves its relative paths against that subfolder, and
 * substituting the folder above it would open the wrong file.
 *
 * `branch` is the branch the worktree has checked out, read from its own HEAD.
 * ABSENT MEANS DETACHED, never "no branch was looked for" — a detached worktree
 * has a commit where a branch would be, and the wire deliberately does not
 * carry it: a short sha is not a name a person navigates by, so the panel says
 * the folder instead.
 */
export interface DwarfWorkplace {
  path: string
  branch?: string
}

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
  /**
   * Which worktree of the mine's repository this dwarf is in (#348).
   *
   * ABSENT MEANS THE MINE'S OWN FOLDER, like every other optional fact on this
   * wire: only a dwarf main can positively say is working somewhere else
   * carries one. Anything resolving a path FOR A DWARF reads this first and
   * falls back to `Mine.path` — see DwarfWorkplace.
   */
  workplace?: DwarfWorkplace
  pid?: number
  startedAt?: number
  /**
   * When the process behind `pid` was CREATED, epoch ms, and only when the
   * provider has verified it against the machine (#329, #231).
   *
   * Not `startedAt`, which is the session's own record of when it began and
   * proves nothing about a pid: a pid is a number the OS recycles, and the
   * creation time is the one fact an unrelated process wearing that recycled
   * number cannot forge. So this is what licenses an act that cannot be taken
   * back — Kick ends a terminal session's process tree, and it may only do so
   * on a pid whose identity was proved.
   *
   * ABSENT MEANS UNVERIFIED, and unverified is a refusal rather than a
   * permission. Claude fills it from its registry's `procStart` only when
   * probing that pid AGREED with it; where the registry records no procStart,
   * where no probe is wired, or where the probe could not answer, the provider
   * leaves a live dwarf on the board (a pid-reuse guard must never make a
   * running session disappear) and this field simply is not there. Every other
   * provider leaves it absent too.
   *
   * A reading, never a promise. It says the pid was this process at the last
   * poll, so anything about to signal that pid re-probes and compares against
   * this value at the moment of the act rather than trusting the poll — see
   * `EndSessionRequest.expectedStartMs`.
   */
  pidStartedAt?: number
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
   *
   * A provider whose store freezes the mtime for the life of the file — Codex
   * on Windows, docs/codex-v2-format.md §4 — stamps the freshest write it can
   * PROVE instead: the scan that saw the file grow, else its registry's own
   * stamp, and never a value older than the one it last published (#458).
   * A provider with no file at all — OpenCode, whose conversation is rows in
   * a store — stamps the newest of its session's own facts: the session row's
   * `time_updated`, the newest assistant row's time, and the scan that last
   * saw its `event.seq` move (#459); never the store's WAL mtime, one file
   * for every session. The field's job is unchanged either way: it moves
   * when a writer wrote, whoever the writer was.
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
   * This held session's own context-window reading, pulled on demand rather
   * than carried by any stream message (issue #96) — see DwarfContextUsage for
   * why it needs its own writer instead of riding the `init`/`result` loop
   * `model`, `mcpServers` and `totalCostUsd` already do.
   *
   * Held sessions ONLY, for the same reason those three are. Absent means one
   * of two things and deliberately does not distinguish them: this is not a
   * held session, or it is one no reading has been pulled for yet — the same
   * asymmetry `mcpServers`' own doc comment draws for its absence. Never
   * `0 / 0`: an untaken measurement is left out rather than drawn as one.
   */
  contextUsage?: DwarfContextUsage
  /**
   * What this session will let the panel change about itself mid-run, and
   * what it has been asked to change but nothing has confirmed yet (issue
   * #96) — see DwarfSessionTuning, which carries the whole reasoning.
   *
   * Held sessions only, and stamped on every poll beside `contextUsage`.
   * Absent means one of two things and deliberately does not distinguish
   * them: this is not a session the panel holds, or it is one whose engine
   * offers no such act — either way the panel offers no control, which is the
   * same answer.
   */
  sessionTuning?: DwarfSessionTuning
  /**
   * ONE row: the prompt this app itself sent to start a session it is HOLDING
   * (#159, #194), as the registry seeded it first-hand.
   *
   * A launch RECEIPT and nothing else, which is the whole of why a single row
   * still rides every poll (#436). The Add Panel recognises the dwarf of the
   * session it just launched by this prompt and by no other evidence — the
   * launch verdict deliberately carries no dwarf id (#86), and main opens no
   * `launchId` receipt for a held launch because it never needed one. See
   * `launchedDwarfIn` in the renderer, which is the only reader.
   *
   * It used to be the whole exchange, and that is what #436 ended: the words a
   * held session says are now served on demand like an observed session's, off
   * `getDwarfFeed` (see DwarfFeedResult.source), so nothing a session SAYS
   * rides the snapshot any more and nothing has to be cut to keep the push
   * small. What is left here is one row that cannot grow — the prompt was
   * bounded before it was ever sent.
   *
   * Two things hold a stream and both seed this identically: a held Claude
   * session off the Agent SDK, and a hosted process off its own stdin (#194).
   * Absent means one of two things and deliberately does not distinguish them:
   * this is not a held session, or it is one launched with no prompt at all.
   */
  openingPrompt?: FeedMessage
  /**
   * The receipt of a launch the Add Panel made itself, once main has PROVED
   * this dwarf is that launch's session (#191).
   *
   * Why the panel needs one at all: submitting has to hand over to this
   * dwarf's MessagePanel, and the launch verdict deliberately carries no dwarf
   * id — the session's id is not known at that moment, and claiming one there
   * would be the second observation path #86 refuses. A HELD launch leaves its
   * receipt on the board already, because the registry seeds the new session's
   * exchange with the exact prompt that was sent, so `openingPrompt` IS
   * the evidence. A DETACHED launch seeds nothing, and for a long
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
  /**
   * True when this session's whole PROCESS is ONE prompt and one turn: it was
   * handed its instruction on stdin and exits when it finishes (#231).
   *
   * AMENDED for #450 (was: '…so it has no inbox and never will'). That last
   * clause is false for Codex since the resume channel: `codex exec resume
   * <id> -` starts a NEW process on the same thread, context intact, so the
   * session behind a finished one-shot run is reachable after all. What the
   * field still says is exactly what it is for — no live process, no console,
   * and no exit this panel can offer — and what it never said is who started
   * it. A reader deciding whether a message can land must read the channel,
   * which is the one place that answer lives.
   *
   * A fact about the SESSION, not about who started it, and that is what it is
   * for. The panel already had an honest sentence for a launch of its OWN —
   * "takes no messages: it reads one prompt and exits with its turn. Kick ends
   * it." — resolved from `capabilities.cancel` (#217). The same shape started
   * from a terminal, or by a run of this app that has since restarted and can
   * no longer prove which process it was, had neither a channel nor an exit,
   * and fell back to the generic "this session type can't receive messages
   * yet" — which describes a gap in this app rather than the session in front
   * of the reader.
   *
   * Since #450 that reader is Codex-shaped no longer: the same registry row
   * that stamps this field is the one the resume channel is offered from, so
   * such a dwarf has a channel and only its EXIT is still missing. The field
   * stayed because that is what it always described — a session with no live
   * process to end — and the sentence it used to summon is now reached by
   * nobody (see oneShotNoExitReason in the renderer's actionBar.ts).
   *
   * Codex is the one provider that can say it today: `codex exec` writes its
   * registry row with a `source` tag of its own, distinct from the 'cli' tag
   * the queue capability is proven against (#97). Absent is the ordinary case
   * and claims nothing — a build that spells that tag otherwise leaves the
   * field off, and the panel says what it said before rather than something
   * wrong.
   */
  oneShot?: boolean
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
   *
   * AMENDED for #293: null means nothing can INTERRUPT this session, and no
   * longer that the Kick control is dead. The control stays enabled and its
   * act changes — the dwarf is dismissed from the board rather than the turn
   * being cut short (see DwarfKickVia). So nothing may read a null here as
   * "offer no kick"; it decides WHICH kick to offer.
   */
  cancel: TextDeliveryChannel | null
  /**
   * Always null in v1: no provider exposes a channel to change a running
   * session's effort. Modeled now so a future channel plugs in without a UI change.
   */
  adjustEffort: null
  /**
   * Which channel would carry a FILE, or null when none would (#408).
   *
   * Never wider than `sendText` and usually narrower: a message is a string and
   * every channel takes one, while only the two in `ATTACHMENT_CHANNELS` were
   * measured to carry bytes or a path the session can open. So a dwarf may take
   * words and refuse files, and the panel says which — that is the whole reason
   * this is a third member rather than a boolean read off `sendText`.
   *
   * It is null on every relay tier, which includes macOS and Linux for an
   * observed session: there is no console-write message tier there, so
   * `resolveTextDelivery` degrades `terminal` to `claude-relay` and this follows
   * it down. Nothing in the UI infers that; it reads this.
   */
  attach: TextDeliveryChannel | null
  /**
   * The longest message this dwarf's send route can actually carry (#431).
   *
   * A NUMBER where every other member is a channel, because this one answers a
   * different question about the same route: not whether a message can go, but
   * how much of one. It is here rather than derived in the renderer from
   * `sendText` for the reason the rest of the matrix is here — the panel must
   * refuse exactly what main refuses. `resolve.ts` stamps it from the ENDPOINT
   * a send resolves to rather than from the channel it reports, which is the
   * distinction `maxTextCharsFor` exists for.
   *
   * ABSENT MEANS "work it out from the channel this dwarf reports" —
   * `maxTextCharsFor(dwarf.textDelivery)`, which is what the composer does. The
   * routes agreed on one number for one release (#433) and disagree again since
   * #437: the Codex queue keeps a real command-line bound and everything else
   * answers the wire's sanity ceiling. Main stamps this on every poll, so
   * absence is a matrix written before this member existed (or by hand in a
   * test), and the fallback is the closest honest reading of one.
   */
  maxTextChars?: number
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

/**
 * What KIND of work one tool call did (#240) — the machine-readable half of a
 * feed activity line, whose human half is the message's own `text`.
 *
 * Four values, and they are the four verbs `screens/mine.md`'s activity-line
 * amendment names: `Edited`, `Ran`, `Read`, `Searched`. Which tool maps to
 * which is `domain/permissionSummary.ts`'s table — the SAME one a permission
 * card reads, so a call reads the same before and after it ran.
 *
 * On the wire rather than derived in the renderer because `target` alone
 * cannot say what it is: a path, a command and a glob are all strings, and the
 * consumer that makes a path clickable has to know which of the three it
 * holds. Nothing draws differently per kind today; the panel draws one line
 * for all four.
 */
export type FeedActivityKind = 'edit' | 'run' | 'read' | 'search'

/**
 * The subject of one tool call, beside the kind of call it was (#240).
 *
 * `target` is the path, command or pattern itself, capped and redacted at the
 * same boundary the message's `text` is — it crosses processes exactly as
 * `lastMessage` does, so it gets `redactSecrets` where the feed text gets it
 * (see permissionSummary.toolActivityLine).
 *
 * Deliberately NOT the verb: the verb is spelled once, in the table that owns
 * it, and reaches the panel already inside `text`. A second copy here would be
 * two places to correct a word.
 */
export interface FeedActivity {
  kind: FeedActivityKind
  target: string
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
  /**
   * Present when this message is a TOOL CALL rather than something said
   * (#240) — one line the panel draws between the speech bubbles, in the meta
   * token and the panel's muted ink, with no portrait and no bubble surface.
   *
   * An optional field beside `role`/`text` rather than a sibling union, for
   * the reason `issuer` is one: `role` is the half of the exchange a message
   * belongs to, and every consumer switches on it. A third role value would
   * make every one of those switches wrong until it was widened, for a message
   * that IS an assistant turn — the agent acting rather than speaking.
   *
   * So the pair stays meaningful on its own: `role` is `'assistant'` and
   * `text` is the whole line (`Edited src/main/index.ts`), which is what an
   * older reader draws — a true sentence in a bubble rather than an empty one.
   * A reader that knows about this field draws the line instead, and either
   * way it counts as ONE message in the panel's window.
   */
  activity?: FeedActivity
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
  /**
   * `'held'` when these rows are FIRST-HAND: the exchange this app itself
   * watched go by on a stream it holds, answered out of main's own memory
   * rather than read off anybody's transcript (#436).
   *
   * Absent is the ordinary reading and means observed — a bounded tail somebody
   * else wrote — so every result built before this field existed still says
   * exactly what it always said. The panel draws the two claims differently
   * (`HELD_NOTE` against `OBSERVED_NOTE`), which is the whole reason the source
   * travels with the rows instead of being re-derived from the dwarf: once the
   * words stopped riding the snapshot, nothing on the dwarf could tell them
   * apart any more.
   */
  source?: 'held'
}

/**
 * WHERE the panel has already read back to, so the next page can start below it
 * (#364) — the oldest text the panel is holding, named by its own content.
 *
 * Named by CONTENT rather than by a position, and that is the whole design.
 * The obvious cursor is a count from the end of the transcript ("I hold the
 * newest 24 texts, give me 25 through 36"), and it drifts: the poll pushes the
 * watched dwarf's feed again every time the session speaks (#196), so between
 * the click on the scrollbar and the answer the end of the file has moved, and
 * the same count names different rows. A reader who had paged back four pages
 * would get rows it already holds, or miss the ones in between, once per new
 * reply. Content does not move when the transcript grows at the far end.
 *
 * `FeedMessage` carries no id — no provider writes one this app could trust
 * across a re-read — so the pair is the identity: the timestamp the row's own
 * record carried, and the row's `text` EXACTLY as it crossed this wire, which
 * means already redacted (`domain/redactSecrets`). The page read redacts inside
 * its own walk for that reason; a cursor matched against the raw transcript
 * would never find a row whose secret had been struck out on the way here.
 *
 * A timestamp of `''` is a real value, not a missing one: an extractor falls
 * back to it for a record that carried none, and a cursor naming such a row
 * still has to work.
 *
 * Two rows can collide — the same text in the same millisecond, which is what a
 * session sending "yes" twice inside one second looks like. The match then takes
 * the NEWEST row that equals both, and the cost is one duplicated row: the page
 * starts further forward than the reader's own oldest row, so it repeats
 * conversation already on screen rather than skipping any. That is the direction
 * to be wrong in — a repeat is visible, and a gap in a transcript is not.
 */
export interface FeedPageCursor {
  timestamp: string
  text: string
}

/**
 * One request for the page of conversation immediately OLDER than a cursor
 * (#364) — the panel having scrolled to the top of what it holds.
 *
 * Addressed by DWARF, like every other dwarf channel, and carrying no page
 * size: main owns that number (`FEED_LIMIT` in `runtime/runtime.ts`), so the
 * renderer cannot ask for a read main has not budgeted for.
 */
export interface DwarfFeedPageRequest {
  dwarfId: string
  before: FeedPageCursor
}

/**
 * One page of older conversation, and whether it is the last one (#364).
 *
 * A sibling of `DwarfFeedResult` rather than a flag added to it: the newest
 * page is read on every poll for the watched dwarf (#196) and has never needed
 * to say how far back the read got, which is the same reasoning that kept
 * `readFeedWindow` and `readFeedWindowWithReachedStart` apart in #227.
 *
 * `readable: false` means this dwarf's conversation cannot be paged at all —
 * an id off the board, a provider that keeps no transcript — and is a different
 * fact from a readable page that came back empty, exactly as it is on
 * `DwarfFeedResult`.
 *
 * `reachedStart: true` means THIS PAGE IS THE LAST ONE: the read had the whole
 * transcript in hand and nothing older than the page's own oldest row was left
 * behind. The panel says so once and stops asking. `false` means there is more
 * — either genuinely older conversation, or a file that outgrew
 * `FEED_WINDOW_CEILING_BYTES` and was not read to its start. It is the #227
 * fact composed with "and this page consumed the rest of it", never just "the
 * read reached the start": a window that held the whole file can still have
 * twenty texts before the page it answered.
 */
export interface DwarfFeedPage {
  readable: boolean
  messages: FeedMessage[]
  reachedStart: boolean
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
 *
 * `reachedStart` is the fact `readFeedWindow` (`src/main/providers/feedWindow.ts`)
 * already computes and used to throw away (#227): whether the bounded read
 * behind `messages` reached the transcript's own start. `false` means the
 * widest window still filled completely and came up short of the message
 * limit — there is more conversation behind the oldest message shown, and the
 * panel says so. `true` means the read reached the start on its own, before
 * or at the ceiling; sent explicitly rather than left absent because this
 * reader always knows one or the other. Absent is reserved for a source that
 * cannot say, and means UNKNOWN, never "reached" — an absent flag draws no
 * notice, exactly as a known `true` does, so a future source that cannot
 * compute this is silent by default rather than accidentally alarming.
 */
export interface MineHistorySpeaker {
  id: string
  provider: DwarfProvider
  role: DwarfRole
  name: string
  lastMessageAt: number
  messages: FeedMessage[]
  reachedStart?: boolean
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

/**
 * A click on an activity line's own path (#279): which mine it belongs to, and
 * the exact `FeedActivity.target` string the line was built from — never a
 * path the renderer parsed out of anything itself.
 *
 * Named by MINE ID, never a folder, for the reason every other mine channel
 * does: main resolves the folder from the board it already holds, so the
 * containment check below always runs against a folder THIS process trusts
 * rather than one a renderer could hand back.
 */
export interface MineOpenPathRequest {
  mineId: string
  target: string
  /**
   * The dwarf whose activity line was clicked, when the panel knows one (#348).
   *
   * Not a folder, and that distinction is the whole point of this channel: main
   * resolves the id against the board and reads THAT dwarf's `workplace`, so a
   * mine folded from several worktrees opens the file in the folder the session
   * is actually running in. A renderer naming a folder would be a renderer
   * naming any folder.
   *
   * Absent, or naming a dwarf this mine has not got, falls back to the mine's
   * own folder — which is what every caller did before worktrees folded.
   */
  dwarfId?: string
}

/**
 * The verdict of one open-path request (#279).
 *
 * `reason` is always fixed copy this app wrote, never `shell.openPath`'s own
 * return value or a filesystem error's message — the same discipline every
 * other refusal on this wire holds. A path outside the mine's folder and a
 * path that no longer exists are told apart in the sentence, never in a
 * machine-readable code the renderer would have to translate.
 */
export type MineOpenPathResult = { opened: true } | { opened: false; reason: string }

/**
 * The verdict of one request to open a link from a bubble (#347).
 *
 * Deliberately the same shape as `MineOpenPathResult` above and deliberately
 * NOT the same type: the two channels answer different questions — one about a
 * file inside a mine, one about an address on the web — and folding them into
 * one alias would mean a change to either reason set silently rewrote the
 * other's contract.
 *
 * `reason` is one fixed sentence this app wrote, never the platform's: see
 * EXTERNAL_LINK_REFUSED_REASON for why there is exactly one of it where #279's
 * file channel has three.
 */
export type ExternalLinkResult = { opened: true } | { opened: false; reason: string }

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
 * The longest command line Windows will start a process with: 32,767
 * characters, the documented bound on `CreateProcessW`'s `lpCommandLine`
 * (https://learn.microsoft.com/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw,
 * checked 2026-09-16).
 *
 * Measured on this machine the same day rather than taken on trust: the longest
 * argv element `execFile` accepted was 32,712 characters — 32,766 of command
 * line plus the terminating NUL — and one character past it threw
 * `ENAMETOOLONG` before any process was created. Two things the documentation
 * does not say came out of the same run and both are load-bearing below: Node's
 * Windows quoting turns every `"` in an argv element into `\"`, so a payload of
 * quotation marks HALVES what fits (16,355 accepted), while a payload of
 * backslashes does not (32,712, the same as plain letters).
 *
 * On the wire because it is what bounds ONE channel's message (#431, #437). It
 * bounded every channel for two releases, because three delivery tiers handed
 * the person's words to a spawned process as ARGV. They left one at a time: the
 * console write's PowerShell script moved onto the child's stdin in #433, and
 * the relay's courier instruction moved onto `claude -p`'s in #437. What is
 * left is the Codex queue's `--message <TEXT>`, which `codex queue --help`
 * (0.153.4, checked 2026-09-16) offers no stdin form for — so this number is
 * still real, and it is now real for exactly one route.
 */
export const WINDOWS_COMMAND_LINE_LIMIT = 32_767

/**
 * What `codex queue`'s argv costs around one message, before the message itself
 * (#437).
 *
 * Itemised against the shipped `buildCodexQueueArgs` and `resolveProgram`:
 *
 * - the codex (or node) binary's own quoted path — bounded by MAX_PATH: 262
 * - the JS entry a `.cmd`/`.bat` shim resolves to, quoted, where there is one
 *   (#413) — absent for a native binary, counted anyway: 262
 * - ` queue --thread <uuid> --message `, with the separators a command line
 *   adds and a 36-character session UUID: 63
 * - up to four `[for agent <name>] ` tags, one per foreman hop, which ride
 *   INSIDE the message argument: 512
 * - the terminating NUL: 1
 *
 * 1,100, rounded up to the next power of two — the same margin #431 took on the
 * relay's own overhead, and taken here for the reason that survived: a longer
 * worker name or a deeper install path must not silently eat it.
 *
 * This is NOT the relay's old `ARGV_MESSAGE_OVERHEAD_CHARS`, which #437 deleted
 * along with the derivation it fed. That one had to reserve room for
 * `buildRelayInstruction`'s prose, the target session's name and
 * `RELAY_PROVENANCE_LINE`; none of those is in a command line any more.
 */
const CODEX_QUEUE_ARGV_OVERHEAD_CHARS = 2_048

/**
 * What quoting can multiply a message by on its way into a command line.
 *
 * Two, and it is the measured worst case rather than a guess: a payload of
 * nothing but `"` halves what fits (16,355 characters accepted where 32,712
 * plain ones were, measured 2026-09-16). Ordinary prose costs nothing at all,
 * so this is a margin most messages never spend — and it is taken anyway,
 * because a bound that only holds for well-behaved text is a bound that fails
 * on somebody's pasted JSON.
 */
const CODEX_QUEUE_QUOTING_FACTOR = 2

/**
 * The longest message the Codex queue can carry, and the last derived-from-argv
 * ceiling in this app (#437).
 *
 * `codex queue --thread <uuid> --message <TEXT>` takes the message as an argv
 * element and offers no other way in: checked against `codex queue --help` on
 * 0.153.4, 2026-09-16, which names `--thread`, `--message`, `--image`,
 * `--model` and the usual config flags, and no stdin form at all. So the queue
 * keeps the bound every channel used to share — Windows' own command-line
 * limit, less this tier's fixed argv, halved for the worst case quoting can do
 * to a payload.
 *
 * 15,359, which is the same number #431 derived for the whole app. That is a
 * coincidence of two comparable argv overheads and not a shared derivation: the
 * relay's is gone, and this one answers for one route.
 */
export const MAX_CODEX_QUEUE_TEXT_CHARS = Math.floor(
  (WINDOWS_COMMAND_LINE_LIMIT - CODEX_QUEUE_ARGV_OVERHEAD_CHARS) / CODEX_QUEUE_QUOTING_FACTOR
)

/**
 * The longest message this app will carry on the wire at all — a sanity bound
 * about MEMORY and the IPC payload, and no longer about a command line (#437).
 *
 * ## What it used to be, and why both of those reasons are gone
 *
 * 4,000 first, because a message was TYPED into the foreground console key by
 * key (#10) and a long one took the keyboard away for a minute. Nothing types
 * any more (#371, #425), so #431 replaced it with the command line, which was a
 * real bound rather than a budget: 15,359, derived from Windows' 32,767 less
 * the relay's own argv, halved for quoting.
 *
 * That second reason has now gone the same way as the first. The relay was the
 * channel that made an argv the wire's bound, and `claude -p` reads its prompt
 * from stdin when no positional prompt is given (`claude --help`, 2.1.273:
 * "Print response and exit (useful for pipes)"). Measured live on 2026-09-16
 * against a throwaway target session (docs/console-hosting.md §6): a
 * 40,000-character message handed to the relay on stdin arrived as ONE whole
 * `SendMessage`, all 40,000 characters in order, with `RELAY_PROVENANCE_LINE`
 * ahead of them. Nothing on that path has a length bound left; it has a TIME
 * cost instead, and `SENDTEXT_TIMEOUT_S` is what bounds that.
 *
 * ## What it is now, and why a quarter of a million
 *
 * A message is a string on an IPC payload that Electron structured-clones from
 * the renderer into main, and then holds in memory on both sides. 250,000
 * characters is half a megabyte of UTF-16 per message — a cost nobody notices
 * once, and an obvious mistake if it ever arrives in a loop. It is far past any
 * text a person types and past any paste made on purpose: the whole of this
 * file is under a tenth of it. So it is not a limit anyone is meant to meet; it
 * is the point at which a payload stops looking like a message, and the app
 * says so honestly rather than truncating.
 *
 * Deliberately NOT derived. A derived number invites the next reader to trust
 * the arithmetic; this one is a judgement, and the comment is where it is
 * argued. `parseDwarfText` refuses past it at the boundary and `sendDwarfText`
 * refuses past the ROUTE's own number, which for every route but the Codex
 * queue is this one.
 */
export const MAX_DWARF_TEXT_CHARS = 250_000

/**
 * The ceiling for one resolved send route — the ONE place a channel is asked
 * what it can carry (#431, #433, #437).
 *
 * Two answers now, where #433 had left one: the Codex queue's message is an
 * argv element and everything else is a stream. It is keyed on the ENDPOINT a
 * send resolves to rather than on the channel it reports, because a worker's
 * chain reports `'foreman-relay'` while writing into its foreman's own console,
 * and only the endpoint can tell those apart — `resolve.ts` stamps it from the
 * endpoint, and `runtime.ts` asks it with the endpoint too.
 *
 * No channel at all answers the wire's number rather than the queue's: nothing
 * is sent without a channel, so it only ever reaches a composer that is already
 * disabled, and naming the tightest there would state a limit no send of that
 * dwarf's would ever have met.
 */
export function maxTextCharsFor(channel: TextDeliveryChannel | null | undefined): number {
  return channel === 'codex-queue' ? MAX_CODEX_QUEUE_TEXT_CHARS : MAX_DWARF_TEXT_CHARS
}

/**
 * What would have carried this message, in one noun — the half of the refusal
 * below that names the channel rather than the number (#431).
 *
 * On the wire rather than in the renderer's `CHANNEL_HINT`, for the reason
 * `ANSWER_ONLY_WHERE_IT_RUNS` is here: main returns this sentence from
 * `sendDwarfText` and the composer prints it before anything is sent, so one
 * spelling has to be readable from both processes. Deliberately shorter than
 * `CHANNEL_HINT`'s sentences, which describe what a channel DOES; this only has
 * to finish the clause "…can carry N characters".
 */
const CHANNEL_CARRIER: Record<TextDeliveryChannel, string> = {
  terminal: "this session's own console",
  'claude-relay': "Claude Code's own messaging",
  'foreman-relay': "the relay to this worker's foreman",
  'codex-queue': "this Codex session's queue",
  'held-session': 'the stream this panel is holding open',
  // Never a send channel (#217); present because the map is total.
  'launched-process': 'this session',
  'hosted-stdin': "this process's own stdin",
  // Named apart from the queue above (#450) because they are two acts against
  // one session, and a refusal that said "queue" would send the reader looking
  // for something this route never touched.
  'codex-exec-resume': "this Codex session's next turn",
  // The OpenCode sibling of the line above (#534): the same act, against a
  // session `opencode run --session` reaches rather than `codex exec resume`.
  'opencode-run-continue': "this OpenCode session's next turn"
}

/**
 * Why a message was not sent, when the only thing wrong with it is its length
 * (#431).
 *
 * One sentence, on the wire, because three surfaces say it and they must not
 * say it differently: the composer prints it in the alert ink while the person
 * is still holding the text, `Runtime.sendDwarfText` returns it for a request
 * that reached main anyway, and the IPC boundary refuses past the wire ceiling.
 * It names the LENGTH and the LIMIT both — the attachment refusals' own rule,
 * which is that a sentence sending somebody to guess which of several ceilings
 * they hit usually sends them to the wrong one.
 *
 * It says "nothing was sent" out loud because that is the whole change #431
 * makes: the old cap cut the message and reported the remainder delivered.
 */
export function messageTooLongReason(
  length: number,
  limit: number,
  channel: TextDeliveryChannel | null | undefined
): string {
  const carrier = channel == null ? 'this channel' : CHANNEL_CARRIER[channel]
  return (
    `That message is ${length} characters and ${carrier} can carry ${limit}, ` +
    'so nothing was sent. Trim it and send again.'
  )
}

/**
 * The one line a RELAY-carried message states about itself (#378).
 *
 * Claude Code's cross-session messaging is what the relay tier hands the text
 * to, and the harness wraps whatever `SendMessage` carries in a
 * `<cross-session-message>` envelope with its own caveat attached: this came
 * from another Claude session, not from your user, treat it as a teammate's
 * request. Measured live on 2026-09-10 while verifying #376. The envelope is
 * the harness's and cannot be changed, so the only place left to say who wrote
 * the words is INSIDE them — an agent that reads the message as a peer's may
 * treat the person's own sentence as noise, as an injection attempt, or as
 * something that cannot authorise what a user's prompt could.
 *
 * A mitigation and not the fix: #371 item 2 writes into the session's own
 * console by verified pid, which makes the message the user's own prompt on
 * every tab layout — landed on Windows, so this line is now for the platforms
 * where the relay is still the channel.
 *
 * Only the relay routes prepend it. A console write and a write onto a stream
 * this panel holds arrive as the person's prompt already, so saying it there
 * would be noise the agent has to read past. It sits AHEAD of the
 * `[for agent <name>] ` tag a worker's chain adds, because the two say
 * different things: this one names the AUTHOR, that one names the RECIPIENT.
 *
 * It names no product on purpose. An agent handed the name of a tool it does
 * not know goes looking for it — what it is, whether it is real — and spends
 * a turn investigating a sentence whose only job was to say "this is your
 * user". Two facts, nothing to look up: who typed it, and that the session in
 * the envelope merely carried it.
 */
export const RELAY_PROVENANCE_LINE =
  '[Your user typed this message; another session only relayed it verbatim.]'

/**
 * `text` with a leading RELAY_PROVENANCE_LINE and the newline behind it taken
 * off, or `text` unchanged when it carries none (#378).
 *
 * The counterpart of prepending it, and the reason it is one function on the
 * wire rather than a regex in each reader: the line has to come off in the
 * transcript reader that publishes the feed AND in the renderer's echo
 * reconciliation (#309), and two copies of the same literal is how one of them
 * would be left behind — a row still carrying the line matches no echo, so the
 * panel draws the person's message twice and the ✓ never becomes ✓✓.
 *
 * Only a LEADING line is removed. One quoted further down is something the
 * agent or the person wrote about the message, not the message's own
 * provenance, and rewriting it would be editing somebody's words.
 */
export function stripRelayProvenance(text: string): string {
  const start = text.trimStart()
  if (!start.startsWith(RELAY_PROVENANCE_LINE)) return text
  return start.slice(RELAY_PROVENANCE_LINE.length).replace(/^[ \t]*\r?\n/, '')
}

/**
 * How many of a held session's own messages this app keeps in MAIN's memory
 * (#436) — the registry's own memory now, and nothing else.
 *
 * It used to be a ceiling on something that rode EVERY poll's snapshot: twelve,
 * matching the transcript feed's own limit, because a session that ran all
 * afternoon must not grow the push. #436 took the exchange off the snapshot —
 * `Runtime.dwarfFeed` answers it on demand, `FEED_LIMIT` rows at a time,
 * exactly as an observed session's tail is answered — so that reason is gone,
 * and so is the per-row cut that rode beside it (`HELD_MESSAGE_MAX_CHARS`,
 * `heldRetainedText`): a held row is no longer shortened on the way in, and a
 * dozen was never a generous number, only an affordable one.
 *
 * 200 now, because the only cost left is one session's own memory and it dies
 * with the session: a typical retained row is a few hundred bytes, so 200 of
 * them is on the order of 400 KB for one held session — and even the worst
 * case, 200 messages at MAX_DWARF_TEXT_CHARS (250,000) each, is only about
 * 40 MB, bounded and gone the moment the session ends. Still a bound rather
 * than "keep everything": a session that ran for days must not grow without
 * end either, and 200 is far past what a reader ever pages back into before
 * the transcript on disk takes over.
 *
 * Also bounds the tool-call rows a held session retains (#240, #359): a
 * retained conversation carries one row per tool call between replies, and
 * `trimFeed` in `main/providers/feedWindow.ts` is the shared rule that trims
 * both feeds and bounds the activity rows separately, so a long run of tool
 * calls cannot push every word this session said out of its own record.
 */
export const HELD_CONVERSATION_LIMIT = 200

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
  copperKb: 350,
  silverKb: 1500,
  goldKb: 12000,
  uraniumKb: 100000
}

/**
 * What an attachment IS to this app, and the distinction the whole feature
 * rests on (#408).
 *
 * `image` means the session will receive the BYTES; `file` means it will
 * receive the PATH and may open it with its own tools. That is not a taste: it
 * is what 2026-09-16's measurement found on both channels that can carry
 * anything at all (`docs/console-hosting.md` §6). A `.png` path inside a
 * bracketed paste becomes an image content block in the session's own
 * transcript; a `.txt` and a `.pdf` path arrive as ordinary text and the
 * session then reads them with an ordinary, permission-gated tool call. So the
 * two kinds promise different things, and the panel must not draw them alike.
 *
 * `path` is the person's own path on this machine and nothing is ever copied:
 * the file stays where it is, and the app hands over a path they chose. See
 * `docs/privacy.md`.
 */
export type DwarfAttachmentKind = 'image' | 'file'

/** One file the person attached to a message. */
export interface DwarfAttachment {
  /** Absolute path on this machine. Never copied, never rewritten. */
  path: string
  /** The file's own name — what the chip shows and what the echo keeps. */
  name: string
  kind: DwarfAttachmentKind
  /** Size on disk, measured in main; the limits below are read against it. */
  bytes: number
}

/**
 * The extensions that make a file an IMAGE rather than a path reference.
 *
 * Exactly the four media types the Anthropic API accepts as an image block,
 * which is what the held-session route builds, and what an observed Claude
 * session's own CLI turned out to accept through a paste. It CLASSIFIES rather
 * than gates: a file outside this list is still attachable, it just travels as
 * its path. Nothing here is a guess about a fifth format — a format nobody has
 * measured would be a promise of bytes that may never arrive.
 */
export const DWARF_IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp'] as const

/**
 * How many files one message may carry — the only limit a plain FILE ever
 * answers to (#417): only its path travels, so its size costs this message
 * nothing. The two byte ceilings below bind on an IMAGE alone.
 *
 * Declared here because the design asks for it ONCE at the wire boundary and
 * surfaced in the UI: the composer says which limit refused a file and
 * `main/index.ts` refuses a payload that broke one, and a second copy of the
 * number is how the two would come to disagree.
 */
export const MAX_DWARF_ATTACHMENTS = 5

/**
 * The Anthropic API's own documented per-image maximum for a base64-encoded
 * `image` content block, sent directly to the Claude API rather than through
 * Bedrock or Google Cloud (5 MB there) or claude.ai (10 MB, uncounted the same
 * way): 10 MB, encoded.
 * https://platform.claude.com/docs/en/build-with-claude/vision#request-limits
 * (checked 2026-09-16). The held route builds exactly this kind of block from
 * an attached image; the console route hands a path to Claude Code instead,
 * which reads the file itself and answers to no byte limit of this app's.
 */
const ANTHROPIC_API_IMAGE_BASE64_LIMIT_BYTES = 10 * 1024 * 1024

/**
 * The largest an IMAGE attachment may be on disk (#417) — never a plain file,
 * which travels as a path and costs this message nothing (issue #417's own
 * finding: the 3 MB this constant used to hold, and the 12 MB total below it,
 * were a margin the implementing agent picked, never measured against
 * anything, and both bound files that could never have broken either one).
 *
 * Base64 costs a third more than the bytes it encodes (4 encoded bytes per 3
 * raw ones), so the file this app reads off disk has to stay inside three
 * quarters of the API's own encoded ceiling for the block built from it to
 * fit: 7.5 MB.
 */
export const MAX_DWARF_ATTACHMENT_BYTES = (ANTHROPIC_API_IMAGE_BASE64_LIMIT_BYTES * 3) / 4

/**
 * How large the message's images may be TOGETHER (#417) — four times the
 * per-image limit, one fewer than the count limit, so a message that is all
 * large images is stopped by the total rather than by the count. A plain
 * file's bytes never join this sum: see MAX_DWARF_ATTACHMENTS's own comment.
 */
export const MAX_DWARF_ATTACHMENTS_TOTAL_BYTES = MAX_DWARF_ATTACHMENT_BYTES * 4

/**
 * Why one file was refused. A closed set rather than a sentence, because the
 * sentence is the panel's and the rule is the wire's — main refuses a payload
 * on the same reasons the composer declines a drop, and only the renderer
 * spells them (`renderer/src/lib/delivery/attachments.ts`).
 *
 * `directory` and `unreadable` are facts about the filesystem, so only main can
 * reach them; the other four are arithmetic over what is already pending and
 * are decided by `refuseAttachment` in both processes.
 */
export type DwarfAttachmentRefusal =
  | 'directory'
  | 'unreadable'
  | 'already-attached'
  | 'too-many'
  | 'file-too-large'
  | 'total-too-large'

/** Whether `name` names an image, by extension and without touching the disk. */
export function attachmentKindFor(name: string): DwarfAttachmentKind {
  const lower = name.toLowerCase()
  const image = DWARF_IMAGE_EXTENSIONS.some((extension) => lower.endsWith(extension))
  return image ? 'image' : 'file'
}

/**
 * Whether `candidate` may join `accepted`, and which limit says no.
 *
 * The order is the order the person needs to hear: a file they already have is
 * not a refusal about size, and a message that is already full is not about
 * this file's bytes. Reporting the count before the size keeps the sentence
 * true — naming a size limit to somebody who would have been stopped by the
 * count sends them to compress a file that was never the problem.
 *
 * The two byte ceilings bind on an IMAGE alone (#417): a plain file travels as
 * a path and costs this message nothing, so past the count and the
 * already-attached checks it is refused by neither, and its bytes never join
 * the running total an image is measured against.
 */
export function refuseAttachment(
  candidate: DwarfAttachment,
  accepted: readonly DwarfAttachment[]
): DwarfAttachmentRefusal | null {
  if (accepted.some((item) => item.path === candidate.path)) return 'already-attached'
  if (accepted.length >= MAX_DWARF_ATTACHMENTS) return 'too-many'
  if (candidate.kind !== 'image') return null
  if (candidate.bytes > MAX_DWARF_ATTACHMENT_BYTES) return 'file-too-large'
  const imageBytes = accepted
    .filter((item) => item.kind === 'image')
    .reduce((sum, item) => sum + item.bytes, candidate.bytes)
  if (imageBytes > MAX_DWARF_ATTACHMENTS_TOTAL_BYTES) return 'total-too-large'
  return null
}

/** The wire's own shape check, for the IPC boundary and for anything it feeds. */
export function isDwarfAttachment(value: unknown): value is DwarfAttachment {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (typeof record.path !== 'string' || record.path === '') return false
  if (typeof record.name !== 'string' || record.name === '') return false
  if (record.kind !== 'image' && record.kind !== 'file') return false
  return Number.isInteger(record.bytes) && (record.bytes as number) >= 0
}

/**
 * What main answers about one path the person pointed at (#408).
 *
 * Exactly one of `attachment` and `refusal` is present. The refusals reachable
 * here are the two only main can see — a directory, and a path that cannot be
 * read — because everything else is arithmetic over what is already pending,
 * which only the composer knows.
 *
 * `thumbnail` is a small data URL rendered IN MAIN, and it is why the renderer
 * never needs a path of its own: handing the panel a `file://` for an arbitrary
 * location would make every chip a reason to load anything on the disk. It is
 * absent for a file that is not an image, for an image already past the
 * per-file limit, and for one that would not decode.
 */
export interface DwarfAttachmentPick {
  path: string
  attachment?: DwarfAttachment
  refusal?: DwarfAttachmentRefusal
  thumbnail?: string
}

/**
 * Read an `attachments` field off an IPC payload, or refuse the whole list.
 *
 * Absent is `[]` rather than a refusal, because a text-only message is what
 * every caller before #408 sent. Everything else is all-or-nothing on purpose:
 * a list trimmed to what fits would hand over three of somebody's four files
 * and report success, which is the exact dishonesty this feature exists to
 * avoid. So one malformed member, one oversized file, or one limit broken takes
 * the request down, and the panel says so.
 *
 * It runs the same `refuseAttachment` the composer runs, cumulatively over what
 * it has already accepted — so the boundary cannot come to disagree with the
 * chips about which message was too big.
 */
export function parseDwarfAttachments(value: unknown): readonly DwarfAttachment[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const accepted: DwarfAttachment[] = []
  for (const candidate of value) {
    if (!isDwarfAttachment(candidate)) return null
    if (refuseAttachment(candidate, accepted) !== null) return null
    accepted.push(candidate)
  }
  return accepted
}

/**
 * Read a `text` field off an IPC payload, or refuse the whole request (#431).
 *
 * The sibling of `parseDwarfAttachments` above, in the same place and for the
 * same reason: `main/index.ts` has to refuse the message the composer would
 * have refused, and the limit it reads has to be the wire's own so the two
 * cannot come to disagree about which message was too long.
 *
 * It checks the WIRE ceiling and never a channel's, because the boundary does
 * not know which channel this dwarf will resolve to — that is the runtime's
 * question, and `sendDwarfText` asks it with `maxTextCharsFor`. Since #437 that
 * ceiling is a sanity bound about memory rather than a command line, so what
 * this refuses is a payload that stopped looking like a message at all; the
 * Codex queue's own tighter bound is still the runtime's to apply. The
 * handler's generic
 * "could not be delivered" is the honest answer for it: the length sentence
 * names a channel, and there is no channel in hand here. A message the panel
 * itself sent never reaches this refusal — the composer says so, in the
 * channel's own terms, while the person is still holding the text.
 *
 * Refused rather than cut, which is the whole of #431: a payload trimmed to
 * what fits would hand a session a message with its ending removed and report
 * it delivered.
 */
export function parseDwarfText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.length > MAX_DWARF_TEXT_CHARS ? null : value
}

/**
 * The channels a file can actually travel on, and therefore the only ones that
 * may offer the attach control (#408).
 *
 * `terminal` because a bracketed paste of the path by pid was measured to
 * attach the image to an observed Claude session, and `held-session` because
 * the Agent SDK takes image content blocks directly and needs no console at
 * all. Every other channel carries a string and nothing else: the relay hands
 * one sentence to another session, the Codex queue is a text inbox, and the
 * hosted engine's stdin has never been measured with a paste. A capability,
 * not a guess — the panel disables the control with a reason rather than
 * accepting a file it would drop on the floor.
 */
export const ATTACHMENT_CHANNELS: readonly TextDeliveryChannel[] = ['terminal', 'held-session']

/**
 * The providers whose HELD stream was measured to take a file, which is a
 * narrower question than which ones can be held at all.
 *
 * `held-session` is one channel over several protocols, and only the Agent
 * SDK's takes an image content block. Antigravity's NDJSON has no measured
 * shape for one, so a held Antigravity session offers no attach control rather
 * than promising bytes its session will never see. Same discipline as
 * `HELDABLE_PROVIDERS`, one capability further in.
 *
 * A CONSOLE needs no such list: the paste is read by whatever CLI owns that
 * console, and this app is not the one interpreting it.
 */
export const ATTACHMENT_HELD_PROVIDERS: readonly DwarfProvider[] = ['claude']

/**
 * Whether this channel can carry a file — and, for a held session, whether this
 * provider's stream can.
 *
 * `provider` is optional and its absence is a NO for a held session, never a
 * guess: the same direction every unproven capability on this wire falls in.
 */
export function channelCarriesAttachments(
  channel: TextDeliveryChannel | null,
  observer?: DwarfObserver
): boolean {
  if (channel === null || !ATTACHMENT_CHANNELS.includes(channel)) return false
  if (channel !== 'held-session') return true
  // `DwarfObserver` rather than `DwarfProvider` because that is what a dwarf
  // carries, and `'panel'` — a process this app holds over stdio — is simply
  // not in the list, which is the right answer for it.
  return (
    observer !== undefined && (ATTACHMENT_HELD_PROVIDERS as readonly string[]).includes(observer)
  )
}

/** One message the panel wants handed to a dwarf's live session. */
export interface DwarfTextRequest {
  dwarfId: string
  text: string
  /** Whether the session should also receive an ENTER, submitting the line. */
  pressEnter: boolean
  /**
   * The files the person attached, in the order the composer holds them (#408).
   *
   * Absent and empty mean the same thing to every reader, which is why it is
   * optional: a text-only message is what every caller before #408 sent, and
   * none of them had to change. What may NOT happen is a request carrying
   * attachments reaching a channel that cannot take them — that fails whole,
   * with a reason, rather than delivering the words and losing the files.
   */
  attachments?: readonly DwarfAttachment[]
}

/** Verdict of one delivery attempt. Never carries the message itself. */
export interface DwarfTextResult {
  delivered: boolean
  /** The channel used, or 'none' when no attempt was possible. */
  via: TextDeliveryChannel | 'none'
  /** Human-readable reason shown in the panel when delivered is false. */
  error?: string
  /**
   * True when the relay's own courier was killed by its timeout rather than
   * answering with a verdict at all (#439) — see TextDeliveryOutcome.unconfirmed
   * in main/textDelivery/port.ts for the full reasoning. `delivered: false`
   * alongside this means neither "confirmed delivered" nor "confirmed failed":
   * the courier may already have handed the message over before it was killed,
   * so the panel draws it like a delivery it is still watching for a reaction
   * to (see DwarfSendState.unconfirmed), never a ✕ with `Send again`.
   */
  unconfirmed?: boolean
  /**
   * Present exactly when the message was HELD rather than sent (#457, #534):
   * a panel-launched Codex thread or OpenCode session whose turn is still
   * running takes no second turn, so the panel keeps the words and continues
   * the session when that turn ends.
   *
   * `delivered` is false beside it and means what it always means — nothing
   * has been handed to anything — so a reader that knows nothing of this
   * field still draws a message that has not arrived, which is true. What the
   * field adds is that the attempt is not over: the verdict follows on
   * `dwarfSendSettled`, naming this same id.
   *
   * Minted by MAIN, for the reason `AgentLaunchResult.launchId` is: a dwarf
   * can be holding several messages at once, so the dwarf id cannot say which
   * of them a later verdict is about.
   */
  holdId?: string
}

/**
 * The verdict of a message that was HELD, once the turn it waited for ended
 * (#457).
 *
 * Push rather than pull, exactly like `LaunchFailedPush`: `sendDwarfText`
 * already answered — honestly, with `holdId` — and what happens next happens
 * minutes later, off the end of somebody else's process. There is no request
 * for the panel to make and no moment to poll for one.
 *
 * Correlated by `holdId` and never by dwarf id, because a dwarf can hold
 * several messages at once and each one is its own resumed turn.
 */
export interface DwarfSendSettledPush {
  holdId: string
  /** Which dwarf the message was for, so the store can find the bubble without a scan. */
  dwarfId: string
  /**
   * What finally happened. Never carries a `holdId` of its own: a message is
   * held once, and a verdict that could hold again would be a wait with no
   * end.
   */
  result: DwarfTextResult
}

/** One request to cancel a dwarf's current work. No user text is ever involved. */
export interface DwarfKickRequest {
  dwarfId: string
}

/**
 * What a kick actually did, and it is not always a channel (#293).
 *
 * 'none' was already one such member: no attempt was possible. 'dismiss' is
 * the second, and it is the opposite — the attempt WAS made and it succeeded,
 * it just went nowhere near the session. Where nothing can interrupt a turn
 * (the Codex queue, a protocol with no cancel, a one-shot nothing here
 * started) or the session has already ended, Kick means "I am done with this
 * one": main takes the dwarf off the board and no message is sent anywhere.
 *
 * Deliberately NOT a member of TextDeliveryChannel. That union answers how a
 * live session can be REACHED, every member of it is a real route, and the
 * total maps keyed on it (see the renderer's CHANNEL_HINT and KICK_HINT) would
 * each need an entry describing a route that does not exist. A dismissal
 * touches no session at all, so it belongs to the verdict and to nothing else.
 */
export type DwarfKickVia = TextDeliveryChannel | 'none' | 'dismiss'

/** Verdict of one kick attempt. Same shape as DwarfTextResult for a consistent panel. */
export interface DwarfKickResult {
  delivered: boolean
  /** The channel used, 'none' when no attempt was possible, or 'dismiss' — see DwarfKickVia. */
  via: DwarfKickVia
  /** Human-readable reason shown in the panel when delivered is false. */
  error?: string
}

/**
 * What the panel shows about one dwarf's most recent message: in flight, or
 * the verdict, kept just long enough to be read.
 *
 * 'delivered' and 'reacted' are two different facts, and the panel must never
 * blur them (issue #21): delivered means the text reached the session's queue,
 * reacted means the session was then SEEN acting on it. A delivery that is
 * never observed reacting stays 'delivered' — it never promotes on a guess.
 *
 * On the wire since #162, having been a renderer-local type until then. The
 * send happens in the message-panel WINDOW and the marker is drawn on the
 * dwarf's sprite in the SHELL window, so this verdict now crosses a process
 * boundary — see DwarfDeliveryReport, which is the one direction it travels.
 */
export interface DwarfSendState {
  /**
   * 'held' is the one phase that claims NOTHING (#457, #534). A message the
   * panel is holding for a Codex thread or an OpenCode session whose turn is
   * still running sits in this app's own memory: no channel has been asked
   * anything, so 'sending' would say it is in flight and 'delivered' would
   * say it was handed over, and both are false. It is its own phase for
   * exactly that reason, and it is never a resting place — every held
   * message ends as 'delivered' when its continuation fires, or as 'failed'
   * when it cannot (the session was kicked, the wait ran out, or the
   * continuation itself refused).
   */
  phase: 'sending' | 'held' | 'delivered' | 'reacted' | 'failed'
  /** The channel the delivery used, once one was chosen. */
  via?: string
  /** Why it failed, shown on the marker. */
  error?: string
  /**
   * True while a delivered message is still watching its dwarf's snapshots for
   * proof the session acted. False once that bounded window closed unobserved.
   */
  awaitingReaction?: boolean
  /**
   * True on a 'delivered' state that got there because a relay courier was
   * killed by its own timeout, not because anything confirmed the hand-over
   * (#439) — carried straight from DwarfTextResult.unconfirmed. Read only
   * alongside `phase === 'delivered'`, and never on 'failed': the whole point
   * is that this is NOT the same claim as a failure, so it decays exactly like
   * an ordinary delivered message (the reaction watch may still promote it to
   * 'reacted') while the marker keeps showing its own honest sentence instead
   * of the plain "watching" or "no reaction seen" copy — see
   * renderer/lib/delivery/deliveryVerdict.ts.
   */
  unconfirmed?: boolean
}

/**
 * What the panel shows about one dwarf's most recent kick: in flight, or the
 * verdict. Same two-phase honesty as DwarfSendState — an interrupt handed to a
 * session is not the same as a session that stopped.
 */
export interface DwarfKickState {
  phase: 'kicking' | 'delivered' | 'reacted' | 'failed'
  /** The channel the kick used, once one was chosen. */
  via?: string
  /** Why it failed, shown on the marker. */
  error?: string
  /** True while a delivered kick is still watching for proof the session stopped. */
  awaitingReaction?: boolean
}

/**
 * Every delivery verdict the message-panel window currently holds, reported to
 * the shell so the mine can draw its markers (#162).
 *
 * One writer, one reader, one direction. The composer and the kick control
 * live in the panel window, so that window owns both stores — including the
 * reaction watch, which folds each poll's snapshot in (see the renderer's
 * `useDwarfMessaging`). The marker is drawn on the dwarf's own sprite, inside
 * the mine, which is in the shell window. So the state is published rather
 * than duplicated: the shell renders these and writes none of them, and a
 * second store there could only ever disagree with this one.
 *
 * Whole maps rather than deltas, because the stores expire their own entries
 * on timers: a delta stream would need the shell to run the same timers to
 * know when a marker should be gone, which is the duplication this avoids.
 */
export interface DwarfDeliveryReport {
  /** Send verdicts, keyed by dwarf id. */
  send: Record<string, DwarfSendState>
  /** Kick verdicts, keyed by dwarf id. */
  kick: Record<string, DwarfKickState>
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

/**
 * One model a provider's own answer named, for the Add Panel's model picker
 * (#239).
 *
 * `value` is exactly what a launch's own `model` field takes — passed
 * through unchanged and never re-derived, so choosing an option and typing
 * its value by hand are the same request. `label` is a human name for it,
 * when the source has one distinct from the value; a source with no names of
 * its own (Codex's history, today) leaves it off and the panel falls back to
 * the value itself.
 */
export interface ModelOption {
  value: string
  label?: string
  /**
   * The effort levels THIS model accepts, when its own provider says so
   * (issue #96) — absent when the provider said the model takes none, or
   * said nothing about it either way.
   *
   * Per model, unlike `AgentModelCatalog.efforts`, which is the whole
   * provider's boundary list. The two are different questions and #96's
   * live-fire spike is why this one had to exist: Claude's own
   * `supportedModels()` carries `supportsEffort` per row, and
   * `applyFlagSettings({ effortLevel })` on a model without it **resolves
   * cleanly and silently does nothing**. So a surface that offers an effort
   * control needs the per-model answer; the provider-wide list would have it
   * offering a setting the active model discards without a word.
   *
   * Absence therefore means "offer no effort control", never "offer the
   * provider's list instead". Values are always a subset of the provider's
   * own `efforts`, so nothing here can name a level the launch boundary
   * would refuse.
   */
  effortLevels?: string[]
}

/**
 * Where a provider's model list came from (#239) — the same distinction
 * AgentProviderOption draws between "installed" and "launchable", applied to
 * a model list rather than a CLI: not every provider can answer this the same
 * way, and the panel has to say which kind of answer it is showing.
 *
 * - `'provider'` — the CLI's or SDK's own structured answer, asked live. The
 *   strongest claim, because it can never go stale: Claude's own
 *   `supportedModels()` today.
 * - `'history'` — inferred from what this machine has actually used, never
 *   invented: a configured default, or a value a past session recorded. Not a
 *   promise the list is complete or current, which is why the panel shows the
 *   source rather than presenting it as the CLI's own word (Codex today).
 * - `'none'` — nothing to offer. The picker is disabled with a reason rather
 *   than drawn empty (Antigravity today, until #237 gives it a launch path).
 */
export type AgentModelSource = 'provider' | 'history' | 'none'

/**
 * One provider's whole answer to "what can it run, and how hard can it
 * think" (#239).
 *
 * `efforts` is the same closed list a launch is checked against at the
 * boundary (`PROVIDER_EFFORT_LEVELS` in main/domain/launchTuning.ts) — sent
 * here so the Add Panel can draw the effort picker from the one place that
 * already knows it, rather than a second copy that could drift. Empty means
 * this provider takes no effort level at all, which is a real answer and not
 * a gap: the panel draws no effort picker for it.
 */
export interface AgentModelCatalog {
  provider: DwarfProvider
  models: ModelOption[]
  efforts: string[]
  source: AgentModelSource
}

/**
 * Every provider's model catalogue, answered on request (#239) — one entry
 * per DWARF_PROVIDERS member, whatever this build can actually say about it.
 * See listAgentModels for why this is pull-only, exactly as
 * listAgentProviders is.
 */
export interface AgentModelCatalogList {
  catalogs: AgentModelCatalog[]
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
  /**
   * The model to start on, or absent for the CLI's own default (#239).
   *
   * Absent is not a missing value, it is the instruction "whatever this CLI
   * would have done", which is what makes a launch that ignores the Add
   * Panel's model row identical to every launch before this field existed. A
   * name that IS here is checked for shape at the boundary and against the
   * catalogue main answered with, then handed to the CLI unchanged.
   *
   * A string rather than a union, because the union does not exist to be
   * written down: model names move whenever a model ships, so they live in the
   * provider's own answer (see AgentModelCatalog) and never in this file.
   *
   * Never echoed back in the verdict, either. What model a session actually
   * runs is the CLI's to report — Claude says so in `init` every turn, Codex
   * in its rollout's `turn_context` — and this side repeating its own request
   * back would be a claim rather than an observation.
   */
  model?: string
  /**
   * How hard to think, or absent for the CLI's own default (#239).
   *
   * Closed per provider and checked at the boundary against
   * `PROVIDER_EFFORT_LEVELS`, which is a table with each CLI's own help beside
   * it. Per provider because the lists genuinely differ: Codex accepts one
   * level Claude has no name for.
   */
  effort?: string
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

/**
 * Pushed when a launch this app started exits almost immediately with
 * something other than a clean 0 (#263) — never for an ordinary session end,
 * which the poll discovers like any other departure. The verdict
 * `agent:launch` answered already said `launched: true`, honestly: the
 * process really did start. This is what happened a moment later, off its
 * own channel, because nothing else this app runs would ever tell the panel
 * — stderr was discarded and the exit code went unread before this issue.
 *
 * Correlated by the SAME receipt `AgentLaunchResult.launchId` carried — never
 * a dwarf id and never a session id, for the reason `Dwarf.launchId` never is:
 * no dwarf exists to have proved this launch's identity, because the whole
 * point of this push is that none ever will.
 */
export interface LaunchFailedPush {
  launchId: string
  /** Which CLI this launch was for. Never 'none': a refused launch never spawned anything to fail. */
  provider: DwarfProvider
  mineId: string
  /** The child's own exit code, or null when it went by signal instead. */
  exitCode: number | null
  /**
   * The CLI's own words, redacted and length-capped exactly as every other
   * transcript text crossing this boundary is (see `redactSecrets`) — empty
   * when it wrote nothing to stderr before it went.
   */
  stderrTail: string
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
/**
 * Every permission mode a HELD session may be started under (#239) — the
 * Agent SDK's own `PermissionMode` MINUS `'bypassPermissions'`, which this
 * app refuses to offer from the launch panel: see sdkHeldSession.ts's module
 * comment for why "start a session in this mine" must never quietly mean
 * "and let it do anything, unattended, because nobody is watching" — that
 * argument is unchanged by this issue and is not reopened here.
 *
 * On the wire, and checked by both processes with it: main refuses a request
 * naming anything else before it ever reaches the SDK, and the Add Panel
 * draws its Permissions picker from this same list rather than a second copy
 * that could drift and offer a mode main would refuse.
 */
export const HELD_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'auto'] as const

export type HeldPermissionMode = (typeof HELD_PERMISSION_MODES)[number]

/**
 * Whether an unknown value names a mode this build will hold a session under.
 * Same reason `isDwarfProvider`/`isMineTier` are values and not casts: this
 * reads a value arriving over IPC, and an unrecognised one — `bypassPermissions`
 * above all — has to read as "not offered" rather than being passed on.
 */
export function isHeldPermissionMode(value: unknown): value is HeldPermissionMode {
  return typeof value === 'string' && (HELD_PERMISSION_MODES as readonly string[]).includes(value)
}

/**
 * The heldable providers whose held engine reads a permission mode at all
 * (#237, step 5).
 *
 * A second list beside `HELDABLE_PROVIDERS` because a prediction turned out to
 * be wrong, and it is worth recording which. `permissionsVisible` in the
 * renderer used to read heldability alone, on the reasoning that "if a second
 * provider ever became heldable this reads for it too, with no edit here".
 * One did, and it does not: `HELD_PERMISSION_MODES` above is the **Agent SDK's
 * own vocabulary**, and the Antigravity CLI has a different one — `--mode`
 * takes `accept-edits` or `plan`, and blanket approval is a
 * `--dangerously-skip-permissions` flag rather than a mode name. Not one of
 * the five words above would mean anything to it.
 *
 * So the picker is drawn from THIS list, and a provider arrives here when its
 * own permission vocabulary has been wired — never merely because it can be
 * held. Offering Claude's words to another CLI would be a control that looks
 * like it works and silently does nothing, which is the failure this whole
 * capability-list family exists to prevent.
 *
 * Re-checked against #282, which is the near miss worth naming: that issue DID
 * give Antigravity a live model catalogue and a real
 * `PROVIDER_EFFORT_LEVELS.antigravity`, so two of the launch row's three
 * pickers now draw for it. Permissions is the third and stays out, because
 * effort and permission mode are different axes: `agy --effort` is this CLI's
 * own documented three levels, and `agy --mode` is a vocabulary nothing here
 * has wired. A row filling in beside this one is not evidence for this one.
 */
export const PERMISSION_MODE_PROVIDERS: readonly DwarfProvider[] = ['claude']

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
  /**
   * The model to hold this session on, or absent for the CLI's own default
   * (#239). Same rule and same reasoning as `AgentLaunchRequest.model`.
   *
   * PER REQUEST rather than per registry, which is the change #239 made here.
   * The held registry took one model for every session it would ever start —
   * a configured default — so the Add Panel had no way to say anything about
   * the session it was starting. The configured value remains, underneath: a
   * request that names no model still gets it.
   */
  model?: string
  /**
   * How hard the held session should think, or absent for the CLI's own
   * default (#239). Forwarded to the Agent SDK's `Options.effort`, whose own
   * `EffortLevel` union is the five levels `PROVIDER_EFFORT_LEVELS.claude`
   * lists.
   */
  effort?: string
  /**
   * The permission mode to hold this session under, or absent for the CLI's
   * own default (#239) — checked against `HELD_PERMISSION_MODES` at the
   * boundary. Held Claude only: a detached or hosted launch has no `canUseTool`
   * callback for a mode to change the behaviour of, which is why this field
   * lives here and not on `AgentLaunchRequest`.
   */
  permissionMode?: HeldPermissionMode
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
 * against the ask the agent actually made, so an answer in that form can only
 * ever repeat the agent's own words back to it.
 *
 * AMENDED for #481: an answer is no longer always that form. The picker has an
 * "Other" row of its own, the keys that reach it have been measured, and the
 * `text` form below is a person answering in their own words through that row —
 * still the agent's own affordance, and still never a label this app invented.
 * Exactly one of the two forms travels.
 */
interface DwarfQuestionAnswerAddress {
  dwarfId: string
  toolUseId: string
}

/** The answer that repeats the agent's own words back to it — the form #125 shipped. */
export interface DwarfQuestionLabelAnswer extends DwarfQuestionAnswerAddress {
  answers: Record<string, string>
  text?: undefined
}

/**
 * The answer written in the person's OWN words, for the picker's "Other" row
 * (#481).
 *
 * One string and no record, because it answers the one question on the wire and
 * there is nothing for a key to distinguish. It is not free text arriving
 * somewhere — it is an ANSWER, and main types it into the row the agent's own
 * picker offers for exactly this (see questionFreeTextChunks). The held channel
 * refuses it for now: `resolveAnswers` hands the SDK the labels the ask carried,
 * and what that path does with anything else is unmeasured.
 */
export interface DwarfQuestionTextAnswer extends DwarfQuestionAnswerAddress {
  text: string
  answers?: undefined
}

/**
 * A UNION rather than one shape with two optional fields, because the two are
 * exclusive and the type is where that is cheapest to hold: a reader narrows on
 * `text` and gets the other form's field typed away, instead of every reader
 * asking "and if both are here?". The boundary (`parseAnswerRequest`) is what
 * makes the exclusion true of anything that arrives.
 */
export type DwarfQuestionAnswerRequest = DwarfQuestionLabelAnswer | DwarfQuestionTextAnswer

/**
 * How several chosen labels ride in the ONE string an answer's value is
 * (#362).
 *
 * The held channel takes a single label per question and will keep taking
 * exactly that: how the agent's own picker joins several answers is
 * unmeasured, and inventing a separator for it would make the agent read an
 * answer nobody gave (see resolveAnswers). The terminal channel is the
 * opposite case — its multi-select gesture IS measured, one digit per chosen
 * option — so several labels do have to cross the wire, and `answers` stays
 * `Record<string, string>` rather than growing a second shape for them.
 *
 * A newline, and for the property that makes the ambiguity harmless: main
 * splits the value back and matches every piece EXACTLY against the options
 * the ask carried, so a label that itself contained a newline resolves to no
 * option and is refused rather than mis-pressed. A lone label joins to itself
 * unchanged, which is why the single-select value on the wire is byte for byte
 * what it was before this existed.
 *
 * A PAIR, exported from the wire boundary and re-exported by both barrels,
 * because two processes have to agree on it: the renderer joins what a person
 * toggled and main splits it. Two local spellings of one encoding is how the
 * two sides would come to disagree about what a person chose.
 */
export const ANSWER_LABEL_SEPARATOR = '\n'

/** The chosen labels as one answer value. One label joins to itself. */
export function joinAnswerLabels(labels: readonly string[]): string {
  return labels.join(ANSWER_LABEL_SEPARATOR)
}

/**
 * One answer value back into the labels it carries. An empty string is no
 * labels rather than one empty one — nothing chosen, which every caller has to
 * refuse rather than press.
 */
export function splitAnswerLabels(answer: string): string[] {
  return answer === '' ? [] : answer.split(ANSWER_LABEL_SEPARATOR)
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
 * The one dwarf's feed a poll re-read alongside its snapshot (#196), because
 * the panel told main which observed dwarf it has open (see
 * `IPC_CHANNELS.setWatchedDwarf`) and that dwarf's own transcript signal
 * moved on this pass.
 *
 * Lives ON `MinesSnapshot` rather than as a push of its own, and that choice
 * is what keeps PublishGate honest without teaching it a new field: the gate
 * already re-publishes whenever `mines` differs from what it last sent, and
 * the one thing that triggers a read here — `transcriptUpdatedAt` or
 * `lastMessage` moving — IS a field of a dwarf inside `mines`. A snapshot
 * that carries a fresh `watchedFeed` has therefore always already changed
 * `mines` too, so the gate publishes it for that reason alone; a push
 * channel of its own would have needed a second gate to stay just as honest.
 *
 * `dwarfId` names which dwarf this feed answers for, because the panel's
 * watch can move between one poll and the next: a feed arriving for a dwarf
 * the renderer is no longer watching must be ignored rather than adopted.
 */
export interface WatchedFeedPush {
  dwarfId: string
  feed: DwarfFeedResult
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
  /**
   * The watched dwarf's feed, read on the SAME pass that already re-scanned
   * its transcript (#196) — never a second, renderer-driven pull a tick
   * later. Absent on every poll that carries no watch, or whose watched
   * dwarf's signal did not move; see WatchedFeedPush for why that absence
   * still keeps PublishGate honest.
   */
  watchedFeed?: WatchedFeedPush
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
 *
 * Two dimensions, and there is no third (#162). #159's report named one that
 * was missing: the message panel was a band docked INSIDE this window, so the
 * shell had to grow to host it and nothing here could ask for that. The panel
 * is a window of its own now (see MessagePanelState) and the shell never grows
 * for it, so the gap closed by the request staying exactly this shape.
 */
export interface PanelLayoutRequest {
  expanded: boolean
  mineOpen: boolean
  edge?: PanelEdge
}

/**
 * What the person chose in Settings' Audio section (#174, #173).
 *
 * Four VALUES rather than one master mute, because the three channels are
 * three different jobs: music is a soundtrack somebody may want quiet under a
 * call, the mine's ambience is a reading of the crew, and a voice is a bark on
 * a click. Each is scaled independently against its own base volume — 100 %
 * for music, 50 % for ambience, 75 % for a voice (see AUDIO_BASE_VOLUME in
 * lib/audio/volume.ts, which owns the mixing and is the only place those bases
 * appear).
 *
 * `musicAtStartup` is deliberately about STARTUP and nothing else. The shell's
 * own music button toggles playback for the run it is pressed in and persists
 * nothing: a person silencing the music for one meeting is not changing what
 * the app should do tomorrow, and the two facts are separate for the same
 * reason `PanelLayout.expanded` is separate from the stored edge.
 *
 * Every volume is a fraction in 0..1. Main clamps on the way in and answers
 * with what it STORED, never with the request — see the audio channels in
 * IPC_CHANNELS.
 */
export interface AudioPreferences {
  /** Whether music starts playing on launch. */
  musicAtStartup: boolean
  musicVolume: number
  ambienceVolume: number
  /**
   * The dwarf barks AND the interface sounds, which is why Settings calls this
   * row `Effects` rather than `Voices` (#323). They share one slider because
   * they are one channel: both are short, both answer a press, and a person who
   * wants the panel to stop talking back means both.
   */
  voiceVolume: number
}

/**
 * What Settings' Audio section reads before anybody has chosen anything.
 *
 * Music on, and QUIET. Every slider started at full on #174, on the reasoning
 * that a first run should demonstrate what had been added rather than ship it
 * pre-attenuated; the first live listen settled it the other way (#323) — the
 * music dominated the panel and the dwarfs barked over everything, and a level
 * that makes somebody reach for a slider on the first launch is the wrong
 * default. So: music at 10 %, the effects at 70 %, and the ambience left where
 * it was, because it is a reading of the crew rather than a soundtrack.
 *
 * These are the DEFAULT and nothing more: a stored preference keeps whatever it
 * stored, and a document that cannot be read at all falls back here. The BASE
 * volumes (100/50/75 %) are a separate knob and were not the one turned — they
 * are the renderer's mixing constants, not defaults a person can change, and
 * they live in `lib/audio/volume.ts`.
 */
export const DEFAULT_AUDIO_PREFERENCES: AudioPreferences = {
  musicAtStartup: true,
  musicVolume: 0.1,
  ambienceVolume: 1,
  voiceVolume: 0.7
}

/**
 * One volume, read as a fraction in 0..1.
 *
 * Out of range CLAMPS rather than falling back: a slider cannot mean "more
 * than all of it", so 0 and 1 are the honest reading of anything past them.
 * Anything that is not a finite number is not a volume at all and falls back —
 * `NaN` above all, which would silently mute a channel if it were clamped, and
 * would then be indistinguishable from a deliberate mute.
 */
export function clampAudioVolume(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(1, Math.max(0, value))
}

/**
 * Stored or wire document -> preferences, degrading field by field.
 *
 * Two different failures, deliberately treated differently (see the
 * `config-layering` skill). A document that is not an object at all is
 * corruption, indistinguishable from a file that was never written, and reads
 * as the defaults. A readable document with ONE unusable field keeps the other
 * three: a person who has moved three sliders should not lose all three
 * because a fourth value arrived malformed.
 *
 * Used by main (what it stores), by the preload (what may cross) and by the
 * renderer (what it mixes with), which is exactly why it is declared here.
 */
export function parseAudioPreferences(document: unknown): AudioPreferences {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { ...DEFAULT_AUDIO_PREFERENCES }
  }
  const record = document as Record<string, unknown>
  return {
    musicAtStartup:
      typeof record.musicAtStartup === 'boolean'
        ? record.musicAtStartup
        : DEFAULT_AUDIO_PREFERENCES.musicAtStartup,
    musicVolume: clampAudioVolume(record.musicVolume, DEFAULT_AUDIO_PREFERENCES.musicVolume),
    ambienceVolume: clampAudioVolume(
      record.ambienceVolume,
      DEFAULT_AUDIO_PREFERENCES.ambienceVolume
    ),
    voiceVolume: clampAudioVolume(record.voiceVolume, DEFAULT_AUDIO_PREFERENCES.voiceVolume)
  }
}

/**
 * Which of the message-panel window's two surfaces is open, or neither (#162).
 *
 * The two SHARE one window because they share one slot in the design: the Add
 * Panel is replaced by the MessagePanel when a launch is submitted, which is
 * one surface changing rather than two surfaces swapping. 'none' is the window
 * closed — hidden, not destroyed, so reopening costs no page load.
 */
export type MessagePanelSurface = 'none' | 'launch' | 'message'

/**
 * Whether a value is one of the three surfaces this build has.
 *
 * Exists for the reason isDwarfProvider does: the preload refuses to guess
 * one. A surface collapsed to a default would be the bridge deciding what the
 * panel shows — 'none' above all, which would CLOSE a window nobody asked to
 * close — so an unrecognised value crosses as '' and main refuses the request
 * outright.
 */
export function isMessagePanelSurface(value: unknown): value is MessagePanelSurface {
  return value === 'none' || value === 'launch' || value === 'message'
}

/**
 * The two ends of a drag on the message panel's own header (#296).
 *
 * This is the whole of what the renderer says about moving the window: the
 * press landed on the header, and the press is over. Everything between them
 * is main's — it reads the cursor on its own clock, moves the window, clamps it
 * to the display and remembers where it ended up — which is the rule
 * `PanelLayout` already holds for the shell, applied to the one thing about
 * this window a renderer could otherwise have decided.
 *
 * There is deliberately no 'move' phase, and the reason is not economy. A
 * pointer event's own position is measured inside the window, and a window
 * that is tracking the cursor moves WITH it — so the coordinates stop changing
 * and the events stop arriving exactly when the drag is working. A renderer
 * driving each step would then stall the very gesture it was driving. The
 * position that is still true throughout is the one the OS holds, and only
 * main can ask for it.
 */
export type MessagePanelDragPhase = 'start' | 'end'

/**
 * Whether a value is one of the two phases a drag has.
 *
 * Exists for the reason `isMessagePanelSurface` does: the preload refuses to
 * guess one. A phase collapsed to a default would be the bridge deciding that
 * a window should move — 'start' above all, which would begin a drag nobody
 * asked for — so an unrecognised value crosses as '' and main refuses it.
 */
export function isMessagePanelDragPhase(value: unknown): value is MessagePanelDragPhase {
  return value === 'start' || value === 'end'
}

/**
 * Which of the app's two windows a renderer is running in (#162).
 *
 * One renderer ENTRY serves both. The panel window is the same page loaded
 * with the query below, and the renderer picks its root component from it —
 * one bundle, one stylesheet, one Content-Security-Policy, rather than a
 * second build target that would duplicate all three for one component.
 */
export type RendererSurface = 'shell' | 'message-panel'

/** The query parameter that names the surface (see RendererSurface). */
export const RENDERER_SURFACE_PARAM = 'surface'

/** The value main loads the message-panel window's page with. */
export const MESSAGE_PANEL_SURFACE = 'message-panel'

/**
 * What the message-panel window is showing (#162).
 *
 * Held in MAIN and written by BOTH windows, which is the whole reason it is a
 * wire type: the shell opens the panel (a dwarf was clicked, or the mine's Add
 * action was pressed) and the panel window closes itself and adopts the dwarf
 * a launch produced. Main is the single serialization point, so the last write
 * wins and both windows are told what it became — the same read-back rule
 * `PanelLayout` follows, for the same reason.
 *
 * `mineId` and `dwarfId` are '' rather than absent where they do not apply,
 * matching how every id already crosses this bridge (see the preload's own
 * collapsing): a surface of 'none' names neither, and 'launch' names only the
 * mine, because the dwarf does not exist yet.
 */
export interface MessagePanelState {
  surface: MessagePanelSurface
  /** The mine the surface belongs to; '' when nothing is open. */
  mineId: string
  /** The dwarf a message surface is open on; '' for the other two. */
  dwarfId: string
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
/**
 * A picked folder that turned out to be a worktree of a project (#348), and
 * the project it belongs to.
 *
 * Enough for the panel to ask its question and nothing more: the folder's own
 * path so the dialog can name what was picked, the project's so it can name
 * what will be opened instead, and whichever of a branch or a short commit the
 * worktree's HEAD carries — a detached one has no branch, and naming the
 * commit is better than naming nothing about a folder somebody is being asked
 * to give up.
 *
 * The renderer never sends `root` back. "Open the main project" is a second
 * ASK with no payload, exactly as the first was, so this channel keeps the
 * property that the renderer names no path main did not choose itself.
 */
export interface MineWorktreeOf {
  /** The folder the picker returned. */
  worktree: string
  /** The main working tree — the project this worktree belongs to. */
  root: string
  /** The branch the worktree has checked out; absent when its HEAD is detached. */
  branch?: string
  /** The short commit sha, and only when HEAD is detached. */
  commit?: string
}

export interface MineDeclareResult {
  /**
   * 'worktree-of' (#348) is a QUESTION rather than a refusal, which is why it
   * is a fourth outcome and not a `failed` with a reason. Nothing went wrong
   * and nothing was declared: the folder is a slice of a project, the board
   * would fold it into that project anyway, and the person is the only one who
   * can say whether that project is the one they meant. Declaring the worktree
   * itself is deliberately not on offer.
   */
  outcome: 'added' | 'cancelled' | 'failed' | 'worktree-of'
  /** The worktree that was picked and the project behind it; only for 'worktree-of'. */
  worktreeOf?: MineWorktreeOf
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
 * Verdict of removing a mine (#85, #169). Keyed by mine id, never by path: the
 * id is what the board, the ledger and the projects store already agree on.
 *
 * 'removed' means the mine is gone from the map, the list and the board. It
 * does NOT mean the row was deleted — deletion is logical (#169): the row stays
 * flagged, its materials are untouched, and adding the same folder again
 * re-enables that same mine with its ore still on it. The one physical delete
 * in the app is Settings → Data Base → Reset metrics (see MetricsResetResult),
 * and it touches the vault rather than this list.
 *
 * 'unchanged' is a mine this app is not tracking — an id the store holds no row
 * for, or one already removed. 'failed' is a store that refused. Neither ever
 * removes anything, and both carry a reason.
 *
 * AMENDED for #169: 'reverted' is gone from the union. It meant "a live session
 * is still working this mine, so it stays as an ordinary discovered one", and
 * that outcome no longer exists — a running agent was precisely the state the
 * maintainer could not get a mine out of (Codex creates an intermediate project
 * folder and works in it), so removing is now unconditional. The name of this
 * type and of its channel are deliberately unchanged: undeclaring BECAME the
 * removal rather than gaining a sibling, and a second channel meaning the same
 * thing is the two-parallel-concepts outcome #169 ruled out.
 */
export interface MineUndeclareResult {
  outcome: 'removed' | 'unchanged' | 'failed'
  /** Why nothing changed; absent exactly when the outcome is 'removed'. */
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

/* --- System notifications (#316) — one block, appended --------------------- */

/**
 * Whether the OS notification centre may be used, before anybody has chosen.
 *
 * ON, which is #316's ruling and the only defensible default for this feature:
 * a notification exists precisely for the moment nobody is looking at the
 * panel, so shipping it off would mean the person has to already be watching in
 * order to discover the thing that tells them they need not watch.
 *
 * Here rather than in the store beside it, for the reason DEFAULT_AUDIO_
 * PREFERENCES is here: the renderer draws the switch before main has answered,
 * so both processes need the same starting value and two copies of it could
 * disagree.
 */
export const DEFAULT_NOTIFICATIONS_ENABLED = true

/**
 * The mine whose interior the shell has open, or none (#316).
 *
 * A wire type of its own rather than a bare `string | null`, because it is the
 * subject of two channels pointing in opposite directions — the renderer
 * reporting what it shows, and main asking for a mine to be opened — and naming
 * it once is what keeps them talking about the same thing.
 */
export type OpenMineId = string | null

/* --- end of the #316 block ------------------------------------------------- */

/* --- Typography preferences (#370) — one block, appended ------------------- */

/**
 * The faces Settings offers for the INTERFACE (#370, maintainer amendment
 * 2026-09-10) — everything outside messaging: labels, controls, metadata,
 * headlines, the activity lines.
 *
 * Identifiers rather than family names, and that is deliberate: what crosses
 * the wire and lands in a userData document has to survive a font's own name
 * being spelled differently by whoever hosts it (the variable cuts are
 * `Pixelify Sans Variable` and `Roboto Variable`, not `Pixelify Sans` and
 * `Roboto`). The renderer maps an identifier to a stack once, in
 * `lib/typography/fontFamilies.ts`, against tokens declared in
 * design-tokens.css.
 *
 * Ordered as the design's amendment lists them, because Settings draws the
 * segments in this order and a second ordering somewhere else would be a
 * second answer.
 */
export const INTERFACE_FONTS = ['tiny5', 'pixelify-sans', 'roboto', 'arial'] as const

export type InterfaceFont = (typeof INTERFACE_FONTS)[number]

/**
 * The faces Settings offers for MESSAGING — what a dwarf or the person SAYS,
 * plus the Add Panel, which composes exactly that.
 *
 * The same list MINUS Tiny5, and the omission is the load-bearing part. Tiny5
 * has one display weight, and #347's ruling is that a single-weight pixel face
 * cannot draw bold or carry a paragraph; #370 keeps that constraint rather
 * than reopening it. So messaging is a NARROWER vocabulary than the interface,
 * not a second one — everything here is also an interface face.
 */
export const MESSAGING_FONTS = ['pixelify-sans', 'roboto', 'arial'] as const

export type MessagingFont = (typeof MESSAGING_FONTS)[number]

/** Whether a value is a face this build can draw the interface in. */
export function isInterfaceFont(value: unknown): value is InterfaceFont {
  return INTERFACE_FONTS.includes(value as InterfaceFont)
}

/**
 * Whether a value is a face this build may set a MESSAGE in.
 *
 * `'tiny5'` answers false here and true above, which is the whole exclusion in
 * one line. It is checked at the boundary rather than only in Settings because
 * the userData document is a file a person can edit, and the parser below is
 * the one thing every process reads it through.
 */
export function isMessagingFont(value: unknown): value is MessagingFont {
  return MESSAGING_FONTS.includes(value as MessagingFont)
}

/**
 * What the person chose in Settings' Typography section (#370).
 *
 * Two INDEPENDENT choices rather than one theme, which is the acceptance
 * criterion itself: the pixel identity is worth keeping on the chrome while an
 * agent's reply — paragraphs, bold, lists — reads better in a text face, and a
 * single control could not say that. Picking the same family in both is how
 * the whole app becomes one face.
 */
export interface TypographyPreferences {
  /** Everything outside messaging. */
  interfaceFont: InterfaceFont
  /** The bubbles, the echoes, the question and permission prose, and the Add Panel. */
  messagingFont: MessagingFont
}

/**
 * What Settings' Typography section reads before anybody has chosen.
 *
 * Exactly the look #347 settled — Tiny5 for the chrome, Pixelify Sans for what
 * the crew says — so shipping this feature changes nothing for a person who
 * never opens the section. Here rather than in the store beside it, for the
 * reason DEFAULT_AUDIO_PREFERENCES is here: the renderer paints before main has
 * answered, and two copies of the starting value could disagree.
 */
export const DEFAULT_TYPOGRAPHY_PREFERENCES: TypographyPreferences = {
  interfaceFont: 'tiny5',
  messagingFont: 'pixelify-sans'
}

/**
 * Stored or wire document -> preferences, degrading field by field.
 *
 * The same asymmetry `parseAudioPreferences` carries, and for the same reasons
 * (see the `config-layering` skill): a document that is not an object at all is
 * corruption and reads as the defaults, while a readable document with one
 * unusable field keeps the other. A person who moved the interface to Roboto
 * must not lose that because the messaging field arrived as a face this build
 * cannot draw.
 *
 * Used by main (what it stores), by the preload (what may cross) and by the
 * renderer (what it paints with), which is why it is declared here.
 */
export function parseTypographyPreferences(document: unknown): TypographyPreferences {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { ...DEFAULT_TYPOGRAPHY_PREFERENCES }
  }
  const record = document as Record<string, unknown>
  return {
    interfaceFont: isInterfaceFont(record.interfaceFont)
      ? record.interfaceFont
      : DEFAULT_TYPOGRAPHY_PREFERENCES.interfaceFont,
    messagingFont: isMessagingFont(record.messagingFont)
      ? record.messagingFont
      : DEFAULT_TYPOGRAPHY_PREFERENCES.messagingFont
  }
}

/* --- end of the #370 block ------------------------------------------------- */

/* --- Jev launch routing: the API key setting (#509) — one block, appended - */

/**
 * Why the Jev routing option cannot be configured right now.
 *
 * ONE member today: the OS this machine runs offers no encryption to store a
 * key behind. The constraint that produced this feature is absolute — no
 * plaintext fallback, ever (see jevApiKey.ts) — so the option must say why
 * rather than simply vanish, which is what this reason is for. A second
 * member is additive whenever a second cause is actually observed; nothing
 * here assumes there will never be one, and nothing invents one ahead of
 * evidence.
 */
export type JevUnavailableReason = 'encryption-unavailable'

/**
 * The three routing profiles Settings offers (#509 follow-up): how readily
 * Jev may reach for a more capable, more expensive model. Closed and fixed,
 * like `DwarfProvider` — the request layer that actually SENDS one to Jev is
 * a separate task, and this is only the vocabulary Settings and that request
 * share.
 */
export const JEV_ROUTING_PROFILES = ['economy', 'balanced', 'premium'] as const

export type JevRoutingProfile = (typeof JEV_ROUTING_PROFILES)[number]

/** Whether an unknown value names a profile this build offers. */
export function isJevRoutingProfile(value: unknown): value is JevRoutingProfile {
  return typeof value === 'string' && (JEV_ROUTING_PROFILES as readonly string[]).includes(value)
}

/**
 * What Settings' profile picker reads before anybody has chosen — the middle
 * of the three, weighing cost and capability per prompt rather than starting
 * a first run already pinned to either end (user decision, 2026-09-21).
 */
export const DEFAULT_JEV_ROUTING_PROFILE: JevRoutingProfile = 'balanced'

/**
 * The launch Jev falls back to when it cannot decide (#509 follow-up): a
 * provider, model and effort the PERSON chose in Settings, never a guess this
 * app makes for them. Every field is independently optional — a default that
 * only pins a provider leaves the model and effort to that CLI's own
 * default, exactly like an ordinary untuned launch today.
 */
export interface JevLaunchDefault {
  provider?: DwarfProvider
  model?: string
  effort?: string
}

/**
 * What Settings' Jev section reads and writes once a key is configured
 * (#509 follow-up): the routing profile, and the default launch above.
 *
 * A PREFERENCE, not a secret — see the `config-layering` skill's "A secret is
 * not a setting either": unlike the key beside it, both of these are shown
 * back to the person exactly as stored, they carry nothing that must stay off
 * the wire, and a bad value degrades rather than blocking Settings from
 * opening at all.
 */
export interface JevPreferences {
  profile: JevRoutingProfile
  default: JevLaunchDefault
}

/**
 * What Settings' Jev section reads before main has ever answered, and what a
 * document too corrupt to read degrades to — balanced, and no default at
 * all, which is exactly today's behaviour before this preference existed.
 */
export const DEFAULT_JEV_PREFERENCES: JevPreferences = {
  profile: DEFAULT_JEV_ROUTING_PROFILE,
  default: {}
}

/**
 * Stored or wire document -> preferences, degrading field by field — the
 * same shape half of the `config-layering` asymmetry `parseAudioPreferences`
 * reads by, and DELIBERATELY not the `parseJevApiKeyInput` half beside it:
 * this parser reads a whole STORED document, read at startup and on every
 * Settings paint, where corruption must never block the section from
 * opening — unlike the key input, one typed value refused outright the
 * moment it cannot be a key. A default whose provider or model/effort
 * pairing could not actually be launched is refused ONE LAYER DOWN, in
 * `jevPreferences.ts`'s own `save`; this parser only ever checks shape.
 */
export function parseJevPreferences(document: unknown): JevPreferences {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) {
    return { profile: DEFAULT_JEV_PREFERENCES.profile, default: {} }
  }
  const record = document as Record<string, unknown>

  const profile = isJevRoutingProfile(record.profile)
    ? record.profile
    : DEFAULT_JEV_PREFERENCES.profile

  const rawDefault = record.default
  const defaultRecord =
    typeof rawDefault === 'object' && rawDefault !== null && !Array.isArray(rawDefault)
      ? (rawDefault as Record<string, unknown>)
      : {}

  const launchDefault: JevLaunchDefault = {}
  if (isDwarfProvider(defaultRecord.provider)) launchDefault.provider = defaultRecord.provider
  if (typeof defaultRecord.model === 'string' && defaultRecord.model.trim() !== '') {
    launchDefault.model = defaultRecord.model.trim()
  }
  if (typeof defaultRecord.effort === 'string' && defaultRecord.effort.trim() !== '') {
    launchDefault.effort = defaultRecord.effort.trim()
  }

  return { profile, default: launchDefault }
}

/**
 * What Settings' Jev section reads, and all it may EVER read (#509).
 *
 * Deliberately never the key. The renderer is told whether one is configured
 * and, when it cannot be, why — the key itself never crosses this boundary in
 * either direction. The launch router (#509) reads the real value through
 * `jevApiKey.ts`'s `readKey()`, which is main-only and never wired to an IPC
 * channel; this is the one shape that may.
 *
 * AMENDED for the #509 follow-up: `preferences` rides along on the same
 * verdict, merged in main from the key store and `jevPreferences.ts` (two
 * different files on disk, one shape on the wire). The renderer shows and
 * edits the profile and the default launch ONLY while `configured` is true —
 * Settings hides both controls otherwise — but the preferences themselves
 * are never a secret; they are plain preferences that happen to be gated on
 * one.
 */
export interface JevSettings {
  configured: boolean
  unavailableReason?: JevUnavailableReason
  preferences: JevPreferences
}

/**
 * What Settings' Jev section reads before main has ever answered.
 *
 * Unconfigured, and no reason claimed — the honest middle before the store has
 * actually checked `safeStorage.isEncryptionAvailable()`. Claiming a reason
 * here would be a guess about this machine dressed as a fact from main, the
 * same trap `DEFAULT_AUDIO_PREFERENCES` exists to avoid: the renderer paints
 * before main has answered, so both processes need the same starting value.
 * `preferences` starts at `DEFAULT_JEV_PREFERENCES` for the same reason —
 * moot while `configured` is false, since nothing renders it, but still a
 * real value rather than an absent one, so this stays a total `JevSettings`.
 */
export const DEFAULT_JEV_SETTINGS: JevSettings = {
  configured: false,
  preferences: DEFAULT_JEV_PREFERENCES
}

/**
 * Far past any real TypeSafe key, and the point of it: not a length that key
 * ever needs, but a length nothing pasted BY ACCIDENT (a whole file, a
 * README) can slip under.
 */
export const MAX_JEV_API_KEY_CHARS = 512

/**
 * Boundary parser for the key the person types into Settings (#509).
 *
 * Read by both processes that ever see the plaintext key — the preload,
 * before it lets a keystroke leave the renderer, and the store, before it
 * hands anything to `safeStorage` — so this is declared once rather than
 * risking two answers to "is this a key". THROWS rather than degrading,
 * unlike every preference parser above: those read a stored DOCUMENT, where
 * corruption must never block startup, and this reads a VALUE somebody just
 * typed, which is the other half of the `config-layering` asymmetry — a
 * legible instruction that cannot be carried out, refused with a message
 * naming what was wrong, never silently swapped for a default nobody chose.
 *
 * Trims the ends (a paste routinely carries surrounding whitespace), then
 * refuses:
 * - empty, once trimmed — nothing was typed;
 * - longer than `MAX_JEV_API_KEY_CHARS` — a paste of something that is not a
 *   key;
 * - anything outside printable ASCII, INCLUDING an embedded space — a real
 *   key is one unbroken token, and a control character, a line break or a
 *   smart quote a text field can introduce would silently corrupt the bytes
 *   TypeSafe expects back, while a space in the middle is reliably a paste
 *   that also grabbed a label or a line-wrapped display, not a key.
 */
export function parseJevApiKeyInput(payload: unknown): string {
  if (typeof payload !== 'string') {
    throw new Error(`Jev API key must be a string, received ${typeof payload}`)
  }
  const trimmed = payload.trim()
  if (trimmed === '') {
    throw new Error('Jev API key must not be empty')
  }
  if (trimmed.length > MAX_JEV_API_KEY_CHARS) {
    throw new Error(`Jev API key must be at most ${MAX_JEV_API_KEY_CHARS} characters`)
  }
  if (!/^[\x21-\x7E]+$/.test(trimmed)) {
    throw new Error('Jev API key must contain only printable, non-whitespace ASCII characters')
  }
  return trimmed
}

/* --- end of the #509 block ------------------------------------------------- */

/* --- Jev launch routing: routing a launch (#509) — one block, appended --- */

/**
 * Why Jev could not route a launch, or why its answer could not be acted on
 * (#509). Every member is a real, named way this can happen — never a
 * generic "failed" — because a network dependency on the launch path is only
 * acceptable if every way it can fail still lets the session launch, using
 * the pickers' current values (issue #509's own acceptance criterion: "When
 * Jev is unreachable, rate-limited, or returns low confidence, the launch
 * still happens ... and says that it did.").
 *
 * Lifted here from `jevRouterPort.ts` by T3: a launch result now carries this
 * same vocabulary across the wire (`JevRouteLaunchResult` below), so the
 * renderer can say WHY it fell back rather than just that it did.
 * `JevRouteDecision`, `JevRouteFallback` and `JevRouteOutcome` stay in
 * `jevRouterPort.ts` — they carry `usage.inputTokens`, which this wire
 * vocabulary's own result type never may (see `JevRouteLaunchResult`).
 */
export type JevFallbackReason =
  | 'no-key'
  | 'no-launchable-provider'
  | 'unreachable'
  | 'timeout'
  | 'rate-limited'
  | 'unauthorized'
  | 'low-confidence'
  | 'invalid-response'
  | 'budget-exceeded'

/**
 * The one thing a Jev routing request ever carries across the wire (#509):
 * the prompt the person typed, nothing else. Provider, model and effort are
 * derived from what THIS machine can launch right now, asked fresh on the
 * main side — never sent from the renderer, so there is no second copy of
 * the launchable set that could drift out of step with the real one.
 */
export interface JevRouteLaunchRequest {
  prompt: string
}

/**
 * Boundary parser for the prompt a Jev route request carries (#509). THROWS
 * rather than degrading — the same bad-VALUE half of the `config-layering`
 * asymmetry `parseJevApiKeyInput` reads a typed value by: a legible
 * instruction that cannot be carried out is refused with a message naming
 * what was wrong, never silently swapped for a default nobody chose.
 *
 * Capped at `MAX_DWARF_TEXT_CHARS` rather than a new number invented for this
 * one call: a Jev route request carries the SAME prompt a launch would carry
 * (see `AgentLaunchRequest.prompt`'s own comment, "capped like any delivered
 * message"), so this boundary must never refuse a prompt a launch itself
 * would accept. `buildJevRouteRequest` (routeRequest.ts) trims further, to
 * fit TypeSafe's own much smaller token budget — a separate concern from "is
 * this a well-formed request", which is all a boundary parser ever decides.
 */
export function parseJevRouteLaunchRequest(payload: unknown): JevRouteLaunchRequest {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new Error(`Jev route request must be an object, received ${typeof payload}`)
  }
  const prompt = (payload as Record<string, unknown>).prompt
  if (typeof prompt !== 'string') {
    throw new Error(`Jev route request's prompt must be a string, received ${typeof prompt}`)
  }
  const trimmed = prompt.trim()
  if (trimmed === '') {
    throw new Error('Jev route request must not have an empty prompt')
  }
  if (trimmed.length > MAX_DWARF_TEXT_CHARS) {
    throw new Error(`Jev route request's prompt must be at most ${MAX_DWARF_TEXT_CHARS} characters`)
  }
  return { prompt: trimmed }
}

/**
 * How a model earns a place in a routing profile, independent of its own
 * name (jev-routing-profiles T1/T3). Declared here — the ONE declaration
 * point for anything crossing main -> renderer (#77) — and re-exported
 * unchanged from `main/jev/capabilities/modelCapability.ts`, which is where
 * the full capability TABLE actually lives (main-only; never on the wire).
 *
 * `'special-purpose'` is a real capability-table tier (an image model, an
 * internal reviewer) but a routing DECISION never lands on it: the
 * `model_tier` question T3 sends offers no such option, so nothing
 * downstream ever assigns it to `JevRouteLaunchResult.tier` below.
 */
export type ModelTier = 'fast-cheap' | 'balanced' | 'frontier' | 'long-context' | 'special-purpose'

/**
 * One routing part Jev answered as a Choice, or that a confidence floor or a
 * profile rule overrode (jev-routing-profiles T3) — `provider` and
 * `model_tier` both report this shape in `JevRouteParts` below, so the
 * renderer can say "Jev chose this" or "this was too unsure, so the safe
 * value was used" without a second vocabulary per part.
 */
export interface JevRouteAnsweredPart<T> {
  value: T
  /** Jev's own reported confidence for its answer — kept even when a rule overrode `value`, so the card can show what Jev actually said. */
  confidence: number
  /** Whether `value` is Jev's own answer, or a floor/profile safe value substituted for it. */
  applied: 'answered' | 'safe-default'
}

/**
 * One yes/no part Jev answered as a Noul (jev-routing-profiles T3):
 * `probability`, never `confidence` — a Noul reports how likely "yes" is,
 * not how sure Jev is of a single chosen label (TypeSafe's own
 * `NoulResponse` carries no confidence field either). `value` is the floored
 * boolean the local decision actually acted on.
 */
export interface JevRouteNoulPart {
  value: boolean
  probability: number
}

/**
 * Every part behind one routing decision (jev-routing-profiles T3) — what
 * the renderer reads to say WHICH part was unsure, rather than only the
 * single overall `confidence` on `JevRouteLaunchResult`.
 */
export interface JevRouteParts {
  provider: JevRouteAnsweredPart<DwarfProvider>
  tier: JevRouteAnsweredPart<ModelTier>
  trivial: JevRouteNoulPart
  largeContext: JevRouteNoulPart
}

/**
 * What the `jev:route` channel ever answers with (#509) — a SUGGESTION,
 * never a launch. The decision is SHOWN before it is acted on and can be
 * OVERRIDDEN (issue #509's own acceptance criterion), so the renderer applies
 * this to its own pickers rather than starting a session from it directly;
 * only `agent:launch` ever starts one.
 *
 * Deliberately never the prompt, the key, or token usage. Main validates the
 * decision against the same gate every launch goes through
 * (`parseLaunchTuning`) before it ever reaches this shape, so what crosses is
 * always something `agent:launch` could actually carry out — but never
 * anything about the REQUEST that produced it.
 *
 * AMENDED for jev-routing-profiles T3: `tier` and `parts` carry the local
 * decision's own working, so the renderer can show the tier Jev landed on
 * and name whichever part fell back to a safe value. `fallbackTo` carries
 * the user's OWN configured default (Settings' Jev section) when one is set
 * and this call still fell back — the renderer applies it like a decision
 * and says "your default" (T4); absent exactly when no default is
 * configured, which keeps today's behaviour unchanged.
 */
export type JevRouteLaunchResult =
  | {
      kind: 'decision'
      provider: DwarfProvider
      model?: string
      effort?: string
      /** The MIN of the applied parts' (provider, tier) own confidences — the function-calling cookbook's own rule for a multi-part answer. */
      confidence: number
      /** Whether the prompt sent to Jev was shortened to fit its own token budget. */
      truncated: boolean
      /** The tier the local decision actually landed on, after every floor and profile rule — see ModelTier. */
      tier: ModelTier
      /** Every part behind this decision — see JevRouteParts. */
      parts: JevRouteParts
    }
  | {
      kind: 'fallback'
      reason: JevFallbackReason
      /** Carried only for `'low-confidence'` — see `JevRouteFallback`'s own comment. */
      confidence?: number
      fallbackTo?: JevLaunchDefault
    }

/* --- end of the #509 block ------------------------------------------------- */

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
   * The message-panel window: what it shows, what it reports, and how tall it
   * is (#162).
   *
   * `setMessagePanel` answers with the REAL MessagePanelState after main
   * applied it, for the reason the layout channels do — main creates, moves,
   * shows and hides an actual window off the back of it. Both windows may
   * send it: the shell opens the panel, and the panel closes itself and adopts
   * the dwarf a launch produced. `messagePanelChanged` is how the OTHER window
   * hears about it, so neither has to poll the state it does not own.
   *
   * `reportDwarfDelivery` carries the send and kick verdicts the panel window
   * is the only writer of, so the mine in the shell window can draw its
   * markers (see DwarfDeliveryReport). One-way: there is no verdict about a
   * verdict.
   *
   * `setMessagePanelHeight` is the design's vertical-only resize reaching the
   * window that has to carry it. The renderer measures its own surface in
   * DESIGN pixels — the height derived from the latest message, or the one a
   * drag left behind — and main multiplies by the same `uiScale` every other
   * dimension goes through. One-way, and the first one also reveals the
   * window: it is created hidden, so nobody sees it at a height nothing had
   * measured yet.
   *
   * `dragMessagePanel` and `dockMessagePanel` are where that window stops being
   * glued to the shell (#296). Both are one-way, and for a stronger reason than
   * the height report: there is no verdict here for a renderer to draw at all.
   * Main reads the cursor, moves the window, clamps it to the display and
   * remembers where it ended up — the panel's position is not state the page
   * renders, so answering with it would be inventing a copy that could
   * disagree. `dockMessagePanel` is the way back: it forgets the position and
   * puts the panel beside the shell again.
   */
  getMessagePanel: 'panel:message:get',
  setMessagePanel: 'panel:message:set',
  messagePanelChanged: 'panel:message:changed',
  reportDwarfDelivery: 'panel:message:delivery',
  dwarfDeliveryReported: 'panel:message:delivery:changed',
  setMessagePanelHeight: 'panel:message:height',
  dragMessagePanel: 'panel:message:drag',
  dockMessagePanel: 'panel:message:dock',
  /**
   * The panel window saying its surface has finished leaving (#389).
   *
   * The mirror image of the height report above. That one reveals a window
   * created hidden; this one releases a hide main is holding back, so the
   * surface can settle — lower and fade, on the shell's own 250ms — while the
   * window it is in is still on screen. Without it main hides the window in the
   * frame the state changed and there is nothing left to animate.
   *
   * One-way, and carrying nothing. Main already knows which window sent it and
   * what surface it holds, and the renderer has no verdict to draw: the window
   * either hid on this report or on main's own bound, and a panel that has
   * closed is closed either way.
   *
   * Deliberately NOT a fourth MessagePanelSurface. A 'closing' surface would
   * cross to the SHELL as well, which draws the selected dwarf's halo from it
   * and would have to decide what a halo means during a close — a one-way door
   * for a state that has nothing to say. This says the one thing main is
   * waiting to hear and adds nothing to what either window renders.
   */
  reportMessagePanelSettled: 'panel:message:settled',
  /**
   * Whether the shell window is on screen at all (#174, #173).
   *
   * The renderer needs this because every sound has to stop while the app is
   * minimised or hidden, and a hidden BrowserWindow is not a thing a page can
   * read for itself with any confidence: `document.visibilityState` is
   * Chromium's answer about a TAB, and what it reports for a hidden,
   * transparent, always-on-top frameless window is a platform detail nobody
   * has verified on all three targets. Main already knows — it is the process
   * that calls `show()` and `hide()` — so it says, and the renderer follows
   * the fact rather than guessing at it. That is the same reasoning the pin
   * and the layout channels carry.
   *
   * `getPanelVisible` exists for the one moment a push cannot reach: the
   * page's own first mount, which happens while the window is still hidden.
   */
  getPanelVisible: 'panel:visible:get',
  panelVisibilityChanged: 'panel:visible:changed',
  /**
   * Settings' Audio section (#174, over #173's channels).
   *
   * `setAudioPreferences` answers with what main STORED rather than what was
   * asked for, the same discipline the pin and the edge preference hold: main
   * clamps every volume into 0..1 and refuses a malformed document outright,
   * so a slider can only ever be drawn at a value that is really in force.
   */
  getAudioPreferences: 'audio:preferences:get',
  setAudioPreferences: 'audio:preferences:set',
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
   * The page of that same transcript immediately OLDER than a cursor (#364) —
   * the panel having scrolled to the top of what it holds and asked for more.
   *
   * A channel of its own rather than an argument on `getDwarfFeed`, because the
   * two reads cost different things and are asked for at different moments.
   * `getDwarfFeed` is the newest page: it rides the poll for the watched dwarf
   * (#196) and has to stay inside the loop's budget, which is why raising its
   * count was the wrong fix. This one is asked for only when somebody actually
   * scrolls back, walks as wide as it has to, and answers whether anything
   * older is left (see DwarfFeedPage).
   */
  getDwarfFeedPage: 'dwarf:feed:page',
  /**
   * The renderer reporting which dwarf its message panel currently has open,
   * or that none is (#196). A held session's counts since #436: its words no
   * longer ride the snapshot either, so it needs the same push every other
   * watched dwarf does. One-way, like `retireDwarf`: main
   * folds the watch into its next poll's pass rather than answering a
   * verdict, so there is nothing here to wait for.
   */
  setWatchedDwarf: 'panel:watchDwarfFeed',
  /**
   * The mine asking a held session for its own context reading (issue #96) —
   * one-way, exactly like `setWatchedDwarf` and for the same reason: this is a
   * control request main makes on a stream it owns, and the answer arrives on
   * the next `minesUpdated` snapshot like every other change, so there is no
   * verdict here to wait for. Named by DWARF, never by session id, because
   * that is what the mine has; main resolves the rest (and no-ops for a
   * session it does not hold, or a dwarf that names no session at all).
   */
  refreshDwarfTelemetry: 'dwarf:refreshTelemetry',
  /**
   * Changing a held session's own model or effort while it runs (issue #96) —
   * the mutating half of the surface `refreshDwarfTelemetry` reads.
   *
   * Request/response rather than one-way, unlike its read-only sibling above,
   * and for the reason `openMinePath` is one: there IS a verdict the strip
   * has to render. A refused change must show its reason there, and nothing
   * else pushes that later — a snapshot can say what the session runs, never
   * why a request was turned down.
   *
   * ONE channel for both acts, carrying a discriminated `change` (see
   * DwarfTuningChange for why). Deliberately not folded into `dwarf:sendText`:
   * a control request is not text delivered into a session, and forcing it
   * through that shape would misrepresent what it is — the same ruling
   * docs/command-surface-evaluation.md §6 item 3 already made for this pair.
   */
  setDwarfTuning: 'dwarf:setTuning',
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
  /**
   * A click on an activity line's own path (#279) — resolved and verified in
   * MAIN, never the renderer: the renderer hands over the mine id and the raw
   * `target` string and receives only `opened` or a fixed reason, never a
   * filesystem verdict it could act on itself.
   *
   * A request/response channel rather than one-way, unlike `retireDwarf` and
   * `setWatchedDwarf`: there IS a verdict here the panel must render — the
   * refusal sentence, shown on the line's own title or the panel's existing
   * status line (see `screens/mine.md`'s amendment) — and nothing else pushes
   * it later the way a snapshot would.
   */
  openMinePath: 'mine:openPath',
  /**
   * A press on a link inside a message bubble (#347) — validated in MAIN and
   * opened in the SYSTEM BROWSER, never in this app.
   *
   * Never inside the panel, and that is the whole reason the channel exists
   * rather than an anchor in the bubble. A renderer that can navigate is a
   * renderer that can be navigated: the transcript is untrusted text, and an
   * `<a href>` in it would be a page this window could actually be replaced by.
   * So a bubble draws a button, reports the address, and main decides.
   *
   * The payload is the raw string the transcript carried — never a URL object,
   * never a parsed one — because main re-runs the same `externalLinkOf` rule
   * the renderer ran, and re-running a rule on somebody else's parse result is
   * not re-running it. Request/response for the reason `openMinePath` is: there
   * IS a verdict the panel must render, and nothing else pushes it later.
   */
  openExternalLink: 'shell:openExternalLink',
  sendDwarfText: 'dwarf:sendText',
  /**
   * The verdict of a message `sendDwarfText` answered `holdId` for (#457) —
   * see `DwarfSendSettledPush`.
   *
   * Push rather than pull, exactly like `launchFailed` and for the same
   * reason: main learns this asynchronously, when a Codex turn or an
   * OpenCode continuation ends minutes after the call already answered, so
   * there is nothing for the panel to ask for and no moment to poll at.
   */
  dwarfSendSettled: 'dwarf:sendText:settled',
  /**
   * The system file picker, for the composer's attach control (#408).
   *
   * Main owns the dialog for the same reason `chooseProjectDirectory` does: it
   * must come up in FRONT of an always-on-top panel rather than behind it, and
   * the two must not be interactable at once. It answers paths and nothing
   * else — a cancelled picker is an empty list, not an error — because
   * everything a path means is `describeDwarfAttachments`'s answer, which a
   * dropped file reaches by the same route.
   */
  chooseDwarfAttachments: 'dwarf:attachments:choose',
  /**
   * What main can see about a path and the renderer cannot: its size, whether
   * it is a folder, whether it reads at all, and a bounded preview for an image
   * (#408).
   *
   * Both entry points come through here — the picker's paths and a drop's, the
   * latter turned into paths by `webUtils.getPathForFile` in preload — which is
   * what makes them one validation path rather than two that drift. The panel
   * is never handed a `file://` for an arbitrary location: the preview is a data
   * URL main rendered, so a chip is never a reason to load anything on the disk.
   */
  describeDwarfAttachments: 'dwarf:attachments:describe',
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
   * Adopting a folder as a mine, and removing one (#85, #169).
   *
   * declare carries NO payload in either direction beyond its verdict: the
   * native folder picker is opened in main, so the renderer asks for one and
   * never chooses, names or even sees a path it did not already receive on a
   * mine. undeclare carries a mine id and never a path, for the same reason
   * every other dwarf channel does — the id is the thing both sides already
   * agree on, and a path would be a second key to keep in step.
   *
   * `undeclareMine` is the app's ONE removal (#169), whatever its name says:
   * it removes a discovered mine as readily as a declared one, and it removes
   * logically — see MineUndeclareResult. The name stayed because a second
   * channel meaning the same thing is what #169 forbade; declare is the way
   * back for a mine that was removed.
   */
  declareMine: 'mine:declare',
  /**
   * The answer to `declareMine`'s 'worktree-of' question (#348): adopt the
   * project the picked worktree belongs to.
   *
   * No payload either, and that is the point. Main remembers the project it
   * resolved for the folder it opened the picker for, so "Open the main
   * project" is a second ASK rather than a path travelling back — the renderer
   * still never names a folder. Main forgets it as soon as it is used or
   * another declare begins, so this can only ever adopt the project the person
   * was actually shown.
   */
  declareMainProject: 'mine:declare-main',
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
   * A launch that failed AFTER `agent:launch` already answered `launched:
   * true` (#263) — see `LaunchFailedPush`. Push rather than pull, like
   * `messagePanelChanged` and `dwarfDeliveryReported`: main learns of this
   * asynchronously, up to `EARLY_FAILURE_WINDOW_MS` after the verdict, so
   * there is no request for the panel to make and no moment to poll for one.
   */
  launchFailed: 'agent:launchFailed',
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
   * What each provider can start ON, live (#239) — beside listAgentProviders
   * for the same reason that channel is pull-only: a model list is not board
   * state, it changes when a provider ships one, and the Add Panel asks once
   * when it opens rather than keeping it in step at 2Hz.
   *
   * Answers with AgentModelCatalogList, one entry per DWARF_PROVIDERS member
   * whatever this build can actually say about it — see AgentModelSource for
   * why an entry with an empty `models` list is still an honest answer rather
   * than an absent one. No payload ever crosses: the question is about this
   * machine, exactly as listAgentProviders' is.
   */
  listAgentModels: 'agent:models',
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
  launchHostedProcess: 'agent:launchHosted',
  /* --- System notifications (#316) — one block, appended ------------------- */
  /**
   * Settings' Notifications switch (#316).
   *
   * `set` answers with what main STORED, the discipline every preference
   * channel here holds: the boundary collapses anything that is not a boolean,
   * so the switch can only ever be drawn in a state that is really in force.
   */
  getNotificationsEnabled: 'notifications:enabled:get',
  setNotificationsEnabled: 'notifications:enabled:set',
  /**
   * The renderer reporting which mine INTERIOR the shell currently has open, or
   * that none is (#316) — one-way, exactly like `setWatchedDwarf` and for the
   * same reason: main folds it into its next poll's decision rather than
   * answering a verdict, so there is nothing here to wait for.
   *
   * Main needs it because #316's whole rule is "never notify about the mine on
   * screen", and which mine that is has always been the renderer's own state.
   * Deliberately NOT folded into `setPanelLayout`: that request carries the
   * boolean `mineOpen`, which does not move when the person walks from one mine
   * straight into another — so a mine id riding on it would be silently stale
   * in exactly the case the acceptance walk exercises.
   */
  setOpenMine: 'panel:openMine',
  /**
   * Main asking the shell to open a mine (#316) — the second half of a click on
   * a notification, whose first half (showing and raising the window) main did
   * itself.
   *
   * One-way, the same shape as `messagePanelChanged`: main owns the act and the
   * renderer follows the state it is told, so there is no verdict to answer
   * with. It selects NO dwarf, deliberately — the person clicks the dwarf to
   * read the ask, and a notification that opened a message panel on their
   * behalf would be choosing what they look at.
   */
  showMine: 'panel:mine:show',
  /* --- end of the #316 block ---------------------------------------------- */
  /* --- Typography preferences (#370) — one block, appended ----------------- */
  /**
   * Settings' Typography section (#370).
   *
   * `set` answers with what main STORED, the discipline every preference
   * channel here holds: the shared parser refuses a face this build cannot
   * draw — Tiny5 for messaging above all — so a segment can only ever be drawn
   * selected for a choice that is really in force.
   *
   * `typographyPreferencesChanged` is the third channel, and the reason it
   * exists is that this preference is the only one BOTH windows paint with.
   * Settings lives in the shell; the messaging face is what the message-panel
   * window draws its bubbles and its Add Panel in. Without a push, changing the
   * face would leave the other window on the old one until it was reloaded —
   * so main broadcasts what it stored, the same shape `messagePanelChanged`
   * has, and each window follows the fact rather than polling for it.
   */
  getTypographyPreferences: 'typography:preferences:get',
  setTypographyPreferences: 'typography:preferences:set',
  typographyPreferencesChanged: 'typography:preferences:changed',
  /* --- end of the #370 block ----------------------------------------------- */
  /* --- Jev launch routing: the API key setting (#509) — one block, appended - */
  /**
   * Settings' Jev API-key control (#509).
   *
   * `set` and `clear` both answer with the STORED verdict, the discipline
   * every preference channel here holds — projected onto a value this wire
   * may never carry in either direction: the key itself stays in main (see
   * `jevApiKey.ts`'s `readKey()`), and only `configured`/`unavailableReason`
   * ever cross.
   */
  getJevSettings: 'jev:settings:get',
  setJevApiKey: 'jev:apiKey:set',
  clearJevApiKey: 'jev:apiKey:clear',
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev launch routing: routing a launch (#509) — one block, appended --- */
  /**
   * Ask Jev to route one launch prompt to a provider, model and effort
   * (#509). The request IS the prompt (`JevRouteLaunchRequest`), and the only
   * thing that ever crosses back is a decision or a typed fallback reason —
   * never the prompt, the key, or token usage. Main validates the decision
   * against the same gate every launch goes through (`parseLaunchTuning`)
   * before it ever reaches this channel's caller, but the result is still
   * only a SUGGESTION: the renderer shows it before acting and the person may
   * override it, never a launch by itself.
   */
  routeJevLaunch: 'jev:route',
  /* --- end of the #509 block ------------------------------------------------ */
  /* --- Jev routing profiles: profile and defaults (#509 follow-up) — one block, appended --- */
  /**
   * Settings' profile and default-launch controls (#509 follow-up). `get`
   * stays `getJevSettings` — the merged verdict now carries `preferences`
   * too — and only the WRITE gets a channel of its own, the same split
   * `setJevApiKey`/`clearJevApiKey` already hold beside `getJevSettings`.
   */
  setJevPreferences: 'jev:preferences:set'
  /* --- end of the #509 follow-up block --------------------------------------- */
} as const
