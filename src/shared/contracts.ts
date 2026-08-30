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

export type DwarfProvider = 'claude' | 'codex'

export type DwarfRole = 'foreman' | 'worker'

/**
 * working: actively producing (busy). waiting: session alive but paused/awaiting
 * (a resting dwarf). leaving: present in the previous runtime tick but its
 * agent finished/disappeared — kept for a grace period, then dropped.
 */
export type DwarfStatus = 'working' | 'waiting' | 'leaving'

/**
 * How long a dwarf of each role has to have produced nothing before its silence
 * is worth showing (issue #47).
 *
 * These are the SAME windows the Claude provider's staleness rule judges a
 * remembered launch by (issue #40), which is the whole point of them living
 * here: the panel must never say "still working" about a dwarf the provider has
 * already started counting out. Read them, do not re-invent them.
 *
 * They differ because the two silences are not equally telling, and collapsing
 * them into one number would lose the distinction. A FOREMAN legitimately sits
 * idle for as long as it takes a human to type the next prompt, so its silence
 * is weak evidence and gets the longer hour. A WORKER cannot wait on anyone:
 * once launched it runs to completion, so silence from its own transcript is
 * strong evidence and half an hour of it says enough.
 *
 * A dwarf past its window is NOT in a different state — see Dwarf.silentForMs.
 */
export const DWARF_SILENCE_WINDOW_MS: Record<DwarfRole, number> = {
  foreman: 60 * 60 * 1000,
  worker: 30 * 60 * 1000
}

/**
 * How a live session can be handed a typed message.
 *
 * terminal: the session owns a console window — keystrokes are injected into it.
 * claude-relay: the session is headless but addressable by name, so a one-shot
 *   `claude -p` turn delivers the text over Claude Code's cross-session messaging.
 * foreman-relay: the dwarf is a subagent with no channel of its own; the text
 *   goes to its foreman (parent session) under an explicit `[for agent X] ` prefix.
 *
 * A dwarf with no channel at all simply carries no value.
 */
export type TextDeliveryChannel = 'terminal' | 'claude-relay' | 'foreman-relay'

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
  retireDwarf: 'dwarf:retire'
} as const
