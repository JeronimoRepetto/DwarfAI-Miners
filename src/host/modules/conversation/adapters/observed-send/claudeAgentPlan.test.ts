// layer: L1
// L1 (17 §1.1): the planner of the observed-subagent route (AMENDMENT-29; spike §2 keys, §4 return,
// §5 robustness): given what the lead terminal shows now, the one key, the typing, or the refusal that
// comes next. Screens: fixtures/claude/observer/2.1.310 (real captures of 2026-10-24, scrubbed); a
// draft the run never showed is put into a real screen's input line (`withInput`).
import { describe, expect, it } from 'vitest'
import { readAgentConsole } from './claudeAgentConsole'
import { planAgentSend, START, type AgentPlanState, type AgentPlanStep } from './claudeAgentPlan'
import {
  agentConsoleScreen,
  withInput,
  type AgentConsoleScreenName
} from './testing/agentConsoleScreens'

const GOLF = 'Run ping four times (golf)'
const HOTEL = 'Run ping four times (hotel)'
/** The full description of the third agent: its rule label and its row are both cut short. */
const LONG =
  'Run ping four times then report back, this description is deliberately very long to see how the terminal label shows it in full or cut short (india)'

function planOn(
  state: AgentPlanState,
  lines: readonly string[],
  description = GOLF
): { state: AgentPlanState; step: AgentPlanStep } {
  return planAgentSend(state, readAgentConsole(lines), description)
}

const plan = (state: AgentPlanState, name: AgentConsoleScreenName, description = GOLF) =>
  planOn(state, agentConsoleScreen(name), description)

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
    const lead = agentConsoleScreen('lead-input-empty')
    for (const typed of [['DRAFT-LEAD-TEXT'], ['first line', 'second line']]) {
      expect(planOn(START, withInput(lead, typed)).step).toEqual({
        kind: 'refused',
        reason: 'draft'
      })
    }
  })

  it('[ADR-012] no subagent in the list, a view or a list the person left open, or an unknown screen: refused before any key', () => {
    const noAgents = withInput(agentConsoleScreen('lead-fresh-placeholder'), [''])
    expect(planOn(START, noAgents).step).toEqual({ kind: 'refused', reason: 'not-found' })
    for (const name of ['view-golf-list', 'lead-list-main', 'unrecognised'] as const) {
      expect(plan(START, name).step).toEqual({ kind: 'refused', reason: 'unrecognised-screen' })
    }
  })
})

describe('planAgentSend: seeking the row whose view verifies', () => {
  it('[ADR-012] a row still labelled with the description is the first guess: ↓ or ↑ to it, then Enter', () => {
    expect(plan(seeking(), 'lead-list-main', HOTEL).step).toEqual({ kind: 'press', key: 'down' })
    expect(plan(seeking(), 'lead-list-golf', HOTEL).step).toEqual({ kind: 'press', key: 'down' })
    expect(plan(seeking(), 'view-long-list', GOLF).step).toEqual({ kind: 'press', key: 'up' })
    expect(plan(seeking(), 'view-golf-list', GOLF)).toEqual({
      state: { ...seeking([1]), phase: 'opened' },
      step: { kind: 'press', key: 'enter' }
    })
  })

  it('[ADR-012] no row carries the description (cut short, or an activity summary): each row is opened in turn', () => {
    expect(plan(seeking(), 'lead-list-main', LONG).step).toEqual({ kind: 'press', key: 'down' })
    expect(plan(seeking(), 'lead-list-golf', LONG)).toEqual({
      state: { ...seeking([1]), phase: 'opened' },
      step: { kind: 'press', key: 'enter' }
    })
  })

  it("[ADR-012] a view that is another subagent's: on to the next row, never typing there", () => {
    const opened: AgentPlanState = { ...seeking([1]), phase: 'opened' }
    expect(plan(opened, 'view-golf-list', LONG)).toEqual({
      state: seeking([1]),
      step: { kind: 'press', key: 'down' }
    })
  })

  it('[ADR-012] a description cut short in the rule label never verifies: every row tried, back to main, refused', () => {
    const opened: AgentPlanState = { ...seeking([1, 2, 3]), phase: 'opened' }
    expect(plan(opened, 'view-long-list', LONG)).toEqual({
      state: { ...returning('not-found'), opened: [1, 2, 3] },
      step: { kind: 'press', key: 'up' }
    })
  })

  it('[ADR-012] a draft that shows in the list (typed meanwhile): back to main, refused', () => {
    const lines = withInput(agentConsoleScreen('lead-list-golf'), ['hi'])
    expect(planOn(seeking(), lines)).toEqual({
      state: returning('draft'),
      step: { kind: 'press', key: 'up' }
    })
  })
})

