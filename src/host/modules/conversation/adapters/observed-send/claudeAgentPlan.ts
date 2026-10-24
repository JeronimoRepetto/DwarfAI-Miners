// The planner of the observed-subagent route (AMENDMENT-29, owner 2026-10-24; spike
// odd/handoff/spike-claude-subagent-terminal-input.md §2 keys, §4 return, §5 robustness). Pure: given
// what the lead terminal shows now (claudeAgentConsole.ts) and the target subagent's `description`,
// the one thing ClaudeSubagentConsoleSend.ts does next. The route reads the screen again before each.
//
// Phases:
// - `start` (nothing pressed yet): only the lead's own view, its input focused and empty, with at
//   least one subagent row, goes on (↓ moves the focus into the list, pointer on `main`). A draft is
//   `draft`, no row is `not-found`, anything else (a view or a list the person left open, a screen
//   that does not read) is `unrecognised-screen` — all refused with no key pressed.
// - `seeking`: the pointer goes to the next row to open (↓/↑, list focused) and Enter opens it. A row
//   still labelled with the description is tried first; rows turn into activity summaries and are
//   never an identity, so the others are opened in turn. The pointer and the focus stay on an opened
//   row (spike §2), so the next row is one ↓ away.
// - `opened`: the view's rule label equal to the description, with an empty input, is the verified
//   target: the message is typed there (`type`: the text, then Enter). Another label: on seeking. A
//   draft in the view (the input is shared, spike §5): refused, nothing typed.
// - `returning`: back to `main` and the lead's view, whatever happened: from a list, ↑ until `main`,
//   then Enter (in a view) or ↑ (the lead's view: the input gets the focus back); from an empty
//   input, ↓ (pointer on `main`). The route ends on the lead's view with its input focused: `done`
//   when the message was typed, else the refusal.
// - `stranded`: a screen that does not read, or a view whose input holds text (it cannot be left
//   without ↑, which recalls history there, or Esc, which stops the subagent): nothing more pressed.
//
// The keys are ↓, ↑ and Enter only (`NavKey`): Esc stops the viewed subagent (spike §2) and `x` stops
// the selected one, so neither can be expressed. ↑ is pressed only while the list has the focus.

import type { AgentConsoleScreen } from './claudeAgentConsole'

/** The only keys the route presses. */
export type NavKey = 'down' | 'up' | 'enter'

/** Why a message was not typed. */
export type AgentRefusal = 'draft' | 'not-found' | 'unrecognised-screen'

export interface AgentPlanState {
  phase: 'start' | 'seeking' | 'opened' | 'returning'
  /** The rows (indexes in the list) whose view was opened and did not verify, or verified. */
  opened: readonly number[]
  /** Why the route is returning without typing; null while it may still type, or after it typed. */
  refusal: AgentRefusal | null
  /** Whether the message was typed (and submitted) in the verified view. */
  sent: boolean
}

export type AgentPlanStep =
  | { kind: 'press'; key: NavKey }
  /** The message, then Enter, into the open (verified) view. */
  | { kind: 'type' }
  /** Back on the lead's view after typing the message. */
  | { kind: 'done' }
  /** Back on the lead's view (or never left it), nothing typed. */
  | { kind: 'refused'; reason: AgentRefusal }
  /** No safe next key: stop pressing. */
  | { kind: 'stranded' }

export const START: AgentPlanState = Object.freeze({
  phase: 'start',
  opened: [],
  refusal: null,
  sent: false
})

type Planned = { state: AgentPlanState; step: AgentPlanStep }

const press = (state: AgentPlanState, key: NavKey): Planned => ({
  state,
  step: { kind: 'press', key }
})

/** The next step from `screen` (null: it did not read) toward the view labelled `description`. */
export function planAgentSend(
  state: AgentPlanState,
  screen: AgentConsoleScreen | null,
  description: string
): Planned {
  switch (state.phase) {
    case 'start':
      return planStart(screen)
    case 'seeking':
      return screen === null ? stranded(state) : planSeeking(state, screen, description)
    case 'opened':
      return screen === null ? stranded(state) : planOpened(state, screen, description)
    case 'returning':
      return screen === null ? stranded(state) : planReturn(state, screen)
  }
}

function stranded(state: AgentPlanState): Planned {
  return { state, step: { kind: 'stranded' } }
}

function planStart(screen: AgentConsoleScreen | null): Planned {
  const refuse = (reason: AgentRefusal): Planned => ({
    state: START,
    step: { kind: 'refused', reason }
  })
  if (screen === null || screen.viewLabel !== null || screen.selected !== null) {
    return refuse('unrecognised-screen')
  }
  if (!screen.inputEmpty) return refuse('draft')
  if (screen.rows.length < 2) return refuse('not-found')
  return press({ ...START, phase: 'seeking' }, 'down')
}

function planSeeking(
  state: AgentPlanState,
  screen: AgentConsoleScreen,
  description: string
): Planned {
  const back = (refusal: AgentRefusal): Planned =>
    planReturn({ ...state, phase: 'returning', refusal }, screen)
  if (screen.selected === null) return back('unrecognised-screen')
  if (!screen.inputEmpty) return back('draft')
  const untried = (index: number): boolean => index > 0 && !state.opened.includes(index)
  const labelled = screen.rows.findIndex(
    (row, index) => untried(index) && row.label === description
  )
  const next = labelled >= 0 ? labelled : screen.rows.findIndex((_, index) => untried(index))
  if (next < 0) return back('not-found')
  if (screen.selected < next) return press(state, 'down')
  if (screen.selected > next) return press(state, 'up')
  return press({ ...state, phase: 'opened', opened: [...state.opened, next] }, 'enter')
}

function planOpened(
  state: AgentPlanState,
  screen: AgentConsoleScreen,
  description: string
): Planned {
  if (screen.viewLabel !== description) {
    return planSeeking({ ...state, phase: 'seeking' }, screen, description)
  }
  if (!screen.inputEmpty)
    return planReturn({ ...state, phase: 'returning', refusal: 'draft' }, screen)
  return { state: { ...state, phase: 'returning', sent: true }, step: { kind: 'type' } }
}

function planReturn(state: AgentPlanState, screen: AgentConsoleScreen): Planned {
  if (screen.selected !== null) {
    // The list has the focus: up to `main`; there, Enter opens the lead's view, and on the lead's
    // view ↑ hands the focus back to its input.
    if (screen.selected > 0 || screen.viewLabel === null) return press(state, 'up')
    return press(state, 'enter')
  }
  if (screen.viewLabel !== null) {
    // The input of a view has the focus: ↓ only from an empty one (↑ would recall history).
    return screen.inputEmpty ? press(state, 'down') : stranded(state)
  }
  return state.refusal === null
    ? { state, step: { kind: 'done' } }
    : { state, step: { kind: 'refused', reason: state.refusal } }
}
