import { SESSION_ENDED_REASON } from '../delivery/actionBar'
import type {
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
 * any of it (see `Dwarf.mcpServers`, `Dwarf.contextUsage`), and the maintainer's
 * 2026-09-07 amendment to `docs/dwarfai-miners-design/screens/mine.md` is
 * explicit that an observed session shows the strip disabled with its reason
 * stated, never an empty one.
 */

/**
 * Why the strip is disabled for a session this panel does not hold, in the
 * dwarf action bar's own idiom (`NO_CHANNEL_REASON`/`NO_KICK_REASON` in
 * `lib/delivery/actionBar.ts`) — a fact about the session type, phrased the
 * same way every other "not yet" refusal on this surface is.
 */
export const NO_SESSION_SURFACE_REASON = "This session type can't report its own configuration yet."

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

export type SessionStripState =
  /** Nothing selected: no session to describe, so no strip at all. */
  | { kind: 'none' }
  /** Selected, but this panel cannot report on it — `reason` says why. */
  | { kind: 'unavailable'; reason: string }
  /**
   * Selected, and this panel holds the stream. Every field is independently
   * absent until a reading for it has actually arrived — never a zero or an
   * empty placeholder standing in for "not measured yet".
   */
  | {
      kind: 'live'
      model?: string
      context?: SessionContextDisplay
      mcpServers: DwarfMcpServerStatus[]
    }

/**
 * What the strip should draw for the selected dwarf, or the absence of one.
 *
 * Held sessions only. A session this panel merely observes, or one with no
 * delivery channel at all, refuses with `NO_SESSION_SURFACE_REASON` — the
 * channel is the one fact every held session's wire record carries and every
 * other kind does not (see `TextDeliveryChannel`). A held session whose
 * stream has already ended is a SEPARATE refusal: the lifecycle grace window
 * freezes the last real snapshot, channel included, so `textDelivery` still
 * reads `'held-session'` for a few seconds after the registry has let it go
 * — `status === 'leaving'` is what actually proves it, and the action bar's
 * own `SESSION_ENDED_REASON` is reused rather than a second sentence saying
 * the same thing.
 */
export function sessionStrip(dwarf: Dwarf | undefined): SessionStripState {
  if (dwarf === undefined) return { kind: 'none' }
  if (dwarf.textDelivery !== 'held-session') {
    return { kind: 'unavailable', reason: NO_SESSION_SURFACE_REASON }
  }
  if (dwarf.status === 'leaving') {
    return { kind: 'unavailable', reason: SESSION_ENDED_REASON }
  }
  const context = contextDisplay(dwarf.contextUsage)
  return {
    kind: 'live',
    ...(dwarf.model === undefined ? {} : { model: dwarf.model }),
    ...(context === undefined ? {} : { context }),
    mcpServers: dwarf.mcpServers ?? []
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
