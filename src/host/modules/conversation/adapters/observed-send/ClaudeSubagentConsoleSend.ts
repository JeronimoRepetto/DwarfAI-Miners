// The observed-subagent route (AMENDMENT-29, owner 2026-10-24, "me parece bien"; spike
// odd/handoff/spike-claude-subagent-terminal-input.md): a person's message to an observed Claude Code
// SUBAGENT, typed into that subagent's own view of its lead's terminal, the way a person does it —
// never into the lead's main conversation, and never by guess. Windows only for now (the spike
// measured Windows 11; macOS and Linux are AMENDMENT-29 task S2): elsewhere `reaches()` is false and
// the composer keeps today's honest message (INV-33).
//
// Before anything is read, from observation (`SubagentSendFacts`, read fresh per send):
// - the lead's process identity (ADR-014 item 1), the target every read and key re-checks;
// - the subagent's `description` from its `agent-<id>.meta.json`, which must exist and be unique
//   among the session's subagents not seen to end (`twins`): the view's rule label is the ONLY
//   identity the screen shows (row labels turn into activity summaries), so two equal labels cannot
//   be told apart (`ambiguous`);
// - the Claude Code version the session's transcripts last named: only a version whose layout was
//   measured (RECOGNISED_CLAUDE_VERSIONS) is driven; any other is `unsupported-version`.
// Then the screen is read before every step and planned (claudeAgentPlan.ts): ↓ into the list, ↓/↑ to
// a row, Enter, verify the label and an empty input, type the message and Enter (the text relay's
// own write, ConsoleTextDelivery), and back to `main`. Refusals (`draft`, `not-found`,
// `unrecognised-screen`) are made before anything is typed, and the lead's view is restored first.
//
// Outcomes: `delivered` (typed and submitted in the verified view: ✓ unconfirmed; ✓✓ comes from the
// subagent transcript's `queued_command` attachment, parse.ts); `refused` with its reason (nothing
// typed); `gone` (the lead's process is not the recorded one); `not-targeted` (nothing could be read
// or pressed: no facts, no text, no attach, not Windows); `incomplete` (keys were pressed and the route
// stopped short: a read, a key or the typing failed, or no step was safe). Nothing here logs the text,
// the description or the screen.
import type { ProcessIdentity } from '../../../../kernel/domain/processIdentity'
import type { DwarfId } from '../../../../kernel/domain/values'
import { readAgentConsole } from './claudeAgentConsole'
import { planAgentSend, START, type AgentRefusal, type AgentPlanState } from './claudeAgentPlan'
import { relayTextOf } from './consoleText'
import type { TextWriteOutcome } from './ConsoleTextDelivery'
import type { ConsoleNavigator, ConsoleScreenReader } from './WindowsConsoleScreen'

/** The Claude Code versions whose lead-terminal layout was measured (spike, 2026-10-24). */
export const RECOGNISED_CLAUDE_VERSIONS: readonly string[] = Object.freeze(['2.1.310'])

/** The most reads one send makes; a list of a few dozen rows needs far fewer. */
export const MAX_ROUTE_STEPS = 64

/** What observation knows of a subagent dwarf's lead terminal (AMENDMENT-29). */
export interface SubagentSendFacts {
  /** The lead session's process identity as observation recorded it (ADR-014 item 2). */
  lead: ProcessIdentity
  /** The subagent's `description` (its sidecar), or null when it names none. */
  description: string | null
  /** How many OTHER subagents of the session, not seen to end, carry the same description. */
  twins: number
  /** The Claude Code version the session's transcripts last named, or null when none was read. */
  version: string | null
}

export type SubagentRefusal = AgentRefusal | 'ambiguous' | 'unsupported-version'

export type SubagentSendOutcome =
  | { kind: 'delivered' }
  | { kind: 'refused'; reason: SubagentRefusal }
  | { kind: 'gone' }
  | { kind: 'not-targeted' }
  | { kind: 'incomplete' }

