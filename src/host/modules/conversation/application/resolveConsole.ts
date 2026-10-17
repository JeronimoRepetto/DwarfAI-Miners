// `ConversationCommands.resolveConsole` (16 §4.6, frozen; ADR-031 items 1–3; UC-036): the console
// target of a dwarf, from the session's effective `console` value.
//
// `consolePlan` is the rule (ADR-031 item 1 table, v1 values):
// - an observed session (one DwarfAI did not launch) is `focus-terminal` when observation recorded
//   the identity of its provider process (ADR-014 item 1: pid + start time + boot, never a bare
//   pid), with `log` second: UI main falls back to the read-only view when no window of that
//   process can be raised. With no identity it is `log`.
// - a launched session (`owned`) is `log`: it has no terminal of its own (OQ-01), and `attach` is
//   offered only once its spike passed. S-031-1 (Codex TUI attach) FAILED (owner run 2026-10-17:
//   a second attached client becomes another writer) and S-031-3 (OpenCode password delivery) has
//   not passed, so no launched session gets `attach` in v1 (OQ-39 A).
// - a dwarf the Host does not know is `log`: "no console" is never a state (ADR-031 item 3).
//
// `createResolveConsole` is the use case over the `ConsoleResolver` port, which issues the `log`
// view's per-view token and builds the targets (adapters/console/HostConsoleResolver.ts). It never
// answers an ask (US-MSG-007.AC02): it reads no ask and writes nothing.
import type { ProcessIdentity } from '../../../kernel/domain/processIdentity'
import type { DwarfId } from '../../../kernel/domain/values'
import type { ConsoleResolver, ConsoleTarget } from '../ports/consoleResolver'

/** What the Host knows of a dwarf's session for its console; null for a dwarf it does not know. */
export interface ConsoleSession {
  /** Launched by DwarfAI (a live launch record, INV-30), else observed. */
  owned: boolean
  /** The provider process observation recorded for an observed session (ADR-014 item 2), or null. */
  process: ProcessIdentity | null
}

/** The console order of one dwarf: focus first with `log` second, or `log`. */
export type ConsolePlan = { mode: 'focus-terminal'; focus: ProcessIdentity } | { mode: 'log' }

/** What crew's view of a dwarf says about who started its session (05 §3.2 `CrewQueries.get`). */
export interface ConsoleDwarf {
  /** A live launch record (INV-30). */
  owned: boolean
  /** `driver` for a dwarf DwarfAI launched, else `transcript` (INV-92). */
  usagePath: 'driver' | 'transcript'
}

/**
 * The console session of a dwarf from crew's view and observation's recorded process identity: a
 * dwarf with a live launch record or bound through a driver is launched; any other is observed,
 * with the identity of its provider process when observation recorded one.
 */
export function consoleSessionOf(
  dwarf: ConsoleDwarf | null,
  observedProcess: () => ProcessIdentity | null
): ConsoleSession | null {
  if (dwarf === null) return null
  const owned = dwarf.owned || dwarf.usagePath === 'driver'
  return { owned, process: owned ? null : observedProcess() }
}

export function consolePlan(session: ConsoleSession | null): ConsolePlan {
  if (session === null || session.owned || session.process === null) return { mode: 'log' }
  return { mode: 'focus-terminal', focus: session.process }
}

export interface ResolveConsole {
  resolveConsole(dwarfId: DwarfId): Promise<ConsoleTarget>
}

export function createResolveConsole(deps: { resolver: ConsoleResolver }): ResolveConsole {
  return { resolveConsole: (dwarfId) => deps.resolver.targetFor(dwarfId) }
}
