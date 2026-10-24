// layer: L1
// L1 (17 §1.1): the planner of the observed-subagent route (AMENDMENT-29; spike §2 keys, §4 return,
// §5 robustness): given what the lead terminal shows now, the one key, the typing, or the refusal that
// comes next. Screens: fixtures/claude/observer/2.1.310 (reconstructed from the spike record).
import { describe, expect, it } from 'vitest'
import { readAgentConsole } from './claudeAgentConsole'
import { planAgentSend, START, type AgentPlanState, type AgentPlanStep } from './claudeAgentPlan'
import { agentConsoleScreen, type AgentConsoleScreenName } from './testing/agentConsoleScreens'

const ECHO = 'Run ping five times (echo)'
const DELTA = 'Run ping five times (delta)'
const FOXTROT = 'Run ping five times (foxtrot)'

function plan(
  state: AgentPlanState,
  name: AgentConsoleScreenName,
  description = ECHO
): { state: AgentPlanState; step: AgentPlanStep } {
  return planAgentSend(state, readAgentConsole(agentConsoleScreen(name)), description)
}

const seeking = (opened: number[] = []): AgentPlanState => ({
  phase: 'seeking',
  opened,
  refusal: null,
  sent: false
})
const returning = (
  refusal: AgentPlanState['refusal'],
  sent = refusal === null
): AgentPlanState => ({ phase: 'returning', opened: [], refusal, sent })

describe('planAgentSend: the first read, before any key', () => {
  it('[ADR-012] the lead view with an empty input and a list: ↓ into the list', () => {
    expect(plan(START, 'lead-input-empty')).toEqual({
      state: seeking(),
      step: { kind: 'press', key: 'down' }
    })
  })

  it("[ADR-012] a person's draft in the lead input is refused before any key (spike §5)", () => {
    for (const name of ['lead-input-draft', 'lead-input-multiline-draft'] as const) {
      expect(plan(START, name).step).toEqual({ kind: 'refused', reason: 'draft' })
    }
  })

  it('[ADR-012] no subagent in the list, a view or a list the person left open, or an unknown screen: refused before any key', () => {
    expect(plan(START, 'lead-no-agents').step).toEqual({ kind: 'refused', reason: 'not-found' })
    for (const name of ['view-echo-list', 'lead-list-main', 'unrecognised'] as const) {
      expect(plan(START, name).step).toEqual({ kind: 'refused', reason: 'unrecognised-screen' })
    }
  })
})

describe('planAgentSend: seeking the row whose view verifies', () => {
  it('[ADR-012] a row still labelled with the description is the first guess: ↓ or ↑ to it, then Enter', () => {
    expect(plan(seeking(), 'lead-list-main', FOXTROT).step).toEqual({ kind: 'press', key: 'down' })
    expect(plan(seeking(), 'lead-list-echo', FOXTROT).step).toEqual({ kind: 'press', key: 'down' })
    expect(plan(seeking(), 'lead-list-echo', DELTA).step).toEqual({ kind: 'press', key: 'up' })
    expect(plan(seeking(), 'view-delta-list', DELTA)).toEqual({
      state: { ...seeking([1]), phase: 'opened' },
      step: { kind: 'press', key: 'enter' }
    })
  })

  it('[ADR-012] no row carries the description any more (an activity summary): each row is opened in turn', () => {
    expect(plan(seeking(), 'lead-list-main').step).toEqual({ kind: 'press', key: 'down' })
    expect(plan(seeking(), 'view-delta-list')).toEqual({
      state: { ...seeking([1]), phase: 'opened' },
      step: { kind: 'press', key: 'enter' }
    })
  })

  it("[ADR-012] a view that is another subagent's: on to the next row, never typing there", () => {
    const opened: AgentPlanState = { ...seeking([1]), phase: 'opened' }
    expect(plan(opened, 'view-delta-list')).toEqual({
      state: seeking([1]),
      step: { kind: 'press', key: 'down' }
    })
  })

  it('[ADR-012] every row opened and none verified: back to main, refused', () => {
    const opened: AgentPlanState = { ...seeking([1, 2]), phase: 'opened' }
    expect(plan({ ...opened, opened: [1, 2, 3] }, 'view-delta-list')).toEqual({
      state: { ...returning('not-found'), opened: [1, 2, 3] },
      step: { kind: 'press', key: 'up' }
    })
  })

  it('[ADR-012] a draft that shows in the list (typed meanwhile): back to main, refused', () => {
    const lines = agentConsoleScreen('lead-list-echo').map((line) => (line === '❯' ? '❯ hi' : line))
    expect(planAgentSend(seeking(), readAgentConsole(lines), ECHO)).toEqual({
      state: returning('draft'),
      step: { kind: 'press', key: 'up' }
    })
  })
})

