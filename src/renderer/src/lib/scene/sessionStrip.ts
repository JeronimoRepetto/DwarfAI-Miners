import { SESSION_ENDED_REASON } from '../delivery/actionBar'
import type {
  AgentModelCatalog,
  Dwarf,
  DwarfContextUsage,
  DwarfMcpServerStatus,
  McpConnectionStatus
} from '../../types'

/**
 * The mine's read-only command surface (issue #96): what a held session says
 * about itself that this app can actually PROVE — the model in force, how
 * much of its context window is spent, and every MCP server it has with the
 * CLI's own connection state. Placed here, in `lib/`, rather than as a `v-if`
 * ladder in SessionStrip.vue, because "which sessions can even answer this"
 * is one decision with a test on it: only a session this panel HOLDS reports
 * any of it (see `Dwarf.mcpServers`, `Dwarf.contextUsage`).
 *
 * The maintainer's 2026-09-07 amendment to
 * `docs/dwarfai-miners-design/screens/mine.md` first drew an observed session
 * disabled, with its reason stated on the strip. The 2026-09-09 amendment
 * (#295) REVERSES that for exactly this case: in use, the sentence repeated
 * itself under almost every mine and told the reader nothing they could act
 * on, so an observed session now draws no strip at all — no row, no reason.
 * A held session whose stream has already ended is unchanged: that refusal
 * names a fact about a session this app DID hold (see `sessionStrip` below),
 * not a gap in this app, so it keeps its reason drawn.
 */

/**
 * Why the model select is drawn but not usable (issue #96) — a held session
 * whose own engine has no mid-run model change (see
 * `HeldSessionHandle.setModel`, which is optional for exactly this reason).
 * The same idiom as the reason above, and it names the SESSION's limit rather
 * than this app's.
 */
export const NO_MODEL_CONTROL_REASON = "This session's agent can't change its model while it runs."

/**
 * The same for effort. Note what this is NOT for: a model that takes no
 * effort at all gets no control whatsoever rather than this sentence — see
 * `effortControl`, and the design's own rule about a setting the CLI accepts
 * and discards.
 */
export const NO_EFFORT_CONTROL_REASON =
  "This session's agent can't change its effort while it runs."

/**
 * The SDK's own closed MCP status vocabulary, worded for the strip's hover
 * line (mine.md: "the status word as the entry's title"). `needs-auth` reads
 * as a resting state on purpose — the maintainer's one explicit wording rule
 * for this surface — never as a failure or an error.
 */
export const MCP_STATUS_LABEL: Record<McpConnectionStatus, string> = {
  connected: 'Connected',
  failed: 'Failed',
  'needs-auth': 'Needs authentication',
  pending: 'Pending',
  disabled: 'Disabled'
}

/** The context row, already formatted for a compact label and a bar's width. */
export interface SessionContextDisplay {
  usedTokens: number
  maxTokens: number
  /** Compact `used / max`, e.g. `'41.2K / 200K'`. */
  label: string
  /** `0-100`, clamped: a session past its own window still draws a full bar. */
  percent: number
  /** The exact counts, for the hover line the compact label has no room for. */
  detail: string
}

/** One value a select on the strip may be set to, already named. */
export interface SessionSelectOption {
  value: string
  /**
   * What the reader sees. Falls back to the value itself where the provider
   * gave no distinct name — the same rule the catalogue's own `label` follows,
   * resolved here so the component has nothing left to decide.
   */
  label: string
}

/**
 * One select on the strip, decided (issue #96) — which values it offers,
 * which one the session is actually running, and whether it may be operated
 * at all.
 */
export interface SessionSelectControl {
  /** What the session ACTUALLY runs, or `''` until it has said. Never a request. */
  value: string
  /** Every value this may be set to, in the provider's own order. */
  options: SessionSelectOption[]
  /**
   * Why this control may be read but not used — an engine with no such act.
   * Absent means it is live. Drawn and disabled rather than hidden: the
   * dwarf action bar's own idiom for an action a session type cannot serve.
   */
  disabledReason?: string
  /**
   * The value that was asked for and nothing has confirmed, already worded
   * (issue #96). The wording differs by control on purpose, because the two
   * confirmations differ: a model change has a reading that PROVES it, so its
   * note reads `pending`; an effort change has only the next turn's `init`,
   * which may never say anything, so its note reads `requested`. Absent when
   * nothing is outstanding.
   */
  pendingNote?: string
}