describe('planAgentSend: the verified view', () => {
  it("[ADR-012] the view's label is the description and its input is empty: type the message", () => {
    expect(plan({ ...seeking([1]), phase: 'opened' }, 'view-golf-list')).toEqual({
      state: { phase: 'returning', opened: [1], refusal: null, sent: true },
      step: { kind: 'type' }
    })
  })

  it("[ADR-012] the verified view shows the person's draft (the input is shared, spike §5): refused, nothing typed", () => {
    const lines = withInput(agentConsoleScreen('view-golf-list'), ['DRAFT2-LEAD'])
    expect(planOn({ ...seeking([1]), phase: 'opened' }, lines)).toEqual({
      state: { ...returning('draft'), opened: [1] },
      step: { kind: 'press', key: 'up' }
    })
  })
})

describe('planAgentSend: back to the lead view (spike §4), never Esc, never ↑ from the input', () => {
  it('[ADR-012] from the input of a view: ↓ to main, Enter, then ↑ hands the lead its input back', () => {
    expect(plan(returning(null), 'view-golf-input-empty').step).toEqual({
      kind: 'press',
      key: 'down'
    })
    expect(plan(returning(null), 'view-long-list-main').step).toEqual({
      kind: 'press',
      key: 'enter'
    })
    expect(plan(returning(null), 'lead-back-list-main').step).toEqual({ kind: 'press', key: 'up' })
  })

  it('[ADR-012] the lead view with its input focused ends the route: delivered, or the refusal', () => {
    expect(plan(returning(null), 'lead-input-empty').step).toEqual({ kind: 'done' })
    expect(plan(returning('not-found'), 'lead-input-empty').step).toEqual({
      kind: 'refused',
      reason: 'not-found'
    })
  })

  it('[ADR-012] a view whose input holds text cannot be left without ↑ (history) or Esc (stops the subagent): stop pressing', () => {
    const listed = withInput(agentConsoleScreen('view-golf-list'), ['DRAFT'])
    expect(planOn(returning(null), listed).step).toEqual({ kind: 'press', key: 'up' })
    expect(plan(returning(null), 'view-golf-draft').step).toEqual({ kind: 'stranded' })
  })

  it('[ADR-012] a screen that does not read mid-way stops the route: no key is pressed blind', () => {
    for (const state of [
      seeking(),
      { ...seeking([1]), phase: 'opened' as const },
      returning(null)
    ]) {
      expect(planAgentSend(state, null, GOLF).step).toEqual({ kind: 'stranded' })
    }
  })

  it('[ADR-012] over every screen and phase, ↑ is pressed only while the list has the focus', () => {
    const names: AgentConsoleScreenName[] = [
      'lead-input-empty',
      'lead-fresh-draft',
      'lead-list-main',
      'lead-list-golf',
      'view-golf-list',
      'view-long-list',
      'view-long-list-main',
      'lead-back-list-main',
      'view-golf-draft',
      'view-golf-input-empty'
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
        for (const description of [GOLF, HOTEL, LONG, 'Something else']) {
          const { step } = planAgentSend(state, screen, description)
          if (step.kind === 'press' && step.key === 'up') expect(screen?.selected).not.toBeNull()
        }
      }
    }
  })
})
