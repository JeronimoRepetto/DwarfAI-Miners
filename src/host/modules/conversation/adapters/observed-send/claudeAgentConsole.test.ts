// layer: L1
// L1 (17 §1.1): the pure reader of a Claude Code lead terminal's screen (AMENDMENT-29), over the
// Claude Code 2.1.310 screens of fixtures/claude/observer/2.1.310 (real `CONOUT$` captures of the
// validation run of 2026-10-24, scrubbed). Every screen it cannot read positively is null: the route
// refuses.
import { describe, expect, it } from 'vitest'
import { readAgentConsole } from './claudeAgentConsole'
import { agentConsoleScreen as screen, withInput } from './testing/agentConsoleScreens'

const GOLF = 'Run ping four times (golf)'
const HOTEL = 'Run ping four times (hotel)'
// A row cut short ends where its elapsed-time column begins, so the cut moves as that column widens.
const rowsWith = (long: string) => [
  { label: 'main' },
  { label: GOLF },
  { label: HOTEL },
  {
    label: `Run ping four times then report back, this description is deliberately very long to see ${long}`
  }
]

describe('readAgentConsole: what the lead terminal shows (Claude Code 2.1.310)', () => {
  it('[ADR-012] the lead view with an empty input: no view label, the agent list with main first, no pointer', () => {
    expect(readAgentConsole(screen('lead-input-empty'))).toEqual({
      viewLabel: null,
      inputEmpty: true,
      rows: rowsWith('how…'),
      selected: null
    })
  })

  it("[ADR-012] a person's draft in the lead input is not empty, on one line or on several, wherever its cursor is", () => {
    const lead = screen('lead-input-empty')
    expect(readAgentConsole(withInput(lead, ['DRAFT-LEAD-TEXT']))?.inputEmpty).toBe(false)
    expect(readAgentConsole(withInput(lead, ['first line', 'second line']))?.inputEmpty).toBe(false)
    // Measured: `abc` with the cursor moved back to its start.
    expect(readAgentConsole(screen('lead-fresh-draft'))?.inputEmpty).toBe(false)
  })

  it('[ADR-012] the suggestion a new session shows is no empty input: a session with no message has no agent', () => {
    expect(readAgentConsole(screen('lead-fresh-placeholder'))).toEqual({
      viewLabel: null,
      inputEmpty: false,
      rows: [],
      selected: null
    })
  })

  it('[ADR-012] the list pointer names the selected row, main included, in the lead view and in a view', () => {
    expect(readAgentConsole(screen('lead-list-main'))?.selected).toBe(0)
    expect(readAgentConsole(screen('lead-list-golf'))?.selected).toBe(1)
    expect(readAgentConsole(screen('lead-back-list-main'))).toMatchObject({
      viewLabel: null,
      selected: 0
    })
    expect(readAgentConsole(screen('view-long-list-main'))?.selected).toBe(0)
  })

  it("[ADR-012] a subagent view: the rule label is that subagent's description, the placeholder alone is an empty input", () => {
    expect(readAgentConsole(screen('view-golf-list'))).toEqual({
      viewLabel: GOLF,
      inputEmpty: true,
      rows: rowsWith('how t…'),
      selected: 1
    })
    expect(readAgentConsole(screen('view-golf-input-empty'))).toMatchObject({
      viewLabel: GOLF,
      inputEmpty: true,
      selected: null
    })
    expect(readAgentConsole(screen('view-golf-draft'))).toMatchObject({
      viewLabel: GOLF,
      inputEmpty: false,
      selected: null
    })
  })

  it('[ADR-012] a long description is cut short in the rule label: the label is the shown part, never the description', () => {
    const shown = readAgentConsole(screen('view-long-list'))
    expect(shown?.viewLabel).toBe(
      'Run ping four times then report back, this description is deliberately very long to see how the terminal label shows it in full or cut…'
    )
    expect(shown?.selected).toBe(3)
  })

  it('[ADR-012] the placeholder words typed into the lead view are a draft, not an empty input', () => {
    const typed = withInput(screen('lead-input-empty'), ['Message @general-purpose…'])
    expect(readAgentConsole(typed)?.inputEmpty).toBe(false)
  })

  it('[ADR-012] blank rows under the window content change nothing', () => {
    const lines = [...screen('view-golf-list'), '', '', '']
    expect(readAgentConsole(lines)).toEqual(readAgentConsole(screen('view-golf-list')))
  })

  it('[ADR-012] a screen that is not the measured layout is not read at all', () => {
    expect(readAgentConsole(screen('unrecognised'))).toBeNull()
    expect(readAgentConsole([])).toBeNull()
    // The input box without its bottom rule, or a pointer on two rows, is no layout it knows.
    const lead = screen('lead-list-golf')
    const bottom = lead.findIndex((row, index) => index > 1 && /^─+$/.test(row))
    expect(readAgentConsole(lead.filter((_, index) => index !== bottom))).toBeNull()
    expect(
      readAgentConsole(
        lead.map((row) =>
          row.replace(/^ {2}(◯ general-purpose {2}Run ping four times \(hotel\))/, '❯ $1')
        )
      )
    ).toBeNull()
  })
})