export type SessionStripState =
  /**
   * No strip at all — nothing selected, or a session this panel does not
   * hold (maintainer amendment, 2026-09-09, #295). An absent surface is not
   * a control that quietly does nothing: there is no control, so nothing is
   * drawn rather than a reason stated on a strip that could never answer.
   */
  | { kind: 'none' }
  /**
   * Selected, and this panel DID hold the session, but the stream has since
   * ended — `reason` says so. The only refusal left: a limit of a session
   * this app held, never of one it merely observed.
   */
  | { kind: 'unavailable'; reason: string }
  /**
   * Selected, and this panel holds the stream. Every field is independently
   * absent until a reading for it has actually arrived — never a zero or an
   * empty placeholder standing in for "not measured yet".
   *
   * `model` is what the strip shows when there is no select to draw, and
   * `modelControl` replaces it when there is: the model's name and the
   * control that changes it are the same thing on the line, which is the
   * placement the design's own amendment names.
   */
  | {
      kind: 'live'
      model?: string
      context?: SessionContextDisplay
      mcpServers: DwarfMcpServerStatus[]
      modelControl?: SessionSelectControl
      effortControl?: SessionSelectControl
    }

/**
 * What the strip should draw for the selected dwarf, or the absence of one.
 *
 * Held sessions only. A session this panel merely observes, or one with no
 * delivery channel at all, draws no strip (`{ kind: 'none' }`, maintainer
 * amendment, 2026-09-09, #295) — the channel is the one fact every held
 * session's wire record carries and every other kind does not (see
 * `TextDeliveryChannel`). A held session whose stream has already ended is a
 * SEPARATE case, and stays a REFUSAL rather than an absence: the lifecycle
 * grace window freezes the last real snapshot, channel included, so
 * `textDelivery` still reads `'held-session'` for a few seconds after the
 * registry has let it go — `status === 'leaving'` is what actually proves it,
 * and the action bar's own `SESSION_ENDED_REASON` is reused rather than a
 * second sentence saying the same thing. That case names a fact about a
 * session this app DID hold, which is worth stating; "not held at all" is
 * not.
 */
export function sessionStrip(
  dwarf: Dwarf | undefined,
  catalogs: readonly AgentModelCatalog[] = []
): SessionStripState {
  if (dwarf === undefined || dwarf.textDelivery !== 'held-session') return { kind: 'none' }
  if (dwarf.status === 'leaving') {
    return { kind: 'unavailable', reason: SESSION_ENDED_REASON }
  }
  const context = contextDisplay(dwarf.contextUsage)
  // The provider's OWN answer, and only where it was asked live. A catalogue
  // for another provider is a different question entirely; one this dwarf's
  // provider never answered live is not a list of what this session may
  // switch to (see AgentModelSource).
  const catalog = catalogs.find(
    (entry) => entry.provider === dwarf.provider && entry.source === 'provider'
  )
  return {
    kind: 'live',
    ...(dwarf.model === undefined ? {} : { model: dwarf.model }),
    ...(context === undefined ? {} : { context }),
    mcpServers: dwarf.mcpServers ?? [],
    ...maybe('modelControl', modelControl(dwarf, catalog)),
    ...maybe('effortControl', effortControl(dwarf, catalog))
  }
}

/** `{ key: value }` when there is one, and `{}` when there is not. */
function maybe<K extends string, T>(key: K, value: T | undefined): Partial<Record<K, T>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>)
}