export interface ClaudeSubagentConsoleSendDeps {
  /** The lead terminal's screen and keys (WindowsConsoleScreen; a fake in tests). */
  screen: ConsoleScreenReader & ConsoleNavigator
  /** The text relay's write (ConsoleTextDelivery): the relay text, then Enter, identity-checked. */
  terminal: { write(target: ProcessIdentity, text: string): Promise<TextWriteOutcome> }
  /** Observation's facts of the subagent dwarf, read fresh per send. */
  facts: { subagentSendFactsOf(dwarfId: DwarfId): Promise<SubagentSendFacts | null> }
  /** The OS the Host runs on, passed in by the composition root (R18). */
  platform: NodeJS.Platform
}

const DELIVERED: SubagentSendOutcome = { kind: 'delivered' }
const INCOMPLETE: SubagentSendOutcome = { kind: 'incomplete' }
const NOT_TARGETED: SubagentSendOutcome = { kind: 'not-targeted' }
const refused = (reason: SubagentRefusal): SubagentSendOutcome => ({ kind: 'refused', reason })

export class ClaudeSubagentConsoleSend {
  constructor(private readonly deps: ClaudeSubagentConsoleSendDeps) {}

  /** Whether this Host can reach a subagent at all (Windows only, AMENDMENT-29). */
  reaches(): boolean {
    return this.deps.platform === 'win32'
  }

  async send(dwarfId: DwarfId, text: string): Promise<SubagentSendOutcome> {
    if (!this.reaches() || relayTextOf(text) === null) return NOT_TARGETED
    let facts: SubagentSendFacts | null
    try {
      facts = await this.deps.facts.subagentSendFactsOf(dwarfId)
    } catch {
      facts = null
    }
    if (facts === null) return NOT_TARGETED
    if (facts.version === null || !RECOGNISED_CLAUDE_VERSIONS.includes(facts.version)) {
      return refused('unsupported-version')
    }
    if (facts.description === null || facts.twins > 0) return refused('ambiguous')
    return this.drive(facts.lead, facts.description, text)
  }

  /** The read → plan → act loop over the lead terminal. */
  private async drive(
    lead: ProcessIdentity,
    description: string,
    text: string
  ): Promise<SubagentSendOutcome> {
    const { screen } = this.deps
    let state: AgentPlanState = START
    /** Set when the typing failed: whatever the return does, the message was not delivered. */
    let typing: TextWriteOutcome | null = null
    const stopped = (): SubagentSendOutcome =>
      state.sent && typing === null ? DELIVERED : INCOMPLETE
    for (let step = 0; step < MAX_ROUTE_STEPS; step += 1) {
      const read = await screen.read(lead)
      if (read.kind === 'gone') return state.sent && typing === null ? DELIVERED : { kind: 'gone' }
      if (read.kind !== 'screen' && state.phase === 'start') return NOT_TARGETED
      const shown = read.kind === 'screen' ? readAgentConsole(read.lines) : null
      const planned = planAgentSend(state, shown, description)
      state = planned.state
      switch (planned.step.kind) {
        case 'press': {
          const pressed = await screen.press(lead, planned.step.key)
          if (pressed === 'pressed') break
          if (pressed === 'gone')
            return state.sent && typing === null ? DELIVERED : { kind: 'gone' }
          return stopped()
        }
        case 'type': {
          let written: TextWriteOutcome
          try {
            written = await this.deps.terminal.write(lead, text)
          } catch {
            written = 'incomplete'
          }
          if (written !== 'written') {
            typing = written
            if (written === 'gone') return { kind: 'gone' }
          }
          break
        }
        case 'done':
          return typing === null ? DELIVERED : INCOMPLETE
        case 'refused':
          return typing === null ? refused(planned.step.reason) : INCOMPLETE
        case 'stranded':
          return stopped()
      }
    }
    return stopped()
  }
}