describe('planAgentSend: the verified view', () => {
  it("[ADR-012] the view's label is the description and its input is empty: type the message", () => {
    expect(plan({ ...seeking([2]), phase: 'opened' }, 'view-echo-list')).toEqual({
      state: { phase: 'returning', opened: [2], refusal: null, sent: true },
      step: { kind: 'type' }
    })
  })

  it("[ADR-012] the verified view shows the person's draft (the input is shared, spike §5): refused, nothing typed", () => {
    expect(plan({ ...seeking([2]), phase: 'opened' }, 'view-echo-draft')).toEqual({
      state: { ...returning('draft'), opened: [2] },
      step: { kind: 'press', key: 'up' }
    })
  })
})

describe('planAgentSend: back to the lead view (spike §4), never Esc, never ↑ from the input', () => {
  it('[ADR-012] from the input of a view: ↓ to main, Enter, then ↑ hands the lead its input back', () => {
    expect(plan(returning(null), 'view-echo-input-empty').step).toEqual({
      kind: 'press',
      key: 'down'
    })
    expect(plan(returning(null), 'view-echo-list-main').step).toEqual({
      kind: 'press',
      key: 'enter'
    })
    expect(plan(returning(null), 'lead-list-main').step).toEqual({ kind: 'press', key: 'up' })
  })

  it('[ADR-012] the lead view with its input focused ends the route: delivered, or the refusal', () => {
    expect(plan(returning(null), 'lead-input-empty').step).toEqual({ kind: 'done' })
    expect(plan(returning('not-found'), 'lead-input-empty').step).toEqual({
      kind: 'refused',
      reason: 'not-found'
    })
  })

  it('[ADR-012] a view whose input holds text cannot be left without ↑ (history) or Esc (stops the subagent): stop pressing', () => {
    expect(plan(returning(null), 'view-echo-draft').step).toEqual({ kind: 'press', key: 'up' })
    const typedInto = agentConsoleScreen('view-echo-input-empty').map((line) =>
      line === '❯ Message @general-purpose' ? '❯ hi' : line
    )
    expect(planAgentSend(returning(null), readAgentConsole(typedInto), ECHO).step).toEqual({
      kind: 'stranded'
    })
  })

  it('[ADR-012] a screen that does not read mid-way stops the route: no key is pressed blind', () => {
    for (const state of [
      seeking(),
      { ...seeking([1]), phase: 'opened' as const },
      returning(null)
    ]) {
      expect(planAgentSend(state, null, ECHO).step).toEqual({ kind: 'stranded' })
    }
  })

  it('[ADR-012] over every screen and phase, ↑ is pressed only while the list has the focus', () => {
    const names: AgentConsoleScreenName[] = [
      'lead-input-empty',
      'lead-input-draft',
      'lead-list-main',
      'lead-list-echo',
      'view-echo-list',
      'view-delta-list',
      'view-echo-draft',
      'view-echo-input-empty',
      'view-echo-list-main'
    ]
    const states: AgentPlanState[] = [
      START,
      seeking(),
      seeking([1, 2, 3]),
      { ...seeking([1]), phase: 'opened' },
      returning(null),
      returning('draft')
    ]
    for (const name of names) {
      const screen = readAgentConsole(agentConsoleScreen(name))
      for (const state of states) {
        for (const description of [ECHO, DELTA, 'Something else']) {
          const { step } = planAgentSend(state, screen, description)
          if (step.kind === 'press' && step.key === 'up') expect(screen?.selected).not.toBeNull()
        }
      }
    }
  })
})