/**
 * The model select, or undefined when the strip must draw the plain name
 * instead (issue #96).
 *
 * Two things have to be true before a choice is offered at all, and both are
 * about honesty rather than capability:
 *
 * - The session must have REPORTED what it can change (`sessionTuning`).
 *   Absence on the wire means "no control here", never "assume it works" —
 *   the same asymmetry every other held-only field on `Dwarf` draws.
 * - The catalogue must be the provider's own live answer. A `history` list is
 *   what this machine happens to have used and a `none` list is nothing at
 *   all; building a switch-to menu out of either would be offering a guess.
 *
 * An engine that cannot serve the act still gets a control, DISABLED with the
 * reason: hiding it would leave the reader unable to tell "this session
 * cannot" from "this panel forgot".
 */
function modelControl(
  dwarf: Dwarf,
  catalog: AgentModelCatalog | undefined
): SessionSelectControl | undefined {
  const tuning = dwarf.sessionTuning
  if (tuning === undefined || catalog === undefined || catalog.models.length === 0) return undefined
  return {
    value: dwarf.model ?? '',
    options: catalog.models.map((model) => ({
      value: model.value,
      label: model.label ?? model.value
    })),
    ...(tuning.canSetModel ? {} : { disabledReason: NO_MODEL_CONTROL_REASON }),
    ...maybe(
      'pendingNote',
      tuning.pendingModel === undefined ? undefined : `${tuning.pendingModel} pending`
    )
  }
}

/**
 * The effort select, or undefined when there must be NONE (issue #96).
 *
 * The one rule the maintainer stated outright for this control, and the
 * reason it is a hard absence rather than a disabled control:
 * `applyFlagSettings({ effortLevel })` on a model that supports no effort
 * resolves cleanly and silently does nothing — measured live. A disabled
 * control tells the reader "not right now"; the truth is "this model has no
 * such setting", and drawing one live would answer a click by reporting
 * success and changing nothing.
 *
 * So the gate is the ACTIVE model's own catalogue entry naming levels — not
 * the provider's list, which is wider, and not a session that has yet to say
 * which model it runs, which has no active model to read this off.
 */
function effortControl(
  dwarf: Dwarf,
  catalog: AgentModelCatalog | undefined
): SessionSelectControl | undefined {
  const tuning = dwarf.sessionTuning
  if (tuning === undefined || catalog === undefined || dwarf.model === undefined) return undefined
  const levels = catalog.models.find((model) => model.value === dwarf.model)?.effortLevels
  if (levels === undefined || levels.length === 0) return undefined
  return {
    value: dwarf.effort ?? '',
    options: levels.map((level) => ({ value: level, label: level })),
    ...(tuning.canSetEffort ? {} : { disabledReason: NO_EFFORT_CONTROL_REASON }),
    ...maybe(
      'pendingNote',
      tuning.pendingEffort === undefined ? undefined : `${tuning.pendingEffort} requested`
    )
  }
}

/**
 * The context row, or undefined while no reading has arrived — `0 / 0` would
 * be this app claiming a measurement it never took (mine.md's own rule).
 * `usedTokens` is drawn unclamped past `maxTokens`, matching the wire's own
 * "the CLI's reading, not this app's opinion of it"; only the BAR clamps, to
 * its own track.
 */
function contextDisplay(usage: DwarfContextUsage | undefined): SessionContextDisplay | undefined {
  if (usage === undefined) return undefined
  const { usedTokens, maxTokens } = usage
  const percent = maxTokens > 0 ? Math.min(100, Math.round((usedTokens / maxTokens) * 100)) : 0
  return {
    usedTokens,
    maxTokens,
    label: `${compactTokenCount(usedTokens)} / ${compactTokenCount(maxTokens)}`,
    percent,
    detail: `${usedTokens} of ${maxTokens} tokens (${percent}%)`
  }
}

/** `41237` -> `'41.2K'`; `200000` -> `'200K'`; anything under 1000 -> its plain integer. */
function compactTokenCount(tokens: number): string {
  const rounded = Math.round(tokens)
  if (rounded < 1000) return String(rounded)
  const thousands = (Math.round(rounded / 100) / 10).toFixed(1)
  return `${thousands.endsWith('.0') ? thousands.slice(0, -2) : thousands}K`
}
